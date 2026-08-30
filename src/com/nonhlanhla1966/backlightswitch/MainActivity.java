package com.nonhlanhla1966.backlightswitch;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Host activity: renders the local HTML/CSS/JS app and exposes a minimal,
 * explicit JavascriptInterface bridge ("Android") for the operations the
 * web UI cannot do itself: brightness changes, special-permission consent
 * screens, app listing, rule storage (per-app + weekly + sensor) and status.
 */
public class MainActivity extends Activity {

    static final String PREFS = "backlight";
    static final String KEY_RULES = "rules";
    static final String KEY_AUTO = "auto";
    static final String KEY_WEEKLY = "weekly";
    static final String KEY_SENSOR = "sensorRules";
    static final String KEY_LAST_MANUAL = "lastManualAt";

    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        webView.setBackgroundColor(0xFF10131A);
        webView.setOverScrollMode(WebView.OVER_SCROLL_NEVER);
        webView.addJavascriptInterface(new Bridge(), "Android");
        setContentView(webView);
        webView.loadUrl("file:///android_asset/index.html");
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.evaluateJavascript("if(window.onNativeResume)window.onNativeResume()", null);
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Apply a brightness percentage (5..100) to the global setting. */
    static boolean applyBrightnessPercent(Context c, int pct) {
        if (!Settings.System.canWrite(c)) return false;
        int v = Math.round(pct * 255f / 100f);
        return Settings.System.putInt(c.getContentResolver(),
                Settings.System.SCREEN_BRIGHTNESS, v);
    }

    static int readBrightnessPercent(Context c) {
        try {
            int v = Settings.System.getInt(c.getContentResolver(),
                    Settings.System.SCREEN_BRIGHTNESS, 128);
            return Math.max(1, Math.min(100, Math.round(v * 100f / 255f)));
        } catch (Exception e) {
            return 50;
        }
    }

    static boolean hasUsageAccessStatic(Context c) {
        try {
            android.app.AppOpsManager ops = (android.app.AppOpsManager)
                    c.getSystemService(Context.APP_OPS_SERVICE);
            int mode = ops.checkOpNoThrow(android.app.AppOpsManager.OPSTR_GET_USAGE_STATS,
                    android.os.Process.myUid(), c.getPackageName());
            return mode == android.app.AppOpsManager.MODE_ALLOWED;
        } catch (Exception e) {
            return false;
        }
    }

    /** Remember that the user manually set brightness (blocks scheduled ones). */
    static void markManual(Context c) {
        prefs(c).edit().putLong(KEY_LAST_MANUAL, System.currentTimeMillis()).apply();
    }

    static long lastManualAt(Context c) {
        return prefs(c).getLong(KEY_LAST_MANUAL, 0L);
    }

    class Bridge {

        @JavascriptInterface
        public String status() {
            JSONObject o = new JSONObject();
            try {
                o.put("canWrite", Settings.System.canWrite(MainActivity.this));
                o.put("usageAccess", hasUsageAccess());
                o.put("auto", prefs(MainActivity.this).getBoolean(KEY_AUTO, false));
                o.put("global", readBrightnessPercent(MainActivity.this));
                o.put("lastManualAt", lastManualAt(MainActivity.this) == 0L
                        ? JSONObject.NULL : lastManualAt(MainActivity.this));
                o.put("serviceRunning",
                        BrightnessWatcherService.isRunning(MainActivity.this));
                JSONObject svc = BrightnessWatcherService.stateSnapshot(MainActivity.this);
                if (svc != null) {
                    o.put("previewing", svc.optBoolean("previewing", false));
                    o.put("previewPct", svc.optInt("previewPct", 30));
                    o.put("weeklyActive", svc.optBoolean("weeklyActive", false));
                    o.put("sensorActive", svc.optBoolean("sensorActive", false));
                    o.put("sensorVal", svc.has("sensorVal") ? svc.optDouble("sensorVal")
                            : JSONObject.NULL);
                    o.put("sensorSource", svc.optString("sensorSource", ""));
                    o.put("muted", svc.optBoolean("screenOff", false));
                    JSONObject cur = svc.optJSONObject("currentRule");
                    o.put("currentRule", cur == null ? JSONObject.NULL : cur);
                }
            } catch (Exception ignored) {
            }
            return o.toString();
        }

        @JavascriptInterface
        public String version() {
            JSONObject o = new JSONObject();
            try {
                android.content.pm.PackageInfo pi = getPackageManager()
                        .getPackageInfo(getPackageName(), 0);
                o.put("name", pi.versionName);
                o.put("code", pi.versionCode);
            } catch (Exception e) {
                try {
                    o.put("name", "2.0.0");
                    o.put("code", 2);
                } catch (Exception ignored) {}
            }
            return o.toString();
        }

        @JavascriptInterface
        public String getRules() {
            return prefs(MainActivity.this).getString(KEY_RULES, "{}");
        }

        @JavascriptInterface
        public boolean saveRules(String json) {
            try {
                new JSONObject(json); // must at least be valid JSON
                SharedPreferences p = prefs(MainActivity.this);
                p.edit().putString(KEY_RULES, json)
                        .putLong("rulesMtime", System.currentTimeMillis()).apply();
                BrightnessWatcherService.nudge(MainActivity.this);
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public String getWeekly() {
            return prefs(MainActivity.this).getString(KEY_WEEKLY, "{}");
        }

        @JavascriptInterface
        public boolean saveWeekly(String json) {
            try {
                Weekly.parse(json); // validates shape; malformed -> default
                prefs(MainActivity.this).edit().putString(KEY_WEEKLY, json).apply();
                BrightnessWatcherService.nudge(MainActivity.this);
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public String getSensorRules() {
            return prefs(MainActivity.this).getString(KEY_SENSOR, "{}");
        }

        @JavascriptInterface
        public boolean saveSensorRules(String json) {
            try {
                new JSONObject(json);
                prefs(MainActivity.this).edit().putString(KEY_SENSOR, json).apply();
                BrightnessWatcherService.nudge(MainActivity.this);
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public String getSensor() {
            return Sensor.read(MainActivity.this).toString();
        }

        /** Launchable apps as [{packageName,label}], deduplicated, sorted. */
        @JavascriptInterface
        public String getApps() {
            JSONArray arr = new JSONArray();
            Set<String> seen = new HashSet<>();
            Intent probe = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
            List<android.content.pm.ResolveInfo> ris =
                    getPackageManager().queryIntentActivities(probe, 0);
            List<JSONObject> items = new ArrayList<>();
            for (android.content.pm.ResolveInfo ri : ris) {
                String pkg = ri.activityInfo != null ? ri.activityInfo.packageName : null;
                if (pkg == null || !seen.add(pkg)) continue;
                String label;
                try {
                    label = String.valueOf(ri.loadLabel(getPackageManager()));
                } catch (Exception e) {
                    label = pkg;
                }
                try {
                    JSONObject o = new JSONObject();
                    o.put("packageName", pkg);
                    o.put("label", label);
                    items.add(o);
                } catch (Exception ignored) {
                }
            }
            Collections.sort(items, new java.util.Comparator<JSONObject>() {
                @Override public int compare(JSONObject a, JSONObject b) {
                    return String.valueOf(a.optString("label"))
                            .compareToIgnoreCase(String.valueOf(b.optString("label")));
                }
            });
            for (JSONObject o : items) arr.put(o);
            return arr.toString();
        }

        @JavascriptInterface
        public boolean setGlobal(int pct) {
            if (pct < 5 || pct > 100) return false;
            markManual(MainActivity.this);
            return applyBrightnessPercent(MainActivity.this, pct);
        }

        @JavascriptInterface
        public boolean preset(int pct) {
            if (pct < 5 || pct > 100) return false;
            return applyBrightnessPercent(MainActivity.this, pct);
        }

        @JavascriptInterface
        public boolean setAuto(boolean on) {
            prefs(MainActivity.this).edit().putBoolean(KEY_AUTO, on).apply();
            Intent i = new Intent(MainActivity.this, BrightnessWatcherService.class);
            if (on) startForegroundService(i);
            else stopService(i);
            return true;
        }

        @JavascriptInterface
        public boolean canWriteSettings() {
            return Settings.System.canWrite(MainActivity.this);
        }

        @JavascriptInterface
        public void openWriteSettings() {
            startActivity(new Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS,
                    Uri.parse("package:" + getPackageName())));
        }

        @JavascriptInterface
        public boolean hasUsageAccess() {
            return hasUsageAccessStatic(MainActivity.this);
        }

        @JavascriptInterface
        public void openUsageAccess() {
            try {
                startActivity(new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS));
            } catch (Exception e) {
                startActivity(new Intent(Settings.ACTION_SETTINGS));
            }
        }
    }
}