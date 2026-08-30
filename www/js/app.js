/* Backlight Switch v2 UI. Talks to Android only through BacklightBridge so
 * the page stays load-safe in plain browsers (all native calls are optional).
 */
(function () {
  'use strict';

  var C = window.BacklightCore;
  var B = window.BacklightBridge;

  /* Real device mode (native bridge injected) vs demo/browser preview. Only
   * real-mode surfaces native failures as visible errors - demo keeps the
   * optimistic mock behavior so the page stays pleasant in a plain browser. */
  var IS_NATIVE = !!B.running;

  /* ---------------------------------------------------------------- state */
  var apps = [];
  var filtered = [];
  var rules = C.parseRules(B.getRules());
  var weekly = C.parseWeekly(B.getWeekly());
  var sensorRules = C.parseSensorRules(B.getSensorRules());
  var settings = C.parseSettings(B.status());
  var lastSensor = null;
  var search = '';
  var currentGlobal = 50;
  var globalErrShown = false;

  /* Canonical serialized baselines of what the native store last accepted.
   * saveAll() re-serializes the live objects and persists any difference, so
   * every in-place edit (setRule/removeRule/setSensorRule/... mutate the same
   * object) is detected - an object-identity snapshot could never catch it. */
  var baseline = { rules: '', weekly: '', sensor: '' };

  var $ = function (id) { return document.getElementById(id); };
  var show = function (el) { if (el) el.classList.remove('hidden'); };
  var hide = function (el) { if (el) el.classList.add('hidden'); };

  function safeParse(v) {
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch (e) { return null; }
  }

  /* -------------------------------------------------------------- helpers */
  function toast(msg, isErr) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.toggle('error', !!isErr);
    t.classList.remove('hidden');
    t.classList.add('show');
    clearTimeout(t._t);
    t._t = setTimeout(function () { t.classList.remove('show'); }, isErr ? 4200 : 1900);
  }

  function toastErr(msg) { toast(msg, true); }

  /* Deliver one native action. In real mode a native failure (exception, or a
   * boolean action returning false) surfaces as an actionable visible error
   * and the caller never reports optimistic success. okWhen 'bool' demands a
   * strict true; void launchers (permission screens) only need no exception. */
  function act(op, fn, okWhen) {
    var res = { ok: true, value: undefined };
    if (IS_NATIVE) {
      B.clearErr();
      try { res.value = fn(); } catch (e) {
        res.ok = false;
        res.error = { op: op, message: String((e && e.message) || e) };
        return res;
      }
      var err = B.err();
      B.clearErr();
      if (err) { res.ok = false; res.error = err; return res; }
      if (okWhen === 'bool') res.ok = res.value === true;
    } else {
      try { res.value = fn(); } catch (e) { res.ok = false; }
    }
    return res;
  }

  function saveAll(quiet) {
    var saved = 0;
    var rj = C.serializeRules(rules);
    if (rj !== baseline.rules) {
      var r1 = act('saveRules', function () { return B.saveRules(rj); }, 'bool');
      if (!r1.ok) { toastErr('Android does not allow this operation on this device. Could not save your changes.'); return false; }
      baseline.rules = rj; saved += 1;
    }
    var wj = C.serializeWeekly(weekly);
    if (wj !== baseline.weekly) {
      var r2 = act('saveWeekly', function () { return B.saveWeekly(wj); }, 'bool');
      if (!r2.ok) { toastErr('Android does not allow this operation on this device. Could not save your changes.'); return false; }
      baseline.weekly = wj; saved += 1;
    }
    var sj = C.serializeSensorRules(sensorRules);
    if (sj !== baseline.sensor) {
      var r3 = act('saveSensorRules', function () { return B.saveSensorRules(sj); }, 'bool');
      if (!r3.ok) { toastErr('Android does not allow this operation on this device. Could not save your changes.'); return false; }
      baseline.sensor = sj; saved += 1;
    }
    if (!quiet && saved > 0) toast('Saved');
    return true;
  }

  function repaintStatus() {
    var st = B.status();
    var on = !!st.auto;
    $('autoToggle').classList.toggle('on', on);
    var lines = [];
    if (on) {
      lines.push('Auto on');
      var now = new Date();
      var wp = C.weeklyActiveAt(weekly, now);
      if (wp) lines.push('scheduled preset ' + wp.pct + '%');
      var sp = st.sensorActive ? 'sensor dim' : null;
      if (sp) lines.push(sp);
      if (st.currentRule) lines.push(st.currentRule.name + ' rule');
      if (!lines[1]) lines.push('(watcher active)');
    } else {
      lines.push('Auto off — dragging the slider applies manually');
    }
    if (st.muted) lines.push('screen off · paused');
    $('statusLine').textContent = lines.join(' · ');
  }

  function repaintPct(v) {
    v = C.clampPct(v);
    currentGlobal = v;
    $('pctValue').textContent = v;
    $('globalSlider').value = v;
  }

  function repaintOverrides() {
    var sorted = apps.filter(function (a) {
      return a.packageName && C.getRule(rules, a.packageName);
    }).map(function (a) {
      return { packageName: a.packageName, label: a.label || a.packageName };
    });
    if (apps.length) {
      var extra = Object.keys(rules).filter(function (p) {
        return !apps.some(function (a) { return a.packageName === p; });
      });
      extra.forEach(function (p) { sorted.push({ packageName: p, label: p }); });
    }
    var list = $('overrideList');
    list.innerHTML = '';
    hide($('noOverrides'));
    if (!sorted.length) { show($('noOverrides')); return; }
    sorted.forEach(function (r) {
      var li = document.createElement('li');
      var name = document.createElement('span');
      name.textContent = r.label;
      var val = document.createElement('b');
      val.textContent = rules[r.packageName] + '%';
      li.appendChild(name); li.appendChild(val);
      list.appendChild(li);
    });
  }

  function repaintWeeklyUI() {
    $('weeklyToggle').checked = !!weekly.active;
    $('weeklyHour').value = weekly.hour;
    $('weeklyMinute').value = weekly.minute;
    $('weeklyPct').value = weekly.pct;
    $('weeklyPctValue').textContent = weekly.pct;
    renderMeridiem();
    var buttons = $('weeklyDays').querySelectorAll('button');
    buttons.forEach(function (b) {
      b.classList.toggle('on', weekly.days.indexOf(Number(b.dataset.day)) !== -1);
    });
  }

  function renderMeridiem() {
    $('weeklyMeridiem').textContent = (weekly.hour < 12 ? 'AM' : 'PM');
  }

  function repaintWeeklyNext() {
    var st = B.status();
    var now = new Date();
    var nowMs = now.getTime();
    var el = $('weeklyNext');
    if (!weekly.active) {
      el.textContent = 'schedule is off — flip the toggle to enable it';
      $('weeklyInfo').textContent = 'At the trigger time the app dims to the preset level for 1 hour on each chosen weekday.';
      return;
    }
    if (C.weeklyBlocked(weekly, st.lastManualAt, nowMs)) {
      el.textContent = 'suspended — manual change inside the current hour';
      $('weeklyInfo').textContent = 'Your manual slider change overrides tonight\u2019s preset; it re-arms at the next scheduled hour.';
      return;
    }
    var next = C.nextWeeklyTrigger(weekly, nowMs);
    if (!next) {
      el.textContent = 'no enabled days — pick days on the Trigger time card';
      $('weeklyInfo').textContent = 'Enable at least one weekday above.';
      return;
    }
    var pre = C.inPreviewAt(weekly, nowMs);
    var label = new Date(next).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    el.textContent = (pre.previewing ? 'preview in progress now — ' : 'next ' + label) +
      ' · dims to ' + weekly.pct + '% for 1 hour';
    $('weeklyInfo').textContent = pre.previewing
      ? 'The dim preview is ramping right now; it levels off exactly on the hour.'
      : 'Last minute before ' + label + ' runs a gradual dim preview.';
  }

  function refreshSensor() {
    if (!C.sensorSupported(B)) {
      $('sensorTemp').textContent = '—';
      $('sensorSource').textContent = 'no thermal sensor detected';
      return;
    }
    var s = B.getSensor();
    if (s && s.value !== null && s.value !== undefined) {
      $('sensorTemp').textContent = Number(s.value).toFixed(1);
      $('sensorUnit').textContent = '°C';
      $('sensorSource').textContent = (s.source || 'thermal') + ' · live';
      lastSensor = Number(s.value);
      paintSensorRules();
    } else {
      $('sensorTemp').textContent = '—';
      $('sensorSource').textContent = 'no thermal sensor (unsupported device).';
    }
  }

  function paintSensorRules() {
    var listEl = $('sensorList');
    listEl.innerHTML = '';
    var keys = Object.keys(sensorRules);
    hide($('sensorEmpty'));
    if (!keys.length) { show($('sensorEmpty')); return; }
    keys.forEach(function (p) {
      var r = sensorRules[p];
      var li = document.createElement('li');
      var name = document.createElement('span');
      var app = apps.filter(function (a) { return a.packageName === p; })[0];
      name.textContent = (app && app.label) || p;
      var val = document.createElement('b');
      val.textContent = '> ' + r.threshold + '°C → ' + r.pct + '%';
      li.appendChild(name); li.appendChild(val);
      li.addEventListener('click', function () {
        openSensorSheet({ packageName: p, label: name.textContent });
      });
      listEl.appendChild(li);
    });
  }

  function repaintApps() {
    filtered = (search ? apps.filter(function (a) {
      var hay = ((a.label || '') + ' ' + (a.packageName || '')).toLowerCase();
      return hay.indexOf(search.toLowerCase()) !== -1;
    }) : apps.slice());
    var list = $('appList');
    list.innerHTML = '';
    hide($('appsEmpty'));
    if (!filtered.length) { show($('appsEmpty')); return; }
    filtered.forEach(function (a) {
      var li = document.createElement('li');
      li.textContent = a.label || a.packageName;
      li.addEventListener('click', function () { openSheet(a); });
      list.appendChild(li);
    });
  }

  /* ------------------------------------------------------------------ app */
  function openSheet(app) {
    var pkg = app.packageName;
    var pct = C.getRule(rules, pkg) || currentGlobal;
    $('sheetTitle').textContent = app.label || pkg;
    $('sheetPkg').textContent = pkg;
    $('sheetSlider').value = pct;
    $('sheetPct').textContent = pct;
    $('sheetRemove').style.display = C.getRule(rules, pkg) !== undefined ? '' : 'none';
    show($('sheetBackdrop')); show($('sheet'));
    currentSheetApp = app;
  }

  var currentSheetApp = null;

  function closeSheet() {
    hide($('sheet')); hide($('sheetBackdrop'));
    currentSheetApp = null;
  }

  function saveSheet() {
    if (!currentSheetApp) return;
    var pct = Number($('sheetSlider').value);
    rules = C.setRule(rules, currentSheetApp.packageName, pct);
    var ok = saveAll(true);
    repaintOverrides();
    if (ok) toast(currentSheetApp.label + ' → ' + pct + '%');
    closeSheet();
  }

  function removeSheetApp() {
    if (!currentSheetApp) return;
    rules = C.removeRule(rules, currentSheetApp.packageName);
    var ok = saveAll(true);
    repaintOverrides();
    if (ok) toast('Removed override');
    closeSheet();
  }

  /* ------------------------------------------------------------ sensor UI */
  var currentSensorApp = null;

  function openSensorSheet(app) {
    currentSensorApp = app;
    var r = C.getSensorRule(sensorRules, app.packageName);
    $('sensorPkg').textContent = app.label || app.packageName;
    $('sensorThreshold').value = r ? r.threshold : 55;
    $('sensorThresholdValue').textContent = $('sensorThreshold').value;
    $('sensorRulePct').value = r ? r.pct : 20;
    $('sensorRulePctValue').textContent = $('sensorRulePct').value;
    $('sensorRemove').style.display = r ? '' : 'none';
    show($('sensorBackdrop')); show($('sensorSheet'));
  }

  function closeSensorSheet() {
    hide($('sensorSheet')); hide($('sensorBackdrop'));
    currentSensorApp = null;
  }

  function saveSensorSheet() {
    if (!currentSensorApp) return;
    var pkg = currentSensorApp.packageName;
    var threshold = Number($('sensorThreshold').value);
    var pct = Number($('sensorRulePct').value);
    sensorRules = C.setSensorRule(sensorRules, pkg, threshold, pct);
    var ok = saveAll(true);
    paintSensorRules();
    if (ok) toast('Sensor rule saved');
    closeSensorSheet();
  }

  function removeSensorSheetApp() {
    if (!currentSensorApp) return;
    sensorRules = C.removeSensorRule(sensorRules, currentSensorApp.packageName);
    var ok = saveAll(true);
    paintSensorRules();
    if (ok) toast('Sensor rule removed');
    closeSensorSheet();
  }

  /* ---------------------------------------------------------------- binds */
  function bindEvents() {
    $('autoToggle').addEventListener('click', function () {
      var nowOn = B.getAuto();
      var r = act('setAuto', function () { return B.setAuto(!nowOn); }, 'bool');
      if (!r.ok) { toastErr('Android does not allow this operation on this device. The auto watcher could not be started.'); return; }
      toast(nowOn ? 'Auto brightness off' : 'Auto brightness on');
      setTimeout(repaintStatus, 250);
    });

    $('globalSlider').addEventListener('input', function () {
      var v = Number(this.value);
      $('pctValue').textContent = v;
      previewLike(v);
      var r = act('setGlobal', function () { return B.setGlobal(v); }, 'bool');
      if (!r.ok) {
        if (!globalErrShown) toastErr('Android does not allow this operation on this device. Modify system settings permission is required.');
        globalErrShown = true;
        return;
      }
      globalErrShown = false;
      saveAll(true);
    });
    $('globalSlider').addEventListener('change', saveAll);

    $('themeToggle').addEventListener('change', function () {
      document.body.classList.toggle('light', this.checked);
      localStorage.setItem('bls-theme', this.checked ? 'light' : 'dark');
    });

    QSA('.tabs .tab').forEach(function (t) {
      t.addEventListener('click', function () {
        QSA('.tabs .tab').forEach(function (x) { x.classList.remove('active'); });
        t.classList.add('active');
        QSA('.view').forEach(function (v) { v.classList.remove('active'); });
        show($('view-' + t.dataset.view));
        if (t.dataset.view === 'sensor') refreshSensor();
      });
    });

    QSA('.presets button[data-pct]').forEach(function (b) {
      b.addEventListener('click', function () {
        var pct = Number(b.dataset.pct);
        var r = act('setGlobal', function () { return B.setGlobal(pct); }, 'bool');
        if (!r.ok) { toastErr('Android does not allow this operation on this device. Modify system settings permission is required.'); return; }
        repaintPct(pct);
        toast(pct + '% applied');
      });
    });

    $('appSearch').addEventListener('input', function () {
      search = this.value;
      repaintApps();
    });

    $('weeklyToggle').addEventListener('change', function () {
      weekly.active = this.checked;
      var ok = saveAll(true);
      repaintWeeklyNext();
      if (ok) toast(this.checked ? 'Weekly schedule on' : 'Weekly schedule off');
    });

    $('weeklyHour').addEventListener('change', function () {
      weekly.hour = Number(this.value);
      saveAll(true); renderMeridiem(); repaintWeeklyNext();
    });
    $('weeklyMinute').addEventListener('change', function () {
      weekly.minute = Number(this.value);
      saveAll(true); repaintWeeklyNext();
    });
    QSA('#weeklyDays button').forEach(function (b) {
      b.addEventListener('click', function () {
        var d = Number(b.dataset.day);
        var i = weekly.days.indexOf(d);
        if (i === -1) weekly.days.push(d); else weekly.days.splice(i, 1);
        weekly.days.sort();
        saveAll(true); repaintWeeklyNext();
      });
    });
    $('weeklyPct').addEventListener('input', function () {
      weekly.pct = Number(this.value);
      $('weeklyPctValue').textContent = weekly.pct;
    });
    $('weeklyPct').addEventListener('change', function () { saveAll(true); repaintWeeklyNext(); });
    QSA('.presets button[data-wpct]').forEach(function (b) {
      b.addEventListener('click', function () {
        weekly.pct = Number(b.dataset.wpct);
        $('weeklyPct').value = weekly.pct;
        repaintWeeklyUI();
        saveAll(true); repaintWeeklyNext();
      });
    });

    $('sensorAdd').addEventListener('click', function () {
      var first = apps.filter(function (a) { return !C.getSensorRule(sensorRules, a.packageName); })[0];
      if (!first) { toast('Install an app to add a sensor rule'); return; }
      openSensorSheet(first);
    });
    $('sensorRefresh').addEventListener('click', function () { refreshSensor(); });
    $('sensorRulePct').addEventListener('input', function () {
      $('sensorRulePctValue').textContent = this.value;
    });
    $('sensorThreshold').addEventListener('input', function () {
      $('sensorThresholdValue').textContent = this.value;
    });

    $('sheetSlider').addEventListener('input', function () {
      $('sheetPct').textContent = this.value;
    });
    QSA('.presets button[data-sheet-pct]').forEach(function (b) {
      b.addEventListener('click', function () {
        $('sheetSlider').value = b.dataset.sheetPct;
        $('sheetPct').textContent = b.dataset.sheetPct;
      });
    });
    $('sheetDone').addEventListener('click', saveSheet);
    $('sheetRemove').addEventListener('click', removeSheetApp);
    $('sheetBackdrop').addEventListener('click', closeSheet);
    $('sensorDone').addEventListener('click', saveSensorSheet);
    $('sensorRemove').addEventListener('click', removeSensorSheetApp);
    $('sensorBackdrop').addEventListener('click', closeSensorSheet);

    $('grantWrite').addEventListener('click', function () {
      var r = act('openWriteSettings', function () { B.openWriteSettings(); });
      if (!r.ok) toastErr('Android does not allow this operation on this device.');
    });
    $('grantUsage').addEventListener('click', function () {
      var r = act('openUsageAccess', function () { B.openUsageAccess(); });
      if (!r.ok) toastErr('Android does not allow this operation on this device.');
    });
  }

  function QSA(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  function previewLike(v) {
    var st = B.status();
    if (!st || !st.previewing) return;
    $('previewBanner').textContent =
      'Preview: dimming to ' + st.previewPct + '% · applying now on hour';
    show($('previewBanner'));
    setTimeout(function () { hide($('previewBanner')); }, 4200);
  }

  function checkCapabilities() {
    var w = B.canWrite();
    var u = B.hasUsageAccess();
    $('grantWrite').classList.toggle('ok', !!w);
    $('grantUsage').classList.toggle('ok', !!u);
    $('grantWrite').querySelector('.chip').textContent = w ? 'granted' : 'off';
    $('grantUsage').querySelector('.chip').textContent = u ? 'granted' : 'off';
  }

  function pollSensor() {
    if (!($('view-sensor').classList.contains('active'))) return;
    refreshSensor();
  }
  function init() {
    var theme = localStorage.getItem('bls-theme');
    if (theme === 'light') {
      document.body.classList.add('light');
      $('themeToggle').checked = true;
    }

    var st = B.status();
    settings = C.parseSettings(st);

    var g = (st && st.global !== undefined) ? st.global : 50;
    repaintPct(g);

    var info = C.sanitizeApps(safeParse(B.getApps()) || []);
    apps = info;
    repaintApps();
    repaintOverrides();

    weekly = C.parseWeekly(B.getWeekly(), st);
    repaintWeeklyUI();
    repaintWeeklyNext();

    /* Baseline reflects exactly what the native store holds after hydration,
     * so the first user edit - and every later one - is detected. */
    baseline.rules = C.serializeRules(rules);
    baseline.weekly = C.serializeWeekly(weekly);
    baseline.sensor = C.serializeSensorRules(sensorRules);

    var sn = C.sensorSupported(B);
    if (!sn) {
      $('sensorAdd').textContent = 'No thermal sensor on this device';
      $('sensorAdd').disabled = true;
    }

    var v = B.version();
    var vname = (v && v.name) || '2.0.1';
    var vcode = (v && v.code) || '3';
    $('appVersion').textContent = 'Backlight Switch ' + vname + ' (' + vcode + ')';

    bindEvents();
    checkCapabilities();
    repaintStatus();

    setInterval(function () {
      checkCapabilities();
      repaintStatus();
      repaintWeeklyNext();
      paintSensorRules();
      pollSensor();
    }, 3000);
    setInterval(refreshSensor, 15000);
  }

  document.addEventListener('DOMContentLoaded', init);
})();