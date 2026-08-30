#!/usr/bin/env node
/* WebView interaction harness - the permanent regression mechanism for the
 * "buttons look alive but actions don't execute" class of defect.
 *
 * Loads the REAL index.html + real JS (bridge + app) of a WebView app into a
 * minimal dependency-free DOM and a strict *recording* mock of the native
 * JavascriptInterface, then lets tests drive actual button/input events end to
 * end: button -> handler -> bridge -> native -> result -> UI.
 *
 * Node 8-safe, zero npm dependencies. The factory keeps an identical copy of
 * this harness (factory/core/webtest.js) as the canonical mechanism.
 */
'use strict';

function El(tag, attrs) {
  this.tagName = String(tag).toUpperCase();
  this.attrs = attrs || {};
  this.id = this.attrs.id || null;
  this.className = this.attrs['class'] || '';
  this.children = [];
  this._text = '';
  this.style = {};
  this.dataset = {};
  this.disabled = false;
  this._listeners = {};
  var self = this;
  Object.keys(this.attrs).forEach(function (k) {
    if (k.indexOf('data-') === 0) {
      var key = k.slice(5).replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); });
      self.dataset[key] = self.attrs[k];
    }
  });
  if (tag === 'input') {
    this.value = this.attrs.type && this.attrs.type === 'checkbox'
      ? (this.attrs.checked !== undefined)
      : (this.attrs.type && this.attrs.type === 'range' ? (this.attrs.value || '50') : (this.attrs.value || ''));
    this.checked = this.attrs.checked !== undefined;
  } else if (tag === 'select') {
    this.value = '';
  }
  /* Per-instance classList bound to the element (prototype-scoped objects
   * would make `this` the classList literal, not the element). */
  this.classList = {
    add: function (n) {
      if (!self.classList.contains(n)) self.className = (self.className + ' ' + n).replace(/^\s+/, ' ').trim();
    },
    remove: function (n) {
      self.className = self.className.split(/\s+/).filter(function (c) { return c && c !== n; }).join(' ');
    },
    toggle: function (n, force) {
      var has = self.classList.contains(n);
      var want = force === undefined ? !has : !!force;
      if (want && !has) self.classList.add(n);
      else if (!want && has) self.classList.remove(n);
      return want;
    },
    contains: function (n) {
      return self.className.split(/\s+/).indexOf(n) !== -1;
    },
  };
}

Object.defineProperty(El.prototype, 'textContent', {
  get: function () {
    var out = this._text;
    for (var i = 0; i < this.children.length; i += 1) {
      out += this.children[i].textContent;
    }
    return out;
  },
  set: function (v) {
    this._text = String(v);
    this.children = [];
  },
});

Object.defineProperty(El.prototype, 'innerHTML', {
  get: function () {
    return this.children.map(function (c) { return c.tagName; }).join(',');
  },
  set: function (v) {
    if (v === '') { this._text = ''; this.children = []; }
  },
});

El.prototype.addEventListener = function (type, fn) {
  (this._listeners[type] = this._listeners[type] || []).push(fn);
};
El.prototype.dispatch = function (type, extra) {
  var fns = (this._listeners[type] || []).slice();
  var ev = Object.assign({ type: type, target: this, currentTarget: this, preventDefault: function () {} }, extra || {});
  for (var i = 0; i < fns.length; i += 1) fns[i].call(this, ev);
};
El.prototype.appendChild = function (child) { this.children.push(child); return child; };
El.prototype.querySelector = function (sel) {
  var all = queryAll(this, sel);
  return all.length ? all[0] : null;
};
El.prototype.querySelectorAll = function (sel) { return queryAll(this, sel); };

/* -------- minimal selector engine (subset sufficient for WebView UIs) -------- */
function matchesPart(el, part) {
  var p = String(part).trim();
  if (!p) return false;
  var tagRE = /^([a-zA-Z][\w-]*|\*)/;
  var m = tagRE.exec(p);
  if (m && m[1] !== '*') {
    if (el.tagName !== m[1].toUpperCase()) return false;
    p = p.slice(m[0].length);
  }
  var idM = /^#([\w-]+)/.exec(p);
  if (idM) {
    if (el.id !== idM[1]) return false;
    p = p.slice(idM[0].length);
  }
  while (p) {
    var clsM = /^\.([\w-]+)/.exec(p);
    var attrM = /^\[([\w-]+)(?:="([^"]*)")?\]/.exec(p);
    if (!clsM && !attrM) return false;
    if (clsM) {
      if (el.attrs['class'] === undefined) return false;
      var parts = String(el.attrs['class']).split(/\s+/);
      if (parts.indexOf(clsM[1]) === -1) return false;
      p = p.slice(clsM[0].length);
    } else if (attrM) {
      var key = attrM[1];
      if (!(key in el.attrs)) return false;
      if (attrM[2] !== undefined && String(el.attrs[key]) !== attrM[2]) return false;
      p = p.slice(attrM[0].length);
    }
  }
  return true;
}

function matches(el, sel) {
  if (sel.indexOf(' ') !== -1) throw new Error('multi-part selector passed to matches(): ' + sel);
  return matchesPart(el, sel);
}

function descend(el, part, out) {
  for (var i = 0; i < el.children.length; i += 1) {
    var c = el.children[i];
    if (matchesPart(c, part)) out.push(c);
    descend(c, part, out);
  }
  return out;
}

function queryAll(root, sel) {
  var parts = String(sel).trim().split(/\s+/).filter(function (s) { return s; });
  if (parts.length === 1) return descend(root, parts[0], []);
  var level = [root];
  for (var i = 0; i < parts.length; i += 1) {
    var next = [];
    for (var j = 0; j < level.length; j += 1) descend(level[j], parts[i], next);
    level = next;
    if (!level.length) break;
  }
  return level;
}

/* -------- HTML parser (subset; index.html is a trusted, self-authored file) -------- */
var VOID_TAGS = { meta: 1, link: 1, input: 1, br: 1, img: 1, hr: 1 };

function parseHtml(html) {
  var doc = new El('html', {});
  var cur = null;
  var stack = [];
  var i = 0;
  var n = html.length;
  while (i < n) {
    if (html[i] === '<') {
      if (html.substr(i, 4) === '<!--') {
        var end = html.indexOf('-->', i);
        i = end === -1 ? n : end + 3;
        continue;
      }
      if (html[i + 1] === '!' || html[i + 1] === '?') {
        var gt = html.indexOf('>', i);
        i = gt === -1 ? n : gt + 1;
        continue;
      }
      if (html[i + 1] === '/') {
        var closeEnd = html.indexOf('>', i);
        var closeTag = html.slice(i + 2, closeEnd).trim().toLowerCase();
        i = closeEnd === -1 ? n : closeEnd + 1;
        while (stack.length && stack[stack.length - 1].tagName.toLowerCase() !== closeTag) stack.pop();
        if (stack.length) stack.pop();
        cur = stack.length ? stack[stack.length - 1] : null;
        continue;
      }
      var tagEnd = html.indexOf('>', i);
      var seg = html.slice(i + 1, tagEnd).trim();
      var tagOf = seg.search(/[\s\/]/);
      var tag = tagOf === -1 ? seg : seg.slice(0, tagOf);
      var selfClose = /\/\s*>$/.test(seg) || VOID_TAGS[tag.toLowerCase()];
      var attrs = {};
      var rest = tagOf !== -1 ? seg.slice(tagOf).trim().replace(/\/+$/, '').trim() : '';
      var aM;
      var aRE = /([\w-]+)(?:\s*=\s*"([^"]*)")?/g;
      while ((aM = aRE.exec(rest))) {
        if (aM[1] !== '') attrs[aM[1]] = aM[2] !== undefined ? aM[2] : '';
      }
      var el = new El(tag, attrs);
      var parent = stack.length ? stack[stack.length - 1] : null;
      (parent ? parent.children : doc.children).push(el);
      if (!selfClose) {
        stack.push(el);
        cur = el;
      }
      i = tagEnd === -1 ? n : tagEnd + 1;
      continue;
    }
    var textEnd = html.indexOf('<', i);
    var text = html.slice(i, textEnd === -1 ? n : textEnd)
      .replace(/&nbsp;/g, '\u00a0').replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
    var targetEl = stack.length ? stack[stack.length - 1] : null;
    if (text && targetEl && !VOID_TAGS[targetEl.tagName.toLowerCase()]) targetEl._text += text;
    i = textEnd === -1 ? n : textEnd;
  }
  return doc;
}

/* -------- fake timer pool (keeps Node from hanging on setInterval) -------- */
function TimerPool() {
  this._now = 0;
  this.nextId = 1;
  this.tasks = {};
}
TimerPool.prototype._add = function (fn, ms, interval) {
  var id = this.nextId++;
  this.tasks[id] = { fn: fn, at: this._now + Math.max(0, Number(ms) || 0), interval: interval, intervalMs: Math.max(0, Number(ms) || 0) };
  return id;
};
TimerPool.prototype.setTimeout = function (fn, ms) { return this._add(fn, ms, false); };
TimerPool.prototype.setInterval = function (fn, ms) { return this._add(fn, ms, true); };
TimerPool.prototype.clearTimeout = function (id) { delete this.tasks[id]; };
TimerPool.prototype.clearInterval = function (id) { delete this.tasks[id]; };
TimerPool.prototype.tick = function (ms) {
  var deadline = this._now + (ms >>> 0);
  for (var guard = 0; guard < 100000 && this.tasks; guard += 1) {
    var dueId = null;
    var dueAt = Infinity;
    for (var id in this.tasks) {
      var t = this.tasks[id];
      if (t.at <= this._now && t.at < dueAt) { dueId = id; dueAt = t.at; }
    }
    if (dueId === null || dueAt > deadline) break;
    this._now = dueAt;
    var task = this.tasks[dueId];
    if (task.interval) { task.at = this._now + task.intervalMs; }
    else delete this.tasks[dueId];
    try { task.fn(); } catch (e) { /* handler isolation: one throw never kills the tick */ }
  }
  this._now = deadline;
};
TimerPool.prototype.done = function () { this.tasks = {}; };

/* -------- harness -------- */
function buildDocument(html) {
  var root = parseHtml(html);
  var byId = [];
  var body = null;
  (function walk(el) {
    if (el.id) byId.push(el);
    if (el.tagName === 'BODY') body = el;
    for (var i = 0; i < el.children.length; i += 1) walk(el.children[i]);
  })(root);

  var doc = {};
  doc.body = body;
  doc.getElementById = function (id) {
    for (var j = 0; j < byId.length; j += 1) if (byId[j].id === id) return byId[j];
    return null;
  };
  doc.createElement = function (tag) { return new El(tag, {}); };
  doc.querySelectorAll = function (sel) { return queryAll(root, sel); };
  doc.querySelector = function (sel) { var all = queryAll(root, sel); return all[0] || null; };
  doc.addEventListener = function (type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  };
  doc._listeners = {};
  doc.fireReady = function () {
    var fns = (this._listeners['DOMContentLoaded'] || []).slice();
    for (var j = 0; j < fns.length; j += 1) fns[j].call(null, { type: 'DOMContentLoaded' });
  };
  return doc;
}

function toStorage() {
  var store = {};
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; },
    _dump: function () { return store; },
  };
}

/**
 * Run the real HTML + scripts of a WebView app against a recording native mock.
 * opt: { html, scripts: { "path": "code" }, native: { method: fn } }
 */
function createHarness(opt) {
  opt = opt || {};
  var win = {};
  var doc = buildDocument(opt.html || '<html><head></head><body></body></html>');
  win.document = doc;
  var storage = toStorage();
  var timers = new TimerPool();
  var nativeFns = opt.native || {};
  var recorded = [];

  function runScript(src) {
    var params = ['window', 'document', 'localStorage', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'module'];
    var factory = new Function(params.join(','), src);
    factory.call(win, win, doc, storage,
      function () { return timers.setTimeout.apply(timers, arguments); },
      function () { return timers.clearTimeout.apply(timers, arguments); },
      function () { return timers.setInterval.apply(timers, arguments); },
      function () { return timers.clearInterval.apply(timers, arguments); },
      undefined);
  }

  /* Record-wrapping native bridge, injected BEFORE the app scripts evaluate so
   * bridge.available/running reflect the real device mode. */
  var native = {};
  Object.keys(nativeFns).forEach(function (op) {
    native[op] = function () {
      var args = Array.prototype.slice.call(arguments);
      recorded.push({ op: op, args: args });
      return nativeFns[op].apply(nativeFns, args);
    };
  });
  if (opt.presentNative !== false) win.Android = native;

  var scripts = opt.scripts || {};
  var order = opt.order || Object.keys(scripts);
  for (var s = 0; s < order.length; s += 1) runScript(scripts[order[s]]);

  return {
    win: win,
    document: doc,
    localStorage: storage,
    timers: timers,
    recorded: recorded,
    dir: opt.dir,
    scripts: scripts,
    order: order,
    runScript: runScript,
    ready: function () { doc.fireReady(); },
    tick: function (ms) { timers.tick(ms); },
    byId: function (id) { return doc.getElementById(id); },
    q: function (sel) { return doc.querySelectorAll(sel); },
    textOf: function (id) { var e = doc.getElementById(id); return e ? e.textContent : null; },
    classNameOf: function (id) { var e = doc.getElementById(id); return e ? e.className : null; },
    hasCls: function (id, cls) {
      var e = doc.getElementById(id);
      return !!(e && e.classList.contains(cls));
    },
    tap: function (id) { var e = doc.getElementById(id); if (!e) throw new Error('tap: no #' + id); e.dispatch('click'); },
    tapEl: function (el) { el.dispatch('click'); },
    set: function (id, v) { var e = doc.getElementById(id); if (!e) throw new Error('set: no #' + id); e.value = v; e.dispatch('input'); },
    setChecked: function (id, v) { var e = doc.getElementById(id); if (!e) throw new Error('setChecked: no #' + id); e.checked = !!v; e.dispatch('change'); },
    fire: function (id, type) { var e = doc.getElementById(id); if (!e) throw new Error('fire: no #' + id); e.dispatch(type); },
    toastText: function () { return this.textOf('toast'); },
    toastIsError: function () { return this.hasCls('toast', 'error'); },
    calls: function (op) {
      return recorded.filter(function (c) { return c.op === op; }).map(function (c) { return c.args; });
    },
    allCalls: function () { return recorded.slice(); },
  };
}

module.exports = { createHarness: createHarness, buildDocument: buildDocument, El: El, queryAll: queryAll };