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
 * Foreground service keeping screen brightness in line with the rules.
 *
 * Decision model (mirrors www/js/core.js resolvePriority + decideAutoAction):
 *   per-app override  >  sensor dim (app+temp)  >  weekly preset  >  manual
 * A manual slider change blocks the weekly preset for the rest of its window;
 * app and sensor overrides always win because they are intentional.
 *
 * Additional pieces:
 *   - weekly presence: in the last PREVIEW_MIN before an activation the
 *     brightness ramps gradually toward the target (preview Level), then
 *     resolves exactly on the hour (verified by core tests).
 *   - sensor rules use a 2.0&deg;C hysteresis to stop flicker at the edge.
 *   - polls (800 ms) only while the screen is on; screen off mutes to the
 *     user brightness and stops polling. No wake-ups / no alarm spam.
 */
public class BrightnessWatcherService extends Service {

    static final String CHANNEL = "backlight-watcher";
    static final long POLL_MS = 800;
    static final String STATE_SNAPSHOT = "serviceState";
    static final double SENSOR_HYSTERESIS = 2.0;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private UsageStatsManager usage;
    private SharedPreferences prefs;
    private JSONObject rules = new JSONObject();
    private JSONObject sensorRules = new JSONObject();
    private Weekly weekly = new Weekly();

    private String lastFg = null;
    private int base = -1;         // brightness % to restore after an override
    private boolean screenOn = true;
    private boolean running = false;
    private long lastEventTs = 0;
    private final java.util.Map<String, Boolean> sensorTriggered =
            new java.util.HashMap<>();

    private final Runnable pollLoop = new Runnable() {
        @Override public void run() {
            try { poll(); } catch (Exception ignored) {}
            if (running && screenOn) handler.postDelayed(this, POLL_MS);
        }
    };

    private final BroadcastReceiver screenReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            String a = intent.getAction();
            if (Intent.ACTION_SCREEN_OFF.equals(a)) {
                screenOn = false;
                leaveOverride();
                handler.removeCallbacks(pollLoop);
                pushSnapshot();
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
        registerReceiver(screenReceiver, new IntentFilter(Intent.ACTION_SCREEN_ON));
        registerReceiver(screenReceiver, new IntentFilter(Intent.ACTION_SCREEN_OFF));
        startForegroundInternal();
        reloadData();
        handler.postDelayed(pollLoop, 200);
        pushSnapshot();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        reloadData();
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
        prefs.edit().remove(STATE_SNAPSHOT).apply();
        setRunningFlag(false);
        super.onDestroy();
    }

    static void nudge(Context c) {
        try { c.startService(new Intent(c, BrightnessWatcherService.class)); }
        catch (Exception ignored) {}
    }

    static boolean isRunning(Context c) {
        return c.getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE)
                .getBoolean("serviceRunning", false);
    }

    /** Live snapshot the UI reads for the status line + preview banner. */
    static JSONObject stateSnapshot(Context c) {
        try {
            String s = c.getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE)
                    .getString(STATE_SNAPSHOT, null);
            return s == null ? null : new JSONObject(s);
        } catch (Exception e) { return null; }
    }

    private void setRunningFlag(boolean v) {
        prefs.edit().putBoolean("serviceRunning", v).apply();
    }

    private void pushSnapshot() {
        try {
            JSONObject o = new JSONObject();
            o.put("screenOff", !screenOn);
            o.put("weeklyActive", weekly.active && Weekly.isInWindow(weekly, now()));
            o.put("sensorActive", currentSensorActive());
            o.put("currentRule", lastFg != null && rules.has(lastFg)
                    ? new JSONObject().put("name", lastFg)
                    : JSONObject.NULL);
            JSONObject s = Sensor.read(this);
            o.put("sensorVal", s.optDouble("value", Double.NaN));
            o.put("sensorSource", s.optString("source", ""));
            JSONObject p = previewInfo();
            o.put("previewing", p != null);
            o.put("previewPct", p == null ? 0 : p.optInt("pct", 30));
            prefs.edit().putString(STATE_SNAPSHOT, o.toString()).apply();
        } catch (Exception ignored) {}
    }

    private long now() { return System.currentTimeMillis(); }

    private void startForegroundInternal() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        NotificationChannel ch = new NotificationChannel(CHANNEL,
                "Auto brightness", NotificationManager.IMPORTANCE_LOW);
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
        Notification n = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle("Backlight Switch")
                .setContentText("Automatic brightness active")
                .setOngoing(true)
                .build();
        startForeground(1, n);
        setRunningFlag(true);
    }

    private void reloadData() {
        try { rules = new JSONObject(prefs.getString(MainActivity.KEY_RULES, "{}")); }
        catch (Exception e) { rules = new JSONObject(); }
        try { sensorRules = new JSONObject(prefs.getString(MainActivity.KEY_SENSOR, "{}")); }
        catch (Exception e) { sensorRules = new JSONObject(); }
        weekly = Weekly.parse(prefs.getString(MainActivity.KEY_WEEKLY, null));
    }

    /** Restore the pre-override brightness (if this service changed it). */
    private void leaveOverride() {
        if (base >= 0) {
            MainActivity.applyBrightnessPercent(this, base);
            base = -1;
        }
    }

    private int ruleValue(String pkg) {
        try { return rules.getJSONObject(pkg).getInt("pct"); }
        catch (Exception e) { return -1; }
    }

    /* ------------- sensor decision (hysteresis, mirrors core.js) ------------- */

    private boolean sensorTriggeredFor(String pkg, double temp) {
        if (pkg == null || !sensorRules.has(pkg)) return false;
        double threshold;
        try { threshold = sensorRules.getJSONObject(pkg).getDouble("threshold"); }
        catch (Exception e) { return false; }
        if (!Double.isFinite(temp)) {
            Boolean p = sensorTriggered.get(pkg);
            return p != null && p;
        }
        boolean t;
        if (temp >= threshold) t = true;
        else if (temp <= threshold - SENSOR_HYSTERESIS) t = false;
        else {
            Boolean p = sensorTriggered.get(pkg);
            t = p != null && p;
        }
        sensorTriggered.put(pkg, t);
        return t;
    }

    private int sensorRulePct(String pkg) {
        try { return sensorRules.getJSONObject(pkg).getInt("pct"); }
        catch (Exception e) { return -1; }
    }

    private boolean currentSensorActive() {
        JSONObject s = Sensor.read(this);
        double v = s.optDouble("value", Double.NaN);
        return lastFg != null && sensorRules.has(lastFg) && sensorTriggeredFor(lastFg, v);
    }

    /* ------------- weekly + preview (mirrors core.js) ------------- */

    private boolean manualBlocksWeekly() {
        long last = MainActivity.lastManualAt(this);
        if (last <= 0) return false;
        long ws = Weekly.currentWindowStart(weekly, now());
        return ws != -1 && last >= ws;
    }

    private JSONObject previewInfo() {
        long t = now();
        if (!weekly.active || !Weekly.inPreview(weekly, t)) return null;
        if (MainActivity.lastManualAt(this) > Weekly.nextTrigger(weekly, t)
                - weekly.previewMin * 60_000L) return null; // user touched
        try {
            return new JSONObject().put("pct", weekly.pct);
        } catch (Exception e) { return null; }
    }

    private int previewLevel(int currentPct, int targetPct, long elapsedMs, long windowMs) {
        long total = Math.max(1, windowMs);
        double frac = Math.min(1.0, Math.max(0.0, (double) elapsedMs / (double) total));
        if (frac >= 1.0) return targetPct;
        if (currentPct == targetPct) return currentPct;
        int step = (int) Math.round(currentPct + (targetPct - currentPct) * frac);
        step = targetPct < currentPct ? Math.max(targetPct, step) : Math.min(targetPct, step);
        return Math.min(100, Math.max(5, step));
    }

    /* ------------- the decision loop ------------- */

    private void poll() {
        if (!MainActivity.hasUsageAccessStatic(this)) return;
        reloadIfDirty();
        String fg = foregroundPackage();
        if (fg != null) lastFg = fg;

        int target = decideTarget();
        int current = MainActivity.readBrightnessPercent(this);

        if (target <= 0) {
            // nothing should apply -> restore base if we changed it
            if (base >= 0 && current != base) {
                MainActivity.applyBrightnessPercent(this, base);
            }
            base = -1;
            pushSnapshot();
            return;
        }

        // capture base only at the moment we start overriding the user level
        if (base < 0) base = current;
        if (Math.abs(current - target) >= 2) {
            MainActivity.applyBrightnessPercent(this, target);
        }
        pushSnapshot();
    }

    /** Resolve the target brightness % for now, or -1 for "leave manual". */
    private int decideTarget() {
        long t = now();
        double sensorTemp = Sensor.read(this).optDouble("value", Double.NaN);

        // 1. per-app override
        if (lastFg != null && rules.has(lastFg)) return ruleValue(lastFg);

        // 2. sensor rule for the foreground app
        if (lastFg != null && sensorRules.has(lastFg)
                && sensorTriggeredFor(lastFg, sensorTemp)) {
            return sensorRulePct(lastFg);
        }

        // 3. weekly preview ramp
        if (weekly.active && Weekly.inPreview(weekly, t) && !manualBlocksWeekly()) {
            long next = Weekly.nextTrigger(weekly, t);
            return previewLevel(MainActivity.readBrightnessPercent(this), weekly.pct,
                    Weekly.PREVIEW_MS - (next - t), Weekly.PREVIEW_MS);
        }

        // 4. weekly preset (blocked by a manual change inside the window)
        if (weekly.active && Weekly.isInWindow(weekly, t) && !manualBlocksWeekly()) {
            return weekly.pct;
        }

        return -1;
    }

    private String foregroundPackage() {
        try {
            long begin = Math.min(now() - 4000, lastEventTs == 0
                    ? now() - 4000 : lastEventTs + 1);
            UsageEvents events = usage.queryEvents(begin, now());
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
            return fg;
        } catch (Exception e) {
            return null;
        }
    }

    private long lastRulesMtime = 0;

    private void reloadIfDirty() {
        long m = prefs.getLong("rulesMtime", 0);
        if (m != lastRulesMtime) {
            lastRulesMtime = m;
            reloadData();
        }
    }
}