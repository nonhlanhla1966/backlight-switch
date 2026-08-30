#!/usr/bin/env node
/* Runtime WebView interaction wiring tests - the requested
 * button->handler->bridge->native->result->UI proof for Backlight Switch.
 * Runs the REAL www/index.html + core/bridge/app.js through the interaction
 * harness (tests/ui-harness.js) against a strict recording mock native.
 * Verifies: actions execute AND persist (not just "look alive"), native
 * failures surface as visible errors, unsupported states are visible, and one
 * failing native op cannot break the rest of the UI.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const harness = require('./ui-harness.js');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'www', 'index.html'), 'utf8');

let passed = 0;
let failed = 0;
const failures = [];
const section = (n) => console.log('\n== ' + n + ' ==');
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (err) { failed++; failures.push(name + ': ' + err.message); console.log('FAIL  ' + name + '\n      ' + err.message); }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const eq = (a, b, m) => assert(JSON.stringify(a) === JSON.stringify(b),
  (m || 'mismatch') + ' expected=' + JSON.stringify(b) + ' got=' + JSON.stringify(a));

function appScripts() {
  const files = {};
  const re = /<script src="([^"]+)"><\/script>/g;
  let m;
  while ((m = re.exec(HTML))) files[m[1]] = fs.readFileSync(path.join(ROOT, 'www', m[1]), 'utf8');
  return files;
}

function baseNatives(over) {
  const d = {
    status: function () { return JSON.stringify({ auto: false, global: 50, lastManualAt: null, canWrite: true, usageAccess: false, serviceRunning: false }); },
    version: function () { return JSON.stringify({ name: '2.0.1', code: 3 }); },
    getRules: function () { return '{}'; },
    saveRules: function () { return true; },
    getWeekly: function () { return '{}'; },
    saveWeekly: function () { return true; },
    getSensorRules: function () { return '{}'; },
    saveSensorRules: function () { return true; },
    getSensor: function () { return JSON.stringify({ value: null, source: null }); },
    getApps: function () { return '[]'; },
    setGlobal: function () { return true; },
    preset: function () { return true; },
    setAuto: function () { return true; },
    canWriteSettings: function () { return true; },
    hasUsageAccess: function () { return false; },
    openWriteSettings: function () {},
    openUsageAccess: function () {},
  };
  return Object.assign(d, over || {});
}

function fresh(over, presentNative) {
  return harness.createHarness({
    html: HTML,
    scripts: appScripts(),
    native: baseNatives(over),
    presentNative: presentNative,
  });
}

function presetBtn(h, pct) {
  return h.q('.presets button[data-pct]').filter(function (b) { return b.dataset.pct === String(pct); })[0];
}

section('Runtime wiring: boot + binding');
check('init binds on DOMContentLoaded and paints live status', () => {
  const h = fresh();
  h.ready();
  assert(h.textOf('pctValue') === '50', 'global pct not painted: ' + h.textOf('pctValue'));
  assert(h.textOf('statusLine').indexOf('Auto off') !== -1, 'status not painted: ' + h.textOf('statusLine'));
  assert(h.textOf('appVersion').indexOf('2.0.1') !== -1, 'version not painted: ' + h.textOf('appVersion'));
});

section('Runtime wiring: brightness actions');
check('preset button drives native setGlobal and paints the value', () => {
  const h = fresh();
  h.ready();
  h.tapEl(presetBtn(h, 30));
  eq(h.calls('setGlobal'), [[30]], 'setGlobal(30) not called once');
  assert(h.textOf('pctValue') === '30', 'pctValue not 30: ' + h.textOf('pctValue'));
  assert(h.toastText() === '30% applied', 'no success toast: ' + h.toastText());
  assert(!h.toastIsError(), 'success toast must not be styled as error');
});
check('failed brightness action shows a visible error, never a success toast', () => {
  const h = fresh({ setGlobal: function () { return false; } });
  h.ready();
  h.tapEl(presetBtn(h, 15));
  eq(h.calls('setGlobal'), [[15]], 'setGlobal attempted');
  assert(h.toastIsError(), 'failure must be styled as an error');
  assert(h.toastText().indexOf('Android does not allow this operation on this device.') !== -1,
    'missing device-restriction copy: ' + h.toastText());
  assert(h.toastText().indexOf('15% applied') === -1, 'must NOT claim success');
  assert(h.textOf('pctValue') === '50', 'value must not change on failure');
});
check('native exception on brightness surfaces visibly too', () => {
  const h = fresh({ setGlobal: function () { throw new Error('boom'); } });
  h.ready();
  h.tapEl(presetBtn(h, 50));
  assert(h.toastIsError(), 'exception must surface as an error toast');
  assert(h.toastText().indexOf('Android does not allow this operation on this device.') === 0,
    'wrong head copy: ' + h.toastText());
});

section('Runtime wiring: per-app rule persistence (Fix: dirty tracking)');
function hWithApps(over) {
  return fresh(Object.assign({
    getApps: function () { return JSON.stringify([{ packageName: 'com.example.reader', label: 'Reader' }]); },
  }, over || {}));
}
check('saving a per-app override PERSISTS (first edit)', () => {
  const h = hWithApps();
  h.ready();
  const item = h.q('#appList li')[0];
  assert(item, 'app list item missing');
  h.tapEl(item);
  h.set('sheetSlider', 40);
  h.tap('sheetDone');
  const saves = h.calls('saveRules');
  assert(saves.length === 1, 'saveRules not called: ' + saves.length + ' calls');
  assert(saves[0][0].indexOf('com.example.reader') !== -1, 'rule body missing package');
  assert(saves[0][0].indexOf('"pct":40') !== -1, 'rule body missing pct: ' + saves[0][0]);
  assert(h.toastText() === 'Reader \u2192 40%', 'no success toast: ' + h.toastText());
});
check('saving the SAME per-app override AGAIN also persists (second edit)', () => {
  const h = hWithApps();
  h.ready();
  const item = h.q('#appList li')[0];
  h.tapEl(item); h.set('sheetSlider', 40); h.tap('sheetDone');
  h.tapEl(item); h.set('sheetSlider', 60); h.tap('sheetDone');
  const saves = h.calls('saveRules');
  assert(saves.length === 2, 'second edit did not persist - dirty-tracking regression: ' + saves.length);
  assert(saves[1][0].indexOf('"pct":60') !== -1, 'second body wrong: ' + saves[1][0]);
});
check('removing an override persists', () => {
  const h = hWithApps();
  h.ready();
  const item = h.q('#appList li')[0];
  h.tapEl(item); h.set('sheetSlider', 40); h.tap('sheetDone');
  h.tapEl(item); h.tap('sheetRemove');
  const saves = h.calls('saveRules');
  assert(saves.length === 2, 'removal did not persist: ' + saves.length);
  assert(saves[1][0].indexOf('com.example.reader') === -1, 'removed rule still in body: ' + saves[1][0]);
});
check('failed per-app save shows an error and does NOT claim success or advance state', () => {
  const h = hWithApps({ saveRules: function () { return false; } });
  h.ready();
  const item = h.q('#appList li')[0];
  h.tapEl(item); h.set('sheetSlider', 40); h.tap('sheetDone');
  assert(h.toastIsError(), 'must be an error toast');
  assert(h.toastText().indexOf('Could not save your changes') !== -1, 'wrong copy: ' + h.toastText());
  assert(h.toastText().indexOf('Reader') === -1, 'must not report success label');
});

section('Runtime wiring: weekly schedule (Fix: active flag + persistence)');
check('weekly toggle writes active=true to native EVERY edit', () => {
  const h = fresh(); h.ready();
  h.setChecked('weeklyToggle', true);
  h.setChecked('weeklyToggle', false);
  h.setChecked('weeklyToggle', true);
  const saves = h.calls('saveWeekly');
  assert(saves.length === 3, 'each toggle must persist: ' + saves.length);
  assert(saves[0][0].indexOf('"active":true') !== -1, 'on-state lost the active flag: ' + saves[0][0]);
  assert(saves[1][0].indexOf('"active":false') !== -1, 'off-state persisted as on: ' + saves[1][0]);
  assert(h.textOf('weeklyNext').indexOf('schedule is off') === -1, 'next-activation should be live: ' + h.textOf('weeklyNext'));
});
check('toggle repaints to ON from persisted active=true', () => {
  const h = fresh({ getWeekly: function () { return JSON.stringify({ active: true, hour: 21, minute: 0, days: [0, 1, 2, 3, 4, 5, 6], pct: 30, durationMin: 60, previewMin: 1 }); } });
  h.ready();
  assert(h.byId('weeklyToggle').checked === true, 'checked state must reflect stored active=true');
});
check('failed weekly save is visible and retries cleanly after recovery', () => {
  let broken = true;
  const h = fresh({ saveWeekly: function () { if (broken) throw new Error('no storage'); return true; } });
  h.ready();
  h.setChecked('weeklyToggle', true);
  assert(h.toastIsError(), 'failed save must be visible');
  assert(h.toastText().indexOf('Weekly schedule on') === -1, 'must not claim success');
  eq(h.calls('saveWeekly').length, 1, 'one attempted save');
  broken = false;
  h.setChecked('weeklyToggle', true);
  assert(h.toastText() === 'Weekly schedule on', 'recovered save must succeed: ' + h.toastText());
  eq(h.calls('saveWeekly').length, 2, 'retried and persisted after recovery');
});

section('Runtime wiring: auto + grants');
check('auto toggle failure surfaces visibly instead of optimistic success', () => {
  const h = fresh({ setAuto: function () { throw new Error('service blocked'); } });
  h.ready();
  h.tap('autoToggle');
  eq(h.calls('setAuto'), [[true]], 'setAuto attempted with inverted state');
  assert(h.toastIsError(), 'must be an error toast');
  assert(h.toastText().indexOf('auto watcher') !== -1, 'copy should name the service: ' + h.toastText());
  assert(h.toastText().indexOf('Auto brightness on') === -1, 'no optimistic success');
});
check('grant-screen launcher failure is visible', () => {
  const h = fresh({ openWriteSettings: function () { throw new Error('no settings screen'); } });
  h.ready();
  h.tap('grantWrite');
  eq(h.calls('openWriteSettings'), [[]], 'openWriteSettings attempted');
  assert(h.toastIsError(), 'must be an error toast');
  assert(h.toastText().indexOf('Android does not allow this operation on this device.') !== -1, 'wrong copy');
});
check('grant launcher success produces no error', () => {
  const h = fresh(); h.ready();
  h.tap('grantUsage');
  assert(!h.toastIsError(), 'no error expected');
  eq(h.calls('openUsageAccess').length, 1, 'launched');
});

section('Runtime wiring: unsupported sensor state');
check('no thermal sensor -> visible unsupported state, add-rule disabled', () => {
  const h = fresh(); h.ready();
  const tab = h.q('.tabs .tab').filter(function (t) { return t.dataset.view === 'sensor'; })[0];
  h.tapEl(tab);
  assert(h.textOf('sensorTemp') === '\u2014', 'temp should show em-dash: ' + h.textOf('sensorTemp'));
  assert(h.textOf('sensorSource').indexOf('no thermal') !== -1, 'unsupported copy missing: ' + h.textOf('sensorSource'));
  assert(h.byId('sensorAdd').disabled === true, 'add-rule must be disabled without a sensor');
  assert(h.byId('sensorAdd').textContent.indexOf('No thermal sensor') !== -1, 'disabled label wrong');
});

section('Runtime wiring: handler isolation');
check('one failing native op cannot break the rest of the UI', () => {
  let broken = true;
  const h = fresh({ setGlobal: function () { if (broken) throw new Error('denied'); return true; } });
  h.ready();
  h.tapEl(presetBtn(h, 75));
  assert(h.toastIsError(), 'first failure surfaces');
  eq(h.calls('setGlobal').length, 1, 'attempted once');
  h.setChecked('themeToggle', true);
  assert(h.localStorage._dump()['bls-theme'] === 'light', 'theme persisted despite bridge failure');
  assert(h.win.document.body.classList.contains('light'), 'theme applied visually');
  broken = false;
  h.tapEl(presetBtn(h, 75));
  assert(!h.toastIsError(), 'recovered op no longer errors');
  assert(h.textOf('pctValue') === '75', 'recovered action executes');
});
check('missing native method (dangling JS->Java wiring) is caught and surfaced', () => {
  const h = fresh(null, true);
  delete h.win.Android.setGlobal;
  h.ready();
  h.tapEl(presetBtn(h, 75));
  assert(h.toastIsError(), 'missing bridge method must be a visible error');
  assert(h.toastText().indexOf('Android does not allow this operation on this device.') !== -1,
    'wrong copy for missing wiring: ' + h.toastText());
});

section('Runtime wiring: demo/browser mode');
check('demo mode (no native) keeps optimistic mock UX with zero native calls', () => {
  const h = fresh({ setGlobal: function () { throw new Error('must never be called'); } }, false);
  h.ready();
  assert(h.byId('autoToggle'), 'UI bound in demo mode');
  h.tapEl(presetBtn(h, 30));
  assert(h.textOf('pctValue') === '30', 'demo still paints the choice');
  assert(h.toastText() === '30% applied', 'demo keeps its mock toast');
  assert(!h.toastIsError(), 'demo never shows device errors');
  assert(h.recorded.length === 0, 'demo must not touch a native bridge (none exists)');
});

console.log('\n-------- runtime wiring: PASSED ' + passed + '  FAILED ' + failed + ' --------');
if (failed) { failures.forEach((f) => console.log(' - ' + f)); process.exit(1); }
console.log('ALL WIRING TESTS PASSED');