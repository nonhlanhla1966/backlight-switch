/* Backlight Switch native bridge - the single, isolated file through which
 * the UI talks to Android. No other JS file may touch window.Android; tests
 * enforce that. Every call falls back to a local mock when the bridge is
 * absent (demo/browser mode). Pure wrapper - no business logic here.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BacklightBridge = factory();
})(this, function () {
  'use strict';

  var native = function () { return (typeof window !== 'undefined' && window.Android) || null; };

  function respond(fn, fallback) {
    var n = native();
    if (!n || typeof n[fn] !== 'function') return fallback;
    try {
      var v = n[fn].apply(n, Array.prototype.slice.call(arguments, 2));
      return v === undefined || v === null ? fallback : v;
    } catch (e) { return fallback; }
  }

  function jsonString(v) { return JSON.stringify(v); }

  function tryParse(v) {
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch (e) { return null; }
  }

  var Bridge = {
    available: false,

    init: function () { Bridge.available = !!native(); return Bridge.available; },

    status: function (fallback) {
      var raw = respond('status', '{}');
      return tryParse(raw) || fallback || {};
    },

    version: function () {
      var raw = respond('version', '{}');
      return tryParse(raw) || {};
    },

    getRules: function () { return respond('getRules', '{}'); },
    saveRules: function (json) { return respond('saveRules', true, json); },

    getWeekly: function () { return respond('getWeekly', '{}'); },
    saveWeekly: function (json) { return respond('saveWeekly', true, json); },

    getSensorRules: function () { return respond('getSensorRules', '{}'); },
    saveSensorRules: function (json) { return respond('saveSensorRules', true, json); },

    getSensor: function () {
      var raw = respond('getSensor', 'null');
      return tryParse(raw) || { value: null, err: 'no bridge' };
    },

    preset: function (pct) { return respond('preset', false, Number(pct)); },

    getApps: function () { return respond('getApps', '[]'); },
    setGlobal: function (pct) { return respond('setGlobal', false, Number(pct)); },

    setAuto: function (on) { return respond('setAuto', false, !!on); },
    getAuto: function () {
      var st = Bridge.status();
      return !!st.auto;
    },

    canWrite: function () { return respond('canWriteSettings', false); },
    hasUsageAccess: function () { return respond('hasUsageAccess', false); },
    openWriteSettings: function () { return respond('openWriteSettings', undefined); },
    openUsageAccess: function () { return respond('openUsageAccess', undefined); },

    /* Demo-mode sensor: simulated temperature so the sensor feature is
     * exercisable without a thermal zone. UI labels it clearly as preview. */
    demoSensor: function (temp) {
      return { value: Number(temp), unit: '°C', source: 'demo', demo: true };
    },

    exposeMock: function (m) {
      if (typeof window !== 'undefined') window.Android = m;
      Bridge.available = !!m;
      return Bridge;
    },

    serialize: jsonString,
  };

  Bridge.available = !!native();
  return Bridge;
});