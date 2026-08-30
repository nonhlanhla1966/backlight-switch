package com.nonhlanhla1966.backlightswitch;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Calendar;

/**
 * Weekly schedule model - mirrors www/js/core.js exactly (same constants,
 * same local-time math) so the service and the web core agree on windows,
 * preview timing and next triggers.
 *
 * Schedule JSON: { active, hour, minute, days[0..6], pct, durationMin,
 * previewMin }. day 0 = Sunday (java.util.Calendar DAY_OF_WEEK - 1).
 */
final class Weekly {

    static final int PREVIEW_MIN = 1;
    static final int PREVIEW_MS = PREVIEW_MIN * 60_000;

    boolean active;
    int hour = 21;
    int minute = 0;
    int pct = 30;
    int durationMin = 60;
    int previewMin = PREVIEW_MIN;
    int[] days = {0, 1, 2, 3, 4, 5, 6};

    static Weekly parse(JSONObject raw) {
        Weekly w = new Weekly();
        if (raw == null) return w;
        w.active = raw.optBoolean("active", false);
        w.hour = clamp(raw.optInt("hour", 21), 0, 23);
        w.minute = clamp(raw.optInt("minute", 0), 0, 59);
        w.pct = clamp(raw.optInt("pct", 30), 5, 100);
        w.durationMin = clamp(raw.optInt("durationMin", 60), 10, 360);
        w.previewMin = clamp(raw.optInt("previewMin", PREVIEW_MIN), 1, 30);
        JSONArray arr = raw.optJSONArray("days");
        if (arr != null && arr.length() > 0) {
            int[] out = new int[arr.length()];
            int n = 0;
            java.util.Set<Integer> seen = new java.util.HashSet<>();
            for (int i = 0; i < arr.length(); i++) {
                int d = clamp(arr.optInt(i, 0), 0, 6);
                if (seen.add(d)) out[n++] = d;
            }
            if (n > 0) {
                int[] trimmed = new int[n];
                System.arraycopy(out, 0, trimmed, 0, n);
                java.util.Arrays.sort(trimmed);
                w.days = trimmed;
            }
        }
        return w;
    }

    static Weekly parse(String json) {
        if (json == null) return new Weekly();
        try { return parse(new JSONObject(json)); }
        catch (Exception e) { return new Weekly(); }
    }

    private static int clamp(int v, int lo, int hi) {
        return v < lo ? lo : (v > hi ? hi : v);
    }

    private static boolean hasDay(Weekly w, int day) {
        for (int d : w.days) if (d == day) return true;
        return false;
    }

    /** Local calendar fields of the instant. */
    static Calendar cal(long ms) {
        Calendar c = Calendar.getInstance();
        c.setTimeInMillis(ms);
        return c;
    }

    static int dayOfWeek(long ms) {
        return cal(ms).get(Calendar.DAY_OF_WEEK) - 1; // Sunday = 0
    }

    static int secondOfDay(long ms) {
        Calendar c = cal(ms);
        return c.get(Calendar.HOUR_OF_DAY) * 3600
                + c.get(Calendar.MINUTE) * 60
                + c.get(Calendar.SECOND);
    }

    static long startOfDay(long ms) {
        Calendar c = cal(ms);
        c.set(Calendar.HOUR_OF_DAY, 0);
        c.set(Calendar.MINUTE, 0);
        c.set(Calendar.SECOND, 0);
        c.set(Calendar.MILLISECOND, 0);
        return c.getTimeInMillis();
    }

    private static int startSec(Weekly w) { return w.hour * 3600 + w.minute * 60; }
    private static int durSec(Weekly w) { return w.durationMin * 60; }

    /** True if the preset window (start..start+duration) contains ms. */
    static boolean isInWindow(Weekly w, long ms) {
        int pDay = dayOfWeek(ms);
        int sod = secondOfDay(ms);
        int st = startSec(w);
        int du = durSec(w);
        if (st + du <= 86400) {
            return hasDay(w, pDay) && sod >= st && sod < st + du;
        }
        int tail = st + du - 86400;
        boolean schedToday = hasDay(w, pDay);
        boolean schedPrev = hasDay(w, (pDay + 6) % 7);
        return (schedToday && sod >= st) || (schedPrev && sod < tail);
    }

    /** Start (epoch ms) of the window active at ms, or -1. */
    static long currentWindowStart(Weekly w, long ms) {
        if (!w.active || !isInWindow(w, ms)) return -1;
        int pDay = dayOfWeek(ms);
        int sod = secondOfDay(ms);
        int st = startSec(w);
        boolean sameDay = sod >= st;
        int day = sameDay ? pDay : (pDay + 6) % 7;
        long base = startOfDay(ms) + (sameDay ? 0 : -86_400_000L);
        return base + st * 1000L;
    }

    /** Next window start strictly after afterMs, or -1. */
    static long nextTrigger(Weekly w, long afterMs) {
        if (!w.active) return -1;
        long base = startOfDay(afterMs);
        int pDay = dayOfWeek(afterMs);
        long best = -1;
        for (int dd = 0; dd < 8; dd++) {
            int day = (pDay + dd) % 7;
            if (!hasDay(w, day)) continue;
            long start = base + dd * 86_400_000L + startSec(w) * 1000L;
            if (start > afterMs && (best == -1 || start < best)) best = start;
        }
        return best;
    }

    /** ms remaining until the window ends (0 if active then end sec computed). */
    static long remainingMs(Weekly w, long ms) {
        if (!w.active || !isInWindow(w, ms)) return 0;
        int sod = secondOfDay(ms);
        int st = startSec(w);
        int du = durSec(w);
        int endSec;
        if (st + du <= 86400) endSec = st + du;
        else endSec = (sod >= st) ? 86400 : (st + du - 86400);
        return Math.max(0, (endSec - sod) * 1000L);
    }

    /** Is ms inside the last previewMin before the next activation? */
    static boolean inPreview(Weekly w, long ms) {
        if (!w.active) return false;
        if (isInWindow(w, ms)) return false;
        long next = nextTrigger(w, ms);
        if (next == -1) return false;
        long until = next - ms;
        return until > 0 && until <= w.previewMin * 60_000L;
    }
}