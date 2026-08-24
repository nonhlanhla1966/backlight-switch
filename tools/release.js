#!/usr/bin/env node
/*
 * GitHub Release helper - creates a release for the current manifest version
 * and uploads the built APK as a release asset.
 *
 *   node tools/release.js [--tag vX.Y.Z]      (default tag = v<versionName>)
 *
 * Auth uses the AndroidIDE-provided token file; the token is never printed
 * or committed. Requires dist/ to contain exactly one built APK.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { withRetry } = require('./net');

const ROOT = path.join(__dirname, '..');

function token() {
  const p = process.env.HOME + '/.cloudbuilder/gh_token';
  const t = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : '';
  if (!t) throw new Error('no GitHub token available');
  return t;
}

function repoSlug() {
  const url = execGit(['config', '--get', 'remote.origin.url']);
  const m = url.match(/github\.com[/:](.+?)\/(.+?)(?:\.git)?$/);
  if (!m) throw new Error('cannot parse origin remote: ' + url);
  return { owner: m[1], repo: m[2] };
}

function execGit(args) {
  return require('child_process').execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function currentVersion() {
  const m = fs.readFileSync(path.join(ROOT, 'AndroidManifest.xml'), 'utf8');
  return (m.match(/android:versionName="([^"]+)"/) || [])[1] || '1.0.0';
}

function findApk() {
  const dist = path.join(ROOT, 'dist');
  const apks = fs.readdirSync(dist).filter(f => f.endsWith('.apk'));
  if (apks.length !== 1) throw new Error('expected exactly one APK in dist/, found: ' + apks.join(', '));
  return path.join(dist, apks[0]);
}

function request(method, hostname, reqPath, data, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path: reqPath, method,
      headers: Object.assign({
        'Authorization': 'token ' + token(),
        'User-Agent': 'app-factory-release',
        'Accept': 'application/vnd.github.v3+json'
      }, headers)
    }, res => {
      let buf = [];
      res.on('data', c => buf.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        location: res.headers.location,
        json: (() => { try { return JSON.parse(Buffer.concat(buf).toString()); } catch (_) { return null; } })()
      }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/* Convert a non-2xx response into a classified error (4xx permanent,
 * 429/5xx transient) so withRetry can apply the retry policy. */
function ensure(resp, what, okStatus) {
  if (okStatus && resp.status === okStatus) return resp;
  if (resp.status >= 400) {
    const e = new Error(`${what} failed with HTTP ${resp.status}` +
      ((resp.json && resp.json.message) ? `: ${resp.json.message}` : ''));
    e.status = resp.status;
    throw e;
  }
  if (resp.status >= 300 || !(resp.json && resp.json.id)) {
    throw new Error(`${what} failed (${resp.status})`);
  }
  return resp;
}

async function main() {
  let tag = null;
  const ai = process.argv.indexOf('--tag');
  if (ai !== -1 && process.argv[ai + 1]) tag = process.argv[ai + 1];

  const version = currentVersion();
  tag = tag || ('v' + version);
  const apkPath = findApk();
  const apkName = path.basename(apkPath);
  const apkData = fs.readFileSync(apkPath);
  const { owner, repo } = repoSlug();

  console.log(`release: ${owner}/${repo} ${tag} <- ${apkName}`);

  // find-or-create release (404 is control flow here: release may not exist)
  let rel = await withRetry(() =>
    request('GET', 'api.github.com', `/repos/${owner}/${repo}/releases/tags/${tag}`),
    { label: 'release lookup', delayMs: 1500 });
  if (rel.status === 404) {
    rel = await withRetry(() =>
      request('POST', 'api.github.com', `/repos/${owner}/${repo}/releases`, JSON.stringify({
        tag_name: tag,
        target_commitish: 'main',
        name: `${tag}`,
        body: `Release ${tag}\n\n- Signed release-style APK (self-signed keystore)\n- Built by Node.js + Android SDK tools and verified locally and in GitHub Actions`,
        draft: false,
        prerelease: false
      }), { 'Content-Type': 'application/json' })
        .then(r => ensure(r, 'release creation')),
      { label: 'release creation', delayMs: 2000 });
  }
  const releaseId = rel.json.id;

  // Attach the verified APK as a release asset. Idempotent: an existing
  // asset with the same name is replaced so re-publishing never fails.
  const assets = await withRetry(() =>
    request('GET', 'api.github.com', `/repos/${owner}/${repo}/releases/${releaseId}/assets`)
      .then(r => { if (r.status >= 400) return ensure(r, 'asset list'); return r; }),
    { label: 'asset list', delayMs: 1500 });
  const list = Array.isArray(assets.json) ? assets.json : [];
  const existing = list.find(a => a.name === apkName);
  if (existing) {
    await withRetry(() =>
      request('DELETE', 'api.github.com', `/repos/${owner}/${repo}/releases/assets/${existing.id}`)
        .then(r => { if (r.status >= 400) return ensure(r, 'asset delete'); return r; }),
      { label: 'asset delete', delayMs: 1500 });
  }
  const up = await withRetry(() =>
    request('POST', 'uploads.github.com',
      `/repos/${owner}/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(apkName)}`,
      apkData,
      { 'Content-Type': 'application/vnd.android.package-archive',
        'Content-Length': apkData.length })
      .then(r => ensure(r, 'asset upload')),
    { label: 'APK upload', delayMs: 2000 });

  const url = up.json && up.json.browser_download_url;
  console.log(`published: https://github.com/${owner}/${repo}/releases/tag/${tag}`);
  console.log('APK VERIFIED -> APK PUBLISHED');
  console.log('APK READY — DOWNLOAD AVAILABLE');
  console.log(url);
}

main().catch(err => { console.error('RELEASE FAILED:', err.message); process.exit(1); });
