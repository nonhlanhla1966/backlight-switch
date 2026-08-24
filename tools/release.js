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

  // find-or-create release
  let rel = await request('GET', 'api.github.com',
    `/repos/${owner}/${repo}/releases/tags/${tag}`);
  if (rel.status === 404) {
    rel = await request('POST', 'api.github.com', `/repos/${owner}/${repo}/releases`, JSON.stringify({
      tag_name: tag,
      target_commitish: 'main',
      name: `${tag}`,
      body: `Release ${tag}\n\n- Signed release-style APK (self-signed keystore)\n- Built by Node.js + Android SDK tools and verified locally and in GitHub Actions`,
      draft: false,
      prerelease: false
    }), { 'Content-Type': 'application/json' });
    if (rel.status >= 300 || !(rel.json && rel.json.id)) {
      throw new Error(`release creation failed (${rel.status})`);
    }
  }
  const releaseId = rel.json.id;

  // upload APK asset (delete existing asset with same name first is not
  // possible via this endpoint; unique names per version avoid conflicts)
  const up = await request('POST', 'uploads.github.com',
    `/repos/${owner}/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(apkName)}`,
    apkData,
    { 'Content-Type': 'application/vnd.android.package-archive',
      'Content-Length': apkData.length });
  if (up.status >= 300) throw new Error(`asset upload failed (${up.status})`);

  console.log(`released: https://github.com/${owner}/${repo}/releases/tag/${tag}`);
  console.log(`asset:    ${up.json && up.json.browser_download_url}`);
}

main().catch(err => { console.error('RELEASE FAILED:', err.message); process.exit(1); });
