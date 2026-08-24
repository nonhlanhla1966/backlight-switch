/* Backlight Switch UI wiring - talks to the native bridge when present. */
(function () {
  'use strict';
  const Core = window.BacklightCore;
  const $ = (id) => document.getElementById(id);
  const native = () => window.Android || null;

  let rules = Core.parseRules('{}');
  let settings = Core.parseSettings(localStorage.getItem('bls.settings') || '{}');
  let apps = [];
  let sheetPkg = null;

  /* ---------- storage helpers ---------- */
  function loadRules() {
    const n = native();
    if (n) rules = Core.parseRules(n.getRules());
    else rules = Core.parseRules(localStorage.getItem('bls.rules') || '{}');
    renderOverrides();
  }
  function persistRules() {
    const json = JSON.stringify(rules);
    const n = native();
    if (n) n.saveRules(json);
    localStorage.setItem('bls.rules', json);
    renderOverrides();
  }
  function persistSettings() {
    localStorage.setItem('bls.settings', Core.serializeSettings(settings));
  }

  /* ---------- toast ---------- */
  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 2200);
  }

  /* ---------- tabs ---------- */
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
      btn.classList.add('active');
      $('view-' + btn.dataset.view).classList.add('active');
      if (btn.dataset.view === 'apps') loadApps();
      if (btn.dataset.view === 'setup') refreshStatus();
    });
  });

  /* ---------- dashboard ---------- */
  function setPctUI(pct) {
    $('pctValue').textContent = pct;
    $('globalSlider').value = pct;
  }
  function applyGlobal(pct, pushNative) {
    try { pct = Core.clampPct(pct); } catch (e) { return; }
    setPctUI(pct);
    const n = native();
    if (pushNative && n) {
      if (!n.canWriteSettings()) { requestWrite(); return; }
      if (!n.setGlobal(pct)) toast('Could not change brightness - grant Settings permission');
    }
  }
  let sliderTimer = null;
  $('globalSlider').addEventListener('input', (e) => {
    const pct = Number(e.target.value);
    $('pctValue').textContent = pct;
    clearTimeout(sliderTimer);
    sliderTimer = setTimeout(() => applyGlobal(pct, true), 120); // debounce native writes
  });
  document.querySelectorAll('[data-pct]').forEach((b) => {
    b.addEventListener('click', () => applyGlobal(Number(b.dataset.pct), true));
  });

  $('themeToggle').addEventListener('change', (e) => {
    settings.theme = e.target.checked ? 'light' : 'dark';
    applyTheme();
    persistSettings();
  });
  function applyTheme() {
    document.body.dataset.theme = settings.theme;
    $('themeToggle').checked = settings.theme === 'light';
  }

  /* ---------- master switch ---------- */
  $('autoToggle').addEventListener('click', async () => {
    const n = native();
    if (!n) { toast('Native bridge unavailable'); return; }
    const st = JSON.parse(n.status() || '{}');
    if (!st.canWrite) { requestWrite(); return; }
    if (!st.usageAccess) { requestUsage(); return; }
    const on = !st.auto;
    n.setAuto(on);
    renderPower(on);
    toast(on ? 'Auto brightness on' : 'Auto brightness off');
  });
  function renderPower(on) {
    $('autoToggle').classList.toggle('on', !!on);
    const line = $('statusLine');
    line.textContent = on ? 'Auto brightness active' : 'Manual mode';
    line.classList.toggle('on', !!on);
  }

  /* ---------- overrides list ---------- */
  function renderOverrides() {
    const ul = $('overrideList');
    ul.innerHTML = '';
    const pkgs = Object.keys(rules).sort((a, b) => a.localeCompare(b));
    $('noOverrides').classList.toggle('hidden', pkgs.length > 0);
    for (const pkg of pkgs) {
      const li = document.createElement('li');
      const left = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'appname';
      name.textContent = labelFor(pkg);
      const sub = document.createElement('div');
      sub.className = 'pkgname';
      sub.textContent = pkg;
      left.appendChild(name); left.appendChild(sub);
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = rules[pkg].pct + '%';
      li.appendChild(left); li.appendChild(badge);
      li.addEventListener('click', () => openSheet(pkg));
      ul.appendChild(li);
    }
  }
  function labelFor(pkg) {
    const hit = apps.find((a) => a.pkg === pkg);
    return hit ? hit.label : pkg.split('.').pop();
  }

  /* ---------- app list ---------- */
  function loadApps() {
    if (apps.length) { renderApps($('appSearch').value); return; }
    const n = native();
    if (n) {
      apps = Core.sanitizeApps(JSON.parse(n.getApps() || '[]'));
    } else {
      apps = [];
    }
    renderApps($('appSearch').value);
  }
  function renderApps(filter) {
    const ul = $('appList');
    ul.innerHTML = '';
    const q = (filter || '').trim().toLowerCase();
    const shown = apps.filter((a) =>
      !q || a.label.toLowerCase().includes(q) || a.pkg.toLowerCase().includes(q));
    $('appsEmpty').classList.toggle('hidden', shown.length > 0);
    for (const a of shown) {
      const li = document.createElement('li');
      const left = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'appname';
      name.textContent = a.label;
      const sub = document.createElement('div');
      sub.className = 'pkgname';
      sub.textContent = a.pkg;
      left.appendChild(name); left.appendChild(sub);
      const right = document.createElement('div');
      right.style.display = 'flex';
      right.style.alignItems = 'center';
      right.style.gap = '8px';
      if (rules[a.pkg]) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = rules[a.pkg].pct + '%';
        right.appendChild(badge);
      }
      const arrow = document.createElement('span');
      arrow.className = 'arrow';
      arrow.textContent = '›';
      right.appendChild(arrow);
      li.appendChild(left); li.appendChild(right);
      li.addEventListener('click', () => openSheet(a.pkg));
      ul.appendChild(li);
    }
  }
  $('appSearch').addEventListener('input', (e) => renderApps(e.target.value));

  /* ---------- editor sheet ---------- */
  function openSheet(pkg) {
    sheetPkg = pkg;
    const existing = Core.getRule(rules, pkg);
    const pct = existing ? existing.pct : Core.resolveBrightness(rules, pkg, Number($('globalSlider').value));
    $('sheetTitle').textContent = labelFor(pkg);
    $('sheetPkg').textContent = pkg;
    $('sheetPct').textContent = pct;
    $('sheetSlider').value = pct;
    $('sheetRemove').style.visibility = existing ? 'visible' : 'hidden';
    $('sheetBackdrop').classList.remove('hidden');
    $('sheet').classList.remove('hidden');
  }
  function closeSheet() {
    $('sheetBackdrop').classList.add('hidden');
    $('sheet').classList.add('hidden');
    sheetPkg = null;
  }
  $('sheetBackdrop').addEventListener('click', closeSheet);
  $('sheetSlider').addEventListener('input', (e) => {
    $('sheetPct').textContent = e.target.value;
  });
  document.querySelectorAll('[data-sheet-pct]').forEach((b) => {
    b.addEventListener('click', () => {
      $('sheetSlider').value = b.dataset.sheetPct;
      $('sheetPct').textContent = b.dataset.sheetPct;
    });
  });
  $('sheetDone').addEventListener('click', () => {
    if (sheetPkg) {
      try {
        Core.setRule(rules, sheetPkg, Number($('sheetSlider').value));
        persistRules();
        toast('Override saved');
      } catch (e) { toast(e.message); }
    }
    closeSheet();
  });
  $('sheetRemove').addEventListener('click', () => {
    if (sheetPkg) {
      try {
        Core.removeRule(rules, sheetPkg);
        persistRules();
        toast('Override removed');
      } catch (e) { toast(e.message); }
    }
    closeSheet();
  });

  /* ---------- permissions ---------- */
  function requestWrite() { const n = native(); if (n) n.openWriteSettings(); toast('Allow "Modify system settings"'); }
  function requestUsage() { const n = native(); if (n) n.openUsageAccess(); toast('Enable "Usage access" for this app'); }

  document.querySelectorAll('#grantWrite').forEach((card) => {
    card.addEventListener('click', requestWrite);
  });
  document.querySelectorAll('#grantUsage').forEach((card) => {
    card.addEventListener('click', requestUsage);
  });

  /* ---------- status ---------- */
  function refreshStatus() {
    const n = native();
    if (!n) {
      renderPower(false);
      $('statusLine').textContent = 'demo mode (no bridge)';
      $('grantWrite').querySelector('.chip').textContent = 'n/a';
      $('grantUsage').querySelector('.chip').textContent = 'n/a';
      return;
    }
    const st = JSON.parse(n.status() || '{}');
    renderPower(st.auto);
    setPctUI(st.brightness || 50);
    const gw = $('grantWrite'), gu = $('grantUsage');
    gw.classList.toggle('ok', !!st.canWrite);
    gw.querySelector('.chip').textContent = st.canWrite ? 'on' : 'off';
    gu.classList.toggle('ok', !!st.usageAccess);
    gu.querySelector('.chip').textContent = st.usageAccess ? 'on' : 'off';
    if (st.serviceRunning !== undefined && !st.auto) {
      // service stopped externally: reflect reality
      renderPower(st.auto);
    }
  }
  window.onNativeResume = refreshStatus; // called from Activity.onResume()

  /* ---------- boot ---------- */
  applyTheme();
  loadRules();
  refreshStatus();
})();
