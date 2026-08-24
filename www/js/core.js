/* BacklightSwitch core logic - pure, dependency-free (UMD).
 * The Android service mirrors decideTransition(); tests exercise THIS
 * module so behavior is verified before shipping. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BacklightCore = factory();
})(this, function () {
  'use strict';

  const MIN_PCT = 5;
  const MAX_PCT = 100;

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

  /*
   * Transition state machine used when the foreground app changes.
   *   state: { overridden: bool, base: int|null }  (base = brightness to restore)
   *   prev/next: foreground package names (next may be null/unknown)
   * Returns { action, value, state } where action is one of
   *   'apply'   - set system brightness to value (entering a ruled app)
   *   'restore' - set system brightness back to value (left ruled app)
   *   'none'    - no change needed
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
    return { overridden: false, base: null };
  }

  /* Installed-app list hygiene: dedupe by pkg, drop invalid rows,
   * sort by label (case-insensitive). */
  function sanitizeApps(list) {
    const seen = {};
    const out = [];
    for (const it of Array.isArray(list) ? list : []) {
      if (!it || !validPackage(it.pkg) || seen[it.pkg]) continue;
      seen[it.pkg] = true;
      out.push({ pkg: it.pkg, label: String(it.label || it.pkg) });
    }
    out.sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()));
    return out;
  }

  /* Settings persisted between sessions (auto flag + theme). */
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

  return {
    MIN_PCT: MIN_PCT,
    MAX_PCT: MAX_PCT,
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
    defaultSettings: defaults
  };
});
