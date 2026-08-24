package com.nonhlanhla1966.backlightswitch;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.app.usage.UsageEvents;
import android.app.usage.UsageStatsManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import org.json.JSONObject;
/**
 * Foreground service that watches which app is in the foreground via
 * UsageStatsManager and applies per-app brightness rules:
 *  - entering an app with a rule: remember current brightness, apply rule
 *  - leaving to an app without a rule: restore the remembered brightness
 *
 * Polls only while the screen is on (800 ms cadence) - lightweight on CPU
 * and battery; no accessibility tricks, no thermal impact.
 */
public class BrightnessWatcherService extends Service {

    private static final String CHANNEL = "backlight-watcher";
    private static final long POLL_MS = 800;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private UsageStatsManager usage;
    private SharedPreferences prefs;
    private JSONObject rules = new JSONObject();
    private String lastFg = null;
    private int restoreBase = -1;   // brightness percent before first override
    private boolean screenOn = true;
    private boolean running = false;
    private long lastEventTs = 0;

    private final Runnable pollLoop = new Runnable() {
        @Override public void run() {
            poll();
            if (running && screenOn) handler.postDelayed(this, POLL_MS);
        }
    };

    private final BroadcastReceiver screenReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            String a = intent.getAction();
            if (Intent.ACTION_SCREEN_OFF.equals(a)) {
                screenOn = false;
                // Leaving no app in particular: drop any override cleanly.
                leaveOverride();
                handler.removeCallbacks(pollLoop);
            } else if (Intent.ACTION_SCREEN_ON.equals(a)) {
                screenOn = true;
                handler.removeCallbacks(pollLoop);
                handler.postDelayed(pollLoop, 150);
            }
        }
    };

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        usage = (UsageStatsManager) getSystemService(USAGE_STATS_SERVICE);
        prefs = MainActivity.prefs(this);
        running = true;
        registerReceiver(screenReceiver,
                new IntentFilter(Intent.ACTION_SCREEN_ON));
        registerReceiver(screenReceiver,
                new IntentFilter(Intent.ACTION_SCREEN_OFF));
        startForegroundInternal();
        reloadRules();
        handler.postDelayed(pollLoop, 200);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        reloadRules();
        if (!prefs.getBoolean(MainActivity.KEY_AUTO, false)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        handler.removeCallbacks(pollLoop);
        try { unregisterReceiver(screenReceiver); } catch (Exception ignored) {}
        leaveOverride();
        setRunningFlag(false);
        super.onDestroy();
    }

    /** Called by the UI after rules change so the next poll uses fresh data. */
    static void nudge(Context c) {
        try {
            c.startService(new Intent(c, BrightnessWatcherService.class));
        } catch (Exception ignored) {}
    }

    static boolean isRunning(Context c) {
        return c.getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE)
                .getBoolean("serviceRunning", false);
    }

    private void setRunningFlag(boolean v) {
        prefs.edit().putBoolean("serviceRunning", v).apply();
    }

    private void startForegroundInternal() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        NotificationChannel ch = new NotificationChannel(CHANNEL,
                "Auto brightness", NotificationManager.IMPORTANCE_LOW);
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
        Notification n = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle("Backlight Switch")
                .setContentText("Per-app auto brightness active")
                .setOngoing(true)
                .build();
        startForeground(1, n);
        setRunningFlag(true);
    }

    private void reloadRules() {
        try {
            rules = new JSONObject(prefs.getString(MainActivity.KEY_RULES, "{}"));
        } catch (Exception e) {
            rules = new JSONObject();
        }
    }

    private boolean hasRule(String pkg) {
        return pkg != null && rules.has(pkg);
    }

    private int ruleValue(String pkg) {
        try { return rules.getJSONObject(pkg).getInt("pct"); }
        catch (Exception e) { return -1; }
    }

    /** Restore the pre-override brightness (if we changed it). */
    private void leaveOverride() {
        if (restoreBase >= 0) {
            MainActivity.applyBrightnessPercent(BrightnessWatcherService.this, restoreBase);
            restoreBase = -1;
        }
        lastFg = null;
    }

    /**
     * Transition logic (mirrors www/js/core.js decideTransition):
     * enter ruled -> apply rule (capturing base once); leave to unruled ->
     * restore base.
     */
    private void onForegroundChanged(String prev, String next) {
        if (next == null || next.equals(prev)) return;
        if (hasRule(next)) {
            if (restoreBase < 0) {
                restoreBase = MainActivity.readBrightnessPercent(this);
            }
            MainActivity.applyBrightnessPercent(this, ruleValue(next));
        } else if (restoreBase >= 0) {
            MainActivity.applyBrightnessPercent(this, restoreBase);
            restoreBase = -1;
        }
    }

    /** Newest ACTIVITY_RESUMED event since our previous poll = foreground. */
    private void poll() {
        if (!MainActivity.hasUsageAccessStatic(this)) return;
        reloadRulesIfDirty();        long now = System.currentTimeMillis();
        long begin = Math.min(now - 4000, lastEventTs == 0 ? now - 4000 : lastEventTs + 1);
        UsageEvents events = usage.queryEvents(begin, now);
        UsageEvents.Event ev = new UsageEvents.Event();
        String fg = null;
        long newest = lastEventTs;
        while (events.hasNextEvent()) {
            events.getNextEvent(ev);
            if (ev.getEventType() == UsageEvents.Event.ACTIVITY_RESUMED
                    && ev.getTimeStamp() > newest) {
                newest = ev.getTimeStamp();
                fg = ev.getPackageName();
            }
        }
        lastEventTs = newest;
        if (fg != null) {
            String prev = lastFg;
            lastFg = fg;
            onForegroundChanged(prev, fg);
        }
    }

    private long lastRulesMtime = 0;

    private void reloadRulesIfDirty() {
        long m = prefs.getLong("rulesMtime", 0);
        if (m != lastRulesMtime) {
            lastRulesMtime = m;
            reloadRules();
        }
    }
}
