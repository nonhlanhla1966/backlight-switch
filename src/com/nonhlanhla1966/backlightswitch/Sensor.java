package com.nonhlanhla1966.backlightswitch;

import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;

/**
 * Thermal sensor reads for the temperature-based dim feature. Prefers the
 * kernel thermal zone that most closely tracks the CPU/SoC (type contains
 * "cpu" or "soc"); falls back to "battery" thermal zones, then the Android
 * battery temperature. Returns a JSONObject { value: double degC | null,
 * source: String }.
 */
final class Sensor {

    private Sensor() {}

    static JSONObject read(Context ctx) {
        JSONObject out = new JSONObject();
        try {
            double best = Double.NaN;
            String bestType = null;
            File sys = new File("/sys/class/thermal");
            File[] zones = sys.listFiles();
            if (zones != null) {
                int priority = Integer.MAX_VALUE;
                for (File zone : zones) {
                    if (!zone.getName().startsWith("thermal_zone")) continue;
                    String type = readString(new File(zone, "type"));
                    if (type == null || type.isEmpty()) continue;
                    int prio = typePriority(type);
                    if (prio > priority) continue;
                    double c = readTempC(new File(zone, "temp"));
                    if (Double.isNaN(c)) continue;
                    if (prio < priority || !Double.isNaN(best)) {
                        // keep the best priority; for equal priority prefer hot
                        best = c;
                        bestType = type;
                        priority = prio;
                    }
                }
            }
            if (Double.isNaN(best)) {
                best = batteryTemp(ctx);
                bestType = "battery";
            }
            out.put("value", Double.isNaN(best) ? JSONObject.NULL : round1(best));
            out.put("source", bestType == null ? "unknown" : bestType);
        } catch (Exception e) {
            try { out.put("value", JSONObject.NULL); out.put("source", "error"); }
            catch (Exception ignored) {}
        }
        return out;
    }

    /** Lower = "better" thermal proxy. cpu/soc first, battery last. */
    private static int typePriority(String type) {
        String t = type.toLowerCase();
        if (t.contains("cpu") || t.contains("soc")) return 0;
        if (t.contains("battery") || t.contains("batch")) return 2;
        return 1;
    }

    private static double readTempC(File f) {
        String raw = readString(f);
        if (raw == null) return Double.NaN;
        try {
            long mv = Long.parseLong(raw.trim());
            return mv / 1000.0; // millidegrees C in most kernels
        } catch (Exception e) {
            return Double.NaN;
        }
    }

    private static double batteryTemp(Context ctx) {
        try {
            Intent b = ctx.registerReceiver(null,
                    new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (b == null) return Double.NaN;
            int t = b.getIntExtra("temperature", -1);
            if (t <= 0) return Double.NaN;
            return t / 10.0; // tenths of degC
        } catch (Exception e) {
            return Double.NaN;
        }
    }

    private static String readString(File f) {
        try {
            byte[] buf = new byte[(int) Math.min(8192, f.length())];
            FileInputStream in = new FileInputStream(f);
            try {
                int n = in.read(buf);
                return n <= 0 ? null : new String(buf, 0, n, "UTF-8").trim();
            } finally {
                in.close();
            }
        } catch (Exception e) {
            return null;
        }
    }

    private static double round1(double v) {
        return Math.round(v * 10.0) / 10.0;
    }
}