#!/usr/bin/env node
/*
 * Factory multi-model layer - discovery, free-first routing, finite
 * fallback, health tracking, credential safety. Zero dependencies.
 *
 * Models are DISCOVERED from the existing host/OpenCode configuration -
 * never invented here. Cost classes:
 *   free     provably no-cost providers (local runtimes)
 *   unknown  configured via the host session; invoked only through the
 *            pre-existing `opencode` CLI so no new credentials are added
 *   paid     commercial providers; NEVER used unless the user explicitly
 *            sets FACTORY_ALLOW_PAID=1 - otherwise we stop and report:
 *            "Paid model/provider would be required."
 *
 * Secrets are never read into the registry, never logged, never prompted.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const Net = require('./net');

const HEALTH_FILE = '.factory-models.json';
const ROLES = ['design', 'coding', 'debug', 'test', 'review'];

/* ---------- secret safety ---------- */

const SECRET_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9]{16,}/g,
  /sk-[A-Za-z0-9_-]{8,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /(api[_-]?key|token|secret|password|passwd|authorization)\s*[:=]\s*\S+/gi
];

function redact(text) {
  let out = String(text || '');
  SECRET_PATTERNS.forEach(p => { out = out.replace(p, '[REDACTED]'); });
  return out;
}

function isSecretKeyName(key) {
  return /key|token|secret|password|passwd|auth|credential/i.test(String(key));
}

/* ---------- discovery ---------- */

const FREE_PROVIDER = /(ollama|lm ?studio|llama\.cpp|llamacpp|vllm|jan|gpt4all|local)/i;
const PAID_PROVIDER = /(openai|anthropic|google|gemini|azure|mistral|xai|groq|cohere|together|openrouter|deepseek|perplexity)/i;

function classifyProvider(ref) {
  const provider = String(ref).split('/')[0] || '';
  if (FREE_PROVIDER.test(provider)) return 'free';
  if (PAID_PROVIDER.test(provider)) return 'paid';
  return 'unknown';
}

/* Walk config JSON collecting values that look like provider/model refs.
 * Keys that look like secrets are skipped entirely (values never read). */
function collectRefs(node, out, depth) {
  if (out.length > 64 || depth > 6 || !node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (isSecretKeyName(k)) continue;
    if (typeof v === 'string') {
      if (/^[\w.-]+\/[\w.-]+$/.test(v) && !/\s/.test(v)) out.push(v);
    } else if (typeof v === 'object') {
      collectRefs(v, out, depth + 1);
    }
  }
}

function parseMaybeJsonc(text) {
  try { return JSON.parse(text); } catch (_) { /* fall through */ }
  try {
    return JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''));
  } catch (_) { return null; }
}

/**
 * Discover available models from host configuration.
 * Sources: OPENCODE_MODELS env (explicit override), OpenCode config files.
 * Returns { runtime, models:[{ref,provider,cost}], note }.
 */
function discover(env, home) {
  env = env || process.env;
  home = home || process.env.HOME || '';
  const refs = [];
  const sources = [];

  if (env.OPENCODE_MODELS) {
    env.OPENCODE_MODELS.split(',').map(s => s.trim()).filter(Boolean)
      .forEach(r => refs.push(r));
    sources.push('env:OPENCODE_MODELS');
  }
  const cfgPaths = [
    path.join(home, '.config', 'opencode', 'opencode.json'),
    path.join(home, '.config', 'opencode', 'opencode.jsonc'),
    path.join(home, '.config', 'opencode', 'config.json')
  ];
  for (const p of cfgPaths) {
    if (!fs.existsSync(p)) continue;
    const cfg = parseMaybeJsonc(fs.readFileSync(p, 'utf8'));
    if (cfg) { collectRefs(cfg, refs, 0); sources.push(path.basename(p)); }
  }

  /* runtime detection: can we actually invoke anything? */
  let runtime = null;
  const pathDirs = (env.PATH || '').split(path.delimiter);
  for (const d of pathDirs) {
    try { if (fs.existsSync(path.join(d, 'opencode'))) { runtime = 'opencode-cli'; break; } }
    catch (_) { /* unreadable PATH entry */ }
  }

  const seen = new Set();
  const models = refs.filter(r => !seen.has(r) && seen.add(r)).map(ref => ({
    ref, provider: ref.split('/')[0], cost: classifyProvider(ref)
  }));

  let note = null;
  if (!models.length) note = 'no models found in host configuration';
  else if (!runtime && models.some(m => m.cost !== 'free')) {
    note = 'models configured but no invokable runtime found (opencode CLI missing)';
  }
  return { runtime, models, sources, note };
}

/* ---------- health ---------- */

function healthFile(root) { return path.join(root || process.cwd(), HEALTH_FILE); }

function loadHealth(root) {
  const f = healthFile(root);
  if (fs.existsSync(f)) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')) || {}; } catch (_) { return {}; }
  }
  return {};
}
function saveHealth(root, h) {
  const tmp = healthFile(root) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(h, null, 2));
  fs.renameSync(tmp, healthFile(root));
}
function record(h, ref, kind, ms) {
  const e = h[ref] || (h[ref] = { ok: 0, fail: 0, byKind: {}, avgMs: 0, samples: 0,
    lastFailAt: null, cooldownUntil: null });
  if (kind === 'ok') {
    e.ok++;
    e.avgMs = Math.round((e.avgMs * e.samples + (ms || 0)) / (e.samples + 1));
    e.samples++;
    e.cooldownUntil = null;                       /* one success forgives */
  } else {
    e.fail++;
    e.byKind[kind] = (e.byKind[kind] || 0) + 1;
    e.lastFailAt = new Date().toISOString();
    if (e.fail - e.ok >= 2) {                     /* repeated failures only */
      e.cooldownUntil = Date.now() + 10 * 60 * 1000; /* deprioritize 10 min */
    }
  }
  return e;
}

/* ---------- routing ---------- */

/**
 * Ordered candidate list for a task.
 * cost order: free < unknown (paid excluded unless explicitly allowed);
 * health-adjusted: active-cooldown models sink; better scores rise.
 */
function route(registry, opts) {
  const o = opts || {};
  const allowPaid = o.allowPaid === true;
  const health = o.health || {};
  let pool = registry.models.filter(m => m.cost !== 'paid' || allowPaid);
  if (!pool.length) {
    throw new Error('Paid model/provider would be required. ' +
      'No free/no-cost model is configured; set FACTORY_ALLOW_PAID=1 to authorize paid use explicitly.');
  }
  const now = Date.now();
  const score = m => {
    const h = health[m.ref];
    const cooling = h && h.cooldownUntil && now < h.cooldownUntil ? 1 : 0;
    const s = h ? h.ok / (h.ok + h.fail) : 0.5;
    return cooling * 100 + (1 - s); /* lower is better */
  };
  const rank = m => (m.cost === 'free' ? 0 : 1) + score(m) / 10;
  return pool.slice().sort((a, b) => rank(a) - rank(b));
}

/* ---------- invocation with fallback ---------- */

const FAILURE_KINDS = ['timeout', 'unavailable', 'ratelimit', 'invalid'];

function kindOf(err) {
  const msg = String((err && err.message) || err);
  if (err && err.kind && FAILURE_KINDS.includes(err.kind)) return err.kind;
  if (/timed?\s?out|ETIMEDOUT/i.test(msg)) return 'timeout';
  if (/rate.?limit|429/i.test(msg)) return 'ratelimit';
  if (/ENOENT|not found|unavailable|ECONNREFUSED|command not found/i.test(msg)) return 'unavailable';
  return 'invalid';
}

/** Default invoker: pre-existing opencode CLI under the user's own auth. */
function cliInvoker(timeoutMs) {
  return (ref, prompt) => new Promise((resolve, reject) => {
    const child = spawn('opencode', ['run', '--model', ref, prompt],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', errOut = '';
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Object.assign(new Error('model timed out'), { kind: 'timeout' }));
    }, timeoutMs || 120000);
    child.stdout.on('data', c => out += c);
    child.stderr.on('data', c => errOut += c);
    child.on('error', e => { clearTimeout(t); reject(e); });
    child.on('close', code => {
      clearTimeout(t);
      if (code === 0 && out.trim()) resolve(out);
      else reject(new Error(redact(`opencode exit ${code}: ${errOut || 'empty output'}`)));
    });
  });
}

/**
 * Run a task through routed models with finite fallback.
 * opts: { role, prompt, registry, health, root, invoker, attemptsPerModel,
 *         maxModels, validate(text)->true|string-error, allowPaid }
 * Returns { text, model, attempts, tried:[{ref,kind}] } or throws
 * MODEL_EXHAUSTED error listing every failure (redacted).
 */
async function invoke(task, opts) {
  const o = opts || {};
  const candidates = route(o.registry, { health: o.health, allowPaid: o.allowPaid })
    .slice(0, o.maxModels || 5);
  const perModel = Math.max(1, Math.min(2, o.attemptsPerModel || 1));
  const invoker = o.invoker || cliInvoker();
  const validate = o.validate || (t => (t && String(t).trim()) ? true : 'empty output');
  const tried = [];

  for (const model of candidates) {
    for (let a = 1; a <= perModel; a++) {
      const started = Date.now();
      try {
        const text = await invoker(model.ref, task.prompt, task);
        const verdict = validate(text);
        if (verdict !== true) throw Object.assign(new Error('invalid output: ' + verdict),
          { kind: 'invalid' });
        record(o.health, model.ref, 'ok', Date.now() - started);
        if (o.root) saveHealth(o.root, o.health);
        return { text, model: model.ref, attempts: tried.length + 1, tried };
      } catch (err) {
        const kind = kindOf(err);
        record(o.health, model.ref, kind, Date.now() - started);
        tried.push({ ref: model.ref, kind });
        console.log(`MODEL FALLBACK\nPrevious: ${model.ref} (${redact(kind)})\n` +
          `Next: ${candidates[candidates.indexOf(model) + 1] ?
            candidates[candidates.indexOf(model) + 1].ref : 'none left'}`);
        if (o.root) saveHealth(o.root, o.health);
        if (kind === 'invalid' && a < perModel) continue; /* one retry for flaky output */
        break;                                            /* hard fail -> next model */
      }
    }
  }
  const summary = tried.map(t => `${t.ref}:${t.kind}`).join(', ') || 'no candidates';
  const e = new Error(`MODEL_EXHAUSTED after ${tried.length} attempt(s): ${summary}`);
  e.tried = tried;
  throw e;
}

module.exports = { discover, classifyProvider, route, invoke, redact, kindOf,
  loadHealth, saveHealth, record, cliInvoker, healthFile, HEALTH_FILE, ROLES };
