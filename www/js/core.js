/* Backlight Switch core logic - pure, dependency-free (UMD).
 * v2.0.0 "Best of the Best": adds a weekly brightness schedule with a
 * last-minute preview ramp, a priority regime (per-app > sensor > weekly,
 * manual wins over ALL scheduled settings), temperature-based per-app sensor
 * dimming, and accurate weekly recurrence.
 *
 * The native service mirrors the transition + priority decisions so behavior
 * is verified in Node before it is shipped. Nothing in this file touches the
 * DOM, the network, or any device API - every clock and input is injectable.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BacklightCore = factory();
})(this, function () {
  'use strict';

  const MIN_PCT = 5;
  const MAX_PCT = 100;
  const WEEK_MS = 7 * 24 * 3600 * 1000;
  const DAY_MS = 24 * 3600 * 1000;
  const SENSOR_HYSTERESIS = 2.0; // °C above threshold triggers, <= threshold-2 clears

  /* length in MINUTES of the dim preview that precedes a scheduled activation */
  const PREVIEW_MIN = 1;

  /* ---------------- brightness ---------------- */

  function clampPct(v) {
    const n = Math.round(Number(v));
    if (!isFinite(n)) throw new Error('non-numeric brightness');
    return Math.min(MAX_PCT, Math.max(MIN_PCT, n));
  }

  function validPackage(pkg) {
    return typeof pkg === 'string' &&
      /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(pkg);
  }

  function normalizeRule(pkg, pct) {
    if (!validPackage(pkg)) throw new Error('invalid package name');
    return { pkg: pkg, pct: clampPct(pct) };
  }

  /* ---------------- rule store (unchanged contract) ---------------- */

  /* Rules are stored as { "<pkg>": {"pct": <int>} } */
  function parseRules(json) {
    let raw;
    try { raw = typeof json === 'string' ? JSON.parse(json) : json; }
    catch (e) { return {}; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    for (const k of Object.keys(raw)) {
      try {
        const r = normalizeRule(k, raw[k] && typeof raw[k] === 'object' ? raw[k].pct : raw[k]);
        out[k] = { pct: r.pct };
      } catch (e) { /* skip malformed entries */ }
    }
    return out;
  }

  function serializeRules(rules) {
    const clean = parseRules(rules);
    return JSON.stringify(clean);
  }

  function setRule(rules, pkg, pct) {
    const r = normalizeRule(pkg, pct);
    rules[r.pkg] = { pct: r.pct };
    return rules;
  }

  function removeRule(rules, pkg) {
    if (!validPackage(pkg)) throw new Error('invalid package name');
    delete rules[pkg];
    return rules;
  }

  function getRule(rules, pkg) {
    const r = rules && rules[pkg];
    return r ? { pct: r.pct } : null;
  }

  /* Brightness for an app: its override when present, else the global. */
  function resolveBrightness(rules, pkg, globalPct) {
    const rule = getRule(rules, pkg);
    return rule ? rule.pct : clampPct(globalPct);
  }

  /* ---------------- per-app enter/exit transitions (unchanged contract) ---------------- */

  /*
   * state: { overridden: bool, base: int|null } (base = brightness to restore)
   * Returns { action, value, state } where action is
   *   'apply' | 'restore' | 'none'
   */
  function decideTransition(prev, next, rules, state, currentPct) {
    const st = { overridden: !!(state && state.overridden), base: state ? state.base : null };
    if (!next || next === prev) return { action: 'none', value: null, state: st };

    const rule = getRule(rules, next);
    if (rule) {
      if (!st.overridden) {
        st.base = clampPct(currentPct);
        st.overridden = true;
      }
      return { action: 'apply', value: rule.pct, state: st };
    }
    if (st.overridden) {
      const value = st.base;
      st.overridden = false;
      st.base = null;
      return { action: 'restore', value: value, state: st };
    }
    return { action: 'none', value: null, state: st };
  }

  /* Screen-off handling: drop any override immediately. */
  function onScreenOff(state) {
    return { overridden: false, base: null, kind: null };
  }

  /* ---------------- installed-app hygien ---------------- */

  function sanitizeApps(list) {
    const seen = {};
    const out = [];
    for (const it of Array.isArray(list) ? list : []) {
      const pkg = it && (it.packageName || it.pkg);
      if (!validPackage(pkg) || seen[pkg]) continue;
      seen[pkg] = true;
      out.push({ packageName: pkg, label: String(it.label || pkg) });
    }
    out.sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()));
    return out;
  }

  /* ---------------- settings (auto + theme, unchanged contract) ---------------- */

  function parseSettings(json) {
    try {
      const s = JSON.parse(json);
      if (!s || typeof s !== 'object') return defaults();
      return {
        auto: !!s.auto,
        theme: s.theme === 'light' ? 'light' : 'dark'
      };
    } catch (e) { return defaults(); }
  }
  function serializeSettings(s) {
    const d = parseSettings(JSON.stringify(s || {}));
    return JSON.stringify(d);
  }
  function defaults() { return { auto: false, theme: 'dark' }; }

  /* ---------------- weekly schedule model ---------------- */

  const WEEKDAY_DEFAULTS = [0, 1, 2, 3, 4, 5, 6]; // Sun..Sat (Date.getDay())

  /* Canonical schedule shape:
   * { active, hour, minute, days[0..6], pct, durationMin, previewMin }
   */
  function defaultSchedule() {
    return {
      active: false,
      hour: 21,
      minute: 0,
      days: WEEKDAY_DEFAULTS.slice(),
      pct: 30,
      durationMin: 60,
      previewMin: PREVIEW_MIN,
    };
  }

  function clampInt(v, lo, hi) { return Math.min(hi, Math.max(lo, Math.round(Number(v) || 0))); }

  function parseWeekly(json) {
    let raw;
    try { raw = typeof json === 'string' ? JSON.parse(json) : json; }
    catch (e) { return defaultSchedule(); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaultSchedule();
    const s = defaultSchedule();
    s.active = !!raw.active;
    s.hour = clampInt(raw.hour !== undefined ? raw.hour : 21, 0, 23);
    s.minute = clampInt(raw.minute !== undefined ? raw.minute : 0, 0, 59);
    s.pct = clampInt(raw.pct !== undefined ? raw.pct : 30, MIN_PCT, MAX_PCT);
    s.durationMin = clampInt(raw.durationMin !== undefined ? raw.durationMin : 60, 10, 360);
    s.previewMin = clampInt(raw.previewMin !== undefined ? raw.previewMin : PREVIEW_MIN, 1, 30);
    const days = [];
    if (Array.isArray(raw.days)) {
      for (const d of raw.days) {
        const n = clampInt(d, 0, 6);
        if (days.indexOf(n) === -1) days.push(n);
      }
    }
    s.days = days.length ? days.sort((a, b) => a - b) : WEEKDAY_DEFAULTS.slice();
    return s;
  }

  function serializeWeekly(s) {
    return JSON.stringify(parseWeekly(s));
  }

  function localParts(ms) {
    const d = new Date(ms);
    return { day: d.getDay(), h: d.getHours(), m: d.getMinutes(), s: d.getSeconds() };
  }

  function secondOfDay(ms) {
    const p = localParts(ms);
    return p.h * 3600 + p.m * 60 + p.s;
  }

  function startSec(s) { return s.hour * 3600 + s.minute * 60; }
  function durSec(s) { return s.durationMin * 60; }
  function previewMs(s) { return s.previewMin * 60000; }

  function startOfDay(ms) {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }

  function isInWindow(s, ms) {
    const p = localParts(ms);
    const sod = secondOfDay(ms);
    const st = startSec(s);
    const du = durSec(s);
    if (st + du <= 86400) {
      // window fits inside one calendar day
      return s.days.indexOf(p.day) !== -1 && sod >= st && sod < st + du;
    }
    // window wraps past midnight: scheduled part today, tail early next day
    const tail = st + du - 86400;
    const schedToday = s.days.indexOf(p.day) !== -1;
    const schedPrev = s.days.indexOf((p.day + 6) % 7) !== -1;
    return (schedToday && sod >= st) || (schedPrev && sod < tail);
  }

  /* Is the weekly preset active right now? Returns {active, remainingMs}. */
  function weeklyActiveAt(s, ms) {
    const c = parseWeekly(s);
    if (!c.active) return { active: false, remainingMs: 0 };
    if (!isInWindow(c, ms)) return { active: false, remainingMs: 0 };
    const p = localParts(ms);
    const sod = secondOfDay(ms);
    const st = startSec(c);
    const du = durSec(c);
    let endSec;
    if (st + du <= 86400) endSec = st + du;
    else {
      // tail after midnight
      endSec = (sod >= st) ? 86400 : (st + du - 86400);
    }
    return { active: true, remainingMs: Math.max(0, (endSec - sod) * 1000) };
  }

  /* The exact start time (epoch ms) of the window currently active at ms, or null. */
  function currentWindowStart(s, ms) {
    const c = parseWeekly(s);
    if (!c.active || !isInWindow(c, ms)) return null;
    const p = localParts(ms);
    const sod = secondOfDay(ms);
    const st = startSec(c);
    const sameDay = sod >= st;
    const day = sameDay ? p.day : (p.day + 6) % 7;
    const base = startOfDay(ms) + (sameDay ? 0 : -DAY_MS);
    return base + st * 1000;
  }

  /* Next window start strictly after afterMs (epoch ms), or null. */
  function nextWeeklyTrigger(s, afterMs) {
    const c = parseWeekly(s);
    if (!c.active) return null;
    const base = startOfDay(afterMs);
    const p = localParts(afterMs);
    let best = null;
    const dayMs = 86400000;
    for (let dd = 0; dd < 8; dd += 1) {
      const day = (p.day + dd) % 7;
      if (c.days.indexOf(day) === -1) continue;
      const start = base + dd * dayMs + startSec(c) * 1000;
      if (start > afterMs && (best === null || start < best)) best = start;
    }
    return best;
  }

  /* All window starts in [fromMs, toMs) - used by recurrence tests. */
  function weeklyTriggersBetween(s, fromMs, toMs) {
    const c = parseWeekly(s);
    if (!c.active) return [];
    const out = [];
    let cursor = fromMs;
    for (let i = 0; i < 400; i += 1) {
      const next = nextWeeklyTrigger(c, cursor);
      if (next === null || next >= toMs) break;
      out.push(next);
      cursor = next;
    }
    return out;
  }

  /*
   * Preview: the last previewMin before a scheduled activation the app dims
   * gradually toward the target. Resolution (final brightness = target) is
   * automatic at the scheduled start.
   * Returns { previewing, msRemaining, targetPct, start } or previewing:false.
   */
  function inPreviewAt(s, ms) {
    const c = parseWeekly(s);
    if (!c.active) return { previewing: false };
    if (isInWindow(c, ms)) return { previewing: false }; // already resolved
    const next = nextWeeklyTrigger(c, ms);
    if (next === null) return { previewing: false };
    const until = next - ms;
    if (until > 0 && until <= previewMs(c)) {
      return { previewing: true, msRemaining: until, targetPct: c.pct, start: next };
    }
    return { previewing: false };
  }

  /*
   * Gradual preview ramp level (monotonic, never overshoots). At fraction
   * >= 1 the exact target (resolution) is returned.
   */
  function previewLevel(currentPct, targetPct, elapsedMs, windowMs) {
    const cur = clampPct(currentPct);
    const tgt = clampPct(targetPct);
    const total = Math.max(1, Number(windowMs) || 1);
    const frac = Math.min(1, Math.max(0, Number(elapsedMs) || 0) / total);
    if (frac >= 1) return tgt;
    if (cur === tgt) return cur;
    let step = Math.round(cur + (tgt - cur) * frac);
    if (tgt < cur) step = Math.max(tgt, step);
    else step = Math.min(tgt, step);
    return clampPct(step);
  }

  /*
   * Manual override safety: a manual slider change during a window blocks the
   * weekly preset for the REST of that window (it must never be dislodged).
   * The schedule re-arms at the next window (lastManualAt < its start).
   */
  function weeklyBlocked(s, lastManualAt, ms) {
    if (lastManualAt === null || lastManualAt === undefined) return false;
    const ws = currentWindowStart(s, ms);
    // only blocked while we are inside a window whose start the user saw
    return ws !== null && Number(lastManualAt) >= ws;
  }

  function weeklyCanApply(s, lastManualAt, ms) {
    const a = weeklyActiveAt(s, ms);
    if (!a.active) return false;
    if (weeklyBlocked(s, lastManualAt, ms)) return false;
    return true;
  }

  /* ---------------- sensor rules (per-app temperature dimming) ---------------- */

  function defaultSensorRules() { return {}; }

  function normalizeSensorRule(pkg, threshold, pct) {
    if (!validPackage(pkg)) throw new Error('invalid package name');
    const t = Number(threshold);
    if (!isFinite(t) || t < 1 || t > 150) throw new Error('invalid temperature threshold');
    return { pkg: pkg, threshold: Math.round(t * 10) / 10, pct: clampPct(pct) };
  }

  function parseSensorRules(json) {
    let raw;
    try { raw = typeof json === 'string' ? JSON.parse(json) : json; }
    catch (e) { return {}; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    for (const k of Object.keys(raw)) {
      const r = raw[k] || {};
      try {
        const n = normalizeSensorRule(k, r.threshold !== undefined ? r.threshold : r.t, r.pct);
        out[k] = { threshold: n.threshold, pct: n.pct };
      } catch (e) { /* skip malformed entries */ }
    }
    return out;
  }

  function serializeSensorRules(rules) {
    return JSON.stringify(parseSensorRules(rules));
  }

  function getSensorRule(rules, pkg) {
    const r = rules && rules[pkg];
    if (!r || r.threshold === undefined || r.threshold === null) return null;
    return { threshold: r.threshold, pct: r.pct };
  }

  function setSensorRule(rules, pkg, threshold, pct) {
    const n = normalizeSensorRule(pkg, threshold, pct);
    rules[n.pkg] = { threshold: n.threshold, pct: n.pct };
    return rules;
  }

  function removeSensorRule(rules, pkg) {
    if (!validPackage(pkg)) throw new Error('invalid package name');
    delete rules[pkg];
    return rules;
  }

  /*
   * Hysteresis decision for ONE sensor rule:
   *  - temp >= threshold            -> trigger
   *  - temp <= threshold - 2°C      -> clear
   *  - inside the 2°C band          -> keep the previous decision (no flicker)
   */
  function sensorDecision(sensorValue, rule, prevTriggered) {
    if (!rule || !rule.threshold) return { triggered: false };
    const t = Number(sensorValue);
    if (!isFinite(t)) return { triggered: !!prevTriggered };
    if (t >= rule.threshold) return { triggered: true };
    if (t <= rule.threshold - SENSOR_HYSTERESIS) return { triggered: false };
    return { triggered: !!prevTriggered };
  }

  /* Capability probe: does the bridge currently report a live thermal
   * reading? Pure against the bridge surface - bridge methods are already
   * safe wrappers, so probing causes no side effects. */
  function sensorSupported(bridge) {
    if (!bridge || typeof bridge.getSensor !== 'function') return false;
    const r = bridge.getSensor();
    return !!(r && r.value !== null && r.value !== undefined);
  }

  /* ---------------- priority regime ---------------- */

  /* ctx: { rules, sensorRules, sensorValue, sensorPrev, weekly, lastManualAt,
   *        nowMs, fgPkg, presetActive }
   * Returns the highest-priority override:
   *   { kind:'app'|'sensor'|'weekly'|'none', value:int|null }
   * per-app > sensor > weekly > manual/none. Manual overrides all scheduled
   * settings (weekly is blocked once the user intervenes).
   */
  function resolvePriority(ctx) {
    ctx = ctx || {};
    const rules = parseRules(ctx.rules);
    const fgPkg = ctx.fgPkg || null;
    const presetActive = !!ctx.presetActive;

    if (fgPkg) {
      const appRule = getRule(rules, fgPkg);
      if (appRule) return { kind: 'app', value: appRule.pct };

      const srs = parseSensorRules(ctx.sensorRules);
      const sRule = getSensorRule(srs, fgPkg);
      if (sRule) {
        const dec = sensorDecision(ctx.sensorValue, sRule, !!(ctx.sensorPrev && ctx.sensorPrev.triggered));
        if (dec.triggered) return { kind: 'sensor', value: sRule.pct };
      }
    }
    if (presetActive) return { kind: 'preset', value: clampPct(ctx.presetPct) };
    if (weeklyCanApply(ctx.weekly, ctx.lastManualAt, ctx.nowMs)) {
      return { kind: 'weekly', value: parseWeekly(ctx.weekly).pct };
    }
    return { kind: 'none', value: null };
  }

  /*
   * Stateful auto engine (mirrored by BrightnessWatcherService):
   *   ctx     - as resolvePriority + { currentBrightness }
   *   state   - { overridden:bool, base:int|null, kind:string|null }
   * Action:
   *   'set'      -> set system brightness to value (capture base once)
   *   'restore'  -> restore pre-override brightness
   *   'preview'  -> gradual ramp value (before a scheduled activation)
   *   'idle'     -> nothing to do
   */
  function decideAutoAction(ctx, state) {
    const st = {
      overridden: !!(state && state.overridden),
      base: state ? state.base : null,
      kind: state && state.kind ? state.kind : null,
    };
    const priority = resolvePriority(ctx);

    if (priority.kind === 'none') {
      if (st.overridden) {
        return {
          action: 'restore',
          value: st.base,
          state: { overridden: false, base: null, kind: null },
        };
      }
      // last-minute preview before a scheduled activation
      const pv = inPreviewAt(ctx.weekly, ctx.nowMs);
      if (pv.previewing && !st.overridden) {
        const elapsed = Math.max(0, previewMs(parseWeekly(ctx.weekly)) - pv.msRemaining);
        const baseVal = (st.base !== null && st.base !== undefined)
          ? st.base : (ctx.currentBrightness || 50);
        const value = previewLevel(baseVal,
          pv.targetPct, elapsed, previewMs(parseWeekly(ctx.weekly)));
        return { action: 'preview', value: value, state: st, previewing: true, remainingMs: pv.msRemaining };
      }
      return { action: 'idle', value: null, state: st };
    }

    const value = priority.value;
    if (!st.overridden) {
      const base = ctx.currentBrightness !== undefined && ctx.currentBrightness !== null
        ? clampPct(ctx.currentBrightness)
        : 50;
      return {
        action: 'set',
        value: value,
        state: { overridden: true, base: base, kind: priority.kind },
      };
    }
    return { action: 'set', value: value, state: st };
  }

  /* Mark a manual slider change: it suspends scheduled settings for this
   * window. Returns the new lastManualAt. */
  function applyManual(nowMs) {
    return Number(nowMs);
  }

  return {
    MIN_PCT: MIN_PCT,
    MAX_PCT: MAX_PCT,
    PREVIEW_MIN: PREVIEW_MIN,
    SENSOR_HYSTERESIS: SENSOR_HYSTERESIS,
    clampPct: clampPct,
    validPackage: validPackage,
    normalizeRule: normalizeRule,
    parseRules: parseRules,
    serializeRules: serializeRules,
    setRule: setRule,
    removeRule: removeRule,
    getRule: getRule,
    resolveBrightness: resolveBrightness,
    decideTransition: decideTransition,
    onScreenOff: onScreenOff,
    sanitizeApps: sanitizeApps,
    parseSettings: parseSettings,
    serializeSettings: serializeSettings,
    defaultSettings: defaults,

    defaultSchedule: defaultSchedule,
    parseWeekly: parseWeekly,
    serializeWeekly: serializeWeekly,
    localParts: localParts,
    secondOfDay: secondOfDay,
    startOfDay: startOfDay,
    isInWindow: isInWindow,
    weeklyActiveAt: weeklyActiveAt,
    currentWindowStart: currentWindowStart,
    nextWeeklyTrigger: nextWeeklyTrigger,
    weeklyTriggersBetween: weeklyTriggersBetween,
    inPreviewAt: inPreviewAt,
    previewLevel: previewLevel,
    weeklyBlocked: weeklyBlocked,
    weeklyCanApply: weeklyCanApply,

    defaultSensorRules: defaultSensorRules,
    normalizeSensorRule: normalizeSensorRule,
    parseSensorRules: parseSensorRules,
    serializeSensorRules: serializeSensorRules,
    getSensorRule: getSensorRule,
    setSensorRule: setSensorRule,
    removeSensorRule: removeSensorRule,
    sensorDecision: sensorDecision,
    sensorSupported: sensorSupported,

    resolvePriority: resolvePriority,
    decideAutoAction: decideAutoAction,
    applyManual: applyManual,
  };
});