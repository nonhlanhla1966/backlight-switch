#!/usr/bin/env node
/*
 * Factory network resilience - shared retry policy (zero dependencies).
 *
 * withRetry(op, opts) runs op() up to MAX_ATTEMPTS (3) times:
 *   - transient failures (DNS, connection reset/refused, timeout, TLS or
 *     certificate verification errors, HTTP 429 and 5xx) are retried after
 *     a short increasing delay, with a best-effort DNS/connectivity re-check;
 *   - permanent failures (invalid credentials 401/403, not found 404,
 *     malformed request 400/422, and anything marked err.permanent)
 *     fail immediately with a clear explanation and are NEVER retried;
 *   - TLS certificate verification is never disabled anywhere: no insecure
 *     flags, no rejectUnauthorized:false. Certificate errors are retried
 *     over the normal secure HTTPS connection only.
 *
 * Final failure throws: "FAILED AFTER 3 ATTEMPTS — <exact original error>".
 */
'use strict';

const dns = require('dns');

const MAX_ATTEMPTS = 3;

const TRANSIENT_CODES = /^(EAI_AGAIN|EAI_FAIL|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|EHOSTUNREACH|ENETUNREACH|EADDRINUSE|UND_ERR_SOCKET)$/;

/* Certificate/TLS problems are potentially transient (proxy/middlebox
 * hiccups): retried securely, never worked around or bypassed. */
const CERT_PATTERN = /certificate|cert.*(invalid|expire|verify)|self[- ]signed|unable to verify|\btls\b|\bssl\b|handshake/i;

const PERMANENT_STATUS = new Set([400, 401, 402, 403, 404, 405, 410, 422, 451]);

function classify(err) {
  if (!err) return 'transient';
  if (err.permanent === true) return 'permanent';
  if (err.permanent === false) return 'transient';
  const status = err.status || err.statusCode || (err.response && err.response.status);
  if (status === 429 || (typeof status === 'number' && status >= 500)) return 'transient';
  if (typeof status === 'number' && PERMANENT_STATUS.has(status)) return 'permanent';
  const code = err.code || '';
  if (TRANSIENT_CODES.test(code)) return 'transient';
  if (/^(ENOSPC|EACCES|EPERM)$/.test(code)) return 'permanent';
  const msg = String(err.message || err);
  if (CERT_PATTERN.test(msg)) return 'transient';
  return 'transient'; /* bounded by the attempt cap anyway */
}

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

/* Best-effort connectivity re-check so retries do not hammer a dead link. */
function probe(host) {
  return new Promise(res => {
    try { dns.lookup(host || 'api.github.com', err => res(!err)); }
    catch (_) { res(false); }
  });
}

function describe(err) {
  if (!err) return 'unknown error';
  const status = err.status || err.statusCode;
  return (status ? `HTTP ${status} ` : '') + String(err.message || err).slice(0, 300);
}

/**
 * Run op(attempt) under the factory retry policy. op may be synchronous
 * (return value / throw) or asynchronous (promise). Options:
 *   attempts  max tries, capped at 3 (default 3)
 *   delayMs   base delay, multiplied by attempt number (default 1500)
 *   probeHost host re-checked via DNS between attempts (default api.github.com)
 *   label     human-readable operation name for logs
 */
async function withRetry(op, opts) {
  const o = opts || {};
  const attempts = Math.max(1, Math.min(MAX_ATTEMPTS, o.attempts || MAX_ATTEMPTS));
  const delayMs = typeof o.delayMs === 'number' ? o.delayMs : 1500;
  const label = o.label || 'operation';
  let lastErr = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let result;
    try {
      result = op(attempt);
    } catch (err) {
      lastErr = err;
      if (classify(err) === 'permanent') break;
      if (attempt < attempts) {
        console.log(`[retry] ${label}: attempt ${attempt}/${attempts} failed ` +
          `(${describe(err)}); stopping cleanly, then retrying securely`);
        await sleep(delayMs * attempt);
        await probe(o.probeHost);
      }
      continue;
    }
    if (result && typeof result.then === 'function') {
      try {
        return await result; /* success: continue workflow automatically */
      } catch (err) {
        lastErr = err;
        if (classify(err) === 'permanent') break;
        if (attempt < attempts) {
          console.log(`[retry] ${label}: attempt ${attempt}/${attempts} failed ` +
            `(${describe(err)}); stopping cleanly, then retrying securely`);
          await sleep(delayMs * attempt);
          await probe(o.probeHost);
        }
        continue;
      }
    }
    return result;
  }

  if (lastErr && classify(lastErr) === 'permanent') {
    const e = new Error(`PERMANENT FAILURE in ${label} (not retried): ${describe(lastErr)}`);
    e.cause = lastErr;
    e.permanent = true;
    e.status = lastErr.status || lastErr.statusCode;
    throw e;
  }
  const e = new Error(`FAILED AFTER ${attempts} ATTEMPTS — ${describe(lastErr)}`);
  e.cause = lastErr;
  e.status = lastErr && (lastErr.status || lastErr.statusCode);
  throw e;
}

module.exports = { withRetry, classify, probe, sleep, describe, MAX_ATTEMPTS };
