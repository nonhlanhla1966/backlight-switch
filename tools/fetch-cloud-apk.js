#!/usr/bin/env node
/*
 * Cloud-first final build - wait for GitHub Actions to build the CURRENT
 * commit, download the APK artifact and verify it into dist/.
 *
 *   node tools/fetch-cloud-apk.js [--timeout <seconds>]
 *
 * The final delivered APK should come from here, not from repeated local
 * builds (thermal-safe policy). Verification: badging readable, package
 * matches this project, versionName matches manifest, signature valid.
 * Exit codes: 0 ok | 1 error | 2 Actions run failed | 3 timed out waiting.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function token() {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_PAT;
  if (fromEnv) return fromEnv.trim();
  const p = process.env.HOME + '/.cloudbuilder/gh_token';
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  throw new Error('no GitHub token (set GITHUB_TOKEN or provide ~/.cloudbuilder/gh_token)');
}

function repoSlug() {
  const url = execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const m = url.match(/github\.com[/:](.+?)\/(.+?)(?:\.git)?$/);
  if (!m) throw new Error('cannot parse origin remote: ' + url);
  return { owner: m[1], repo: m[2] };
}

function headSha() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
}

function api(reqPath) {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: 'api.github.com', path: reqPath,
      headers: {
        'Authorization': 'token ' + token(),
        'User-Agent': 'app-factory-cloud-build',
        'Accept': 'application/vnd.github.v3+json'
      }
    }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(b); } catch (_) { return null; } })() }));
    }).on('error', reject);
  });
}

/* Artifact archives redirect to Azure which REJECTS a forwarded auth header:
 * authenticate on the first hop only, then follow redirects anonymously. */
function download(url, auth, depth) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'app-factory-cloud-build' };
    if (auth) headers['Authorization'] = 'token ' + token();
    https.get(url, { headers }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth < 6) {
        res.resume();
        download(res.headers.location, false, depth + 1).then(resolve, reject);
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

/* Minimal ZIP extractor for the single .apk entry in an artifact archive. */
function extractApkFromZip(zip) {
  const eocdSig = 0x06054b50;
  let e = zip.length - 22;
  while (e >= 0 && zip.readUInt32LE(e) !== eocdSig) e--;
  if (e < 0) throw new Error('not a zip archive');
  const count = zip.readUInt16LE(e + 10);
  let off = zip.readUInt32LE(e + 16);
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(off) !== 0x02014b50) throw new Error('bad central directory');
    const method = zip.readUInt16LE(off + 10);
    const csize = zip.readUInt32LE(off + 20);
    const nameLen = zip.readUInt16LE(off + 28);
    const extraLen = zip.readUInt16LE(off + 30);
    const commentLen = zip.readUInt16LE(off + 32);
    const lho = zip.readUInt32LE(off + 42);
    const name = zip.slice(off + 46, off + 46 + nameLen).toString();
    if (/\.apk$/i.test(name)) {
      if (zip.readUInt32LE(lho) !== 0x04034b50) throw new Error('bad local header');
      const nLen = zip.readUInt16LE(lho + 26);
      const xLen = zip.readUInt16LE(lho + 28);
      const dataStart = lho + 30 + nLen + xLen;
      const data = zip.slice(dataStart, dataStart + csize);
      return method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('no .apk entry inside artifact zip');
}

function findSdk() {
  return process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME ||
    ['/opt/android_sdk', '/usr/local/lib/android/sdk'].find(fs.existsSync) || '/opt/android_sdk';
}

function javaEnv() {
  let jh = process.env.JAVA_HOME;
  if (!jh || !fs.existsSync(path.join(jh, 'bin', 'javac'))) {
    jh = ['/opt/java/jdk1.8.0_212', ...(fs.existsSync('/opt/java') ? fs.readdirSync('/opt/java').map(d => '/opt/java/' + d) : []),
      ...(fs.existsSync('/usr/lib/jvm') ? fs.readdirSync('/usr/lib/jvm').map(d => '/usr/lib/jvm/' + d) : [])]
      .find(d => fs.existsSync(path.join(d, 'bin', 'javac')));
  }
  if (!jh) throw new Error('no JDK found (set JAVA_HOME)');
  const env = { ...process.env, JAVA_HOME: jh };
  env.PATH = path.join(jh, 'bin') + path.delimiter + env.PATH;
  return env;
}

function findAapt() {
  const cs = ['/usr/bin/aapt'];
  const bt = path.join(findSdk(), 'build-tools');
  try { for (const v of fs.readdirSync(bt).sort().reverse()) cs.push(path.join(bt, v, 'aapt')); } catch (_) {}
  for (const c of cs) {
    const r = spawnSync(c, ['v'], { stdio: 'ignore' });
    if (!(r.error && typeof r.error.code === 'string' && /ENOENT|EACCES|EFTYPE|EXEC/.test(r.error.code))) return c;
  }
  throw new Error('no usable aapt found');
}

function findApksigner(env) {
  const bt = path.join(findSdk(), 'build-tools');
  for (const v of fs.readdirSync(bt).sort().reverse()) {
    const c = path.join(bt, v, 'apksigner');
    if (fs.existsSync(c)) return c;
  }
  throw new Error('no apksigner found');
}

function expectedIdentity() {
  const strings = fs.readFileSync(path.join(ROOT, 'res', 'values', 'strings.xml'), 'utf8');
  const label = ((strings.match(/<string name="app_name">([^<]+)<\/string>/) || [])[1] || 'App').trim();
  const manifest = fs.readFileSync(path.join(ROOT, 'AndroidManifest.xml'), 'utf8');
  const pkg = (manifest.match(/package="([^"]+)"/) || [])[1];
  const vn = (manifest.match(/android:versionName="([^"]+)"/) || [])[1] || '1.0.0';
  return { label, pkg, vn };
}

async function main() {
  const ai = process.argv.indexOf('--timeout');
  const timeoutMs = ((ai !== -1 && parseInt(process.argv[ai + 1], 10)) ||
    parseInt(process.env.OPENCODE_CLOUD_WAIT_SECONDS || '1800', 10)) * 1000;
  const started = Date.now();
  const { owner, repo } = repoSlug();
  const sha = headSha();
  console.log(`[cloud] waiting for GitHub Actions build of ${sha.slice(0, 7)} on ${owner}/${repo}...`);

  /* 1. Wait for the run of THIS commit to finish. */
  let run = null;
  while (Date.now() - started < timeoutMs) {
    const r = await api(`/repos/${owner}/${repo}/actions/runs?head_sha=${sha}&per_page=10`);
    const runs = (r.json && r.json.workflow_runs) || [];
    run = runs.find(x => x.head_sha === sha) || null;
    if (run && run.status === 'completed') break;
    if (!run) {
      // Trigger nothing - pushes auto-trigger. Just keep polling briefly.
      process.stdout.write('[cloud] no run seen yet; polling...\n');
    }
    await new Promise(res => setTimeout(res, 20000));
  }
  if (!run || run.status !== 'completed')
    { console.error(`CLOUD BUILD TIMEOUT after ${Math.round((Date.now() - started) / 1000)}s`); process.exit(3); }
  if (run.conclusion !== 'success') {
    console.error(`CLOUD BUILD FAILED (${run.conclusion}): inspect logs at ${run.html_url}`);
    console.error('Fix the source (max 3 automatic repair attempts), push again; use a local build only to diagnose.');
    process.exit(2);
  }
  console.log(`[cloud] run ${run.id} succeeded (${run.html_url})`);

  /* 2. Find the APK artifact of that run. */
  const arts = await api(`/repos/${owner}/${repo}/actions/runs/${run.id}/artifacts`);
  const artifact = ((arts.json && arts.json.artifacts) || []).find(a => /\.apk$|apk/i.test(a.name)) ||
    ((arts.json && arts.json.artifacts) || [])[0];
  if (!artifact) throw new Error('no artifact uploaded by the successful run');
  console.log(`[cloud] artifact: ${artifact.name} (${artifact.size_in_bytes} bytes)`);

  /* 3. Download + extract. */
  const z = await download(artifact.archive_download_url, true, 0);
  if (z.status !== 200) throw new Error('artifact download failed with HTTP ' + z.status);
  const apk = extractApkFromZip(z.buf);

  /* 4. Verify the cloud APK before trusting it. */
  const tmpZip = path.join(ROOT, 'dist', '.cloud-artifact.zip');
  fs.mkdirSync(path.dirname(tmpZip), { recursive: true });
  fs.writeFileSync(tmpZip, z.buf);
  const id = expectedIdentity();

  const distDir = path.join(ROOT, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  for (const f of fs.readdirSync(distDir)) if (f.endsWith('.apk')) fs.unlinkSync(path.join(distDir, f));
  const apkPath = path.join(distDir, `${id.label}-v${id.vn}.apk`);
  fs.writeFileSync(apkPath, apk);

  const badging = execFileSync(findAapt(), ['dump', 'badging', apkPath], { encoding: 'utf8' });
  if (!badging.includes(`package: name='${id.pkg}'`))
    throw new Error(`cloud APK package mismatch (expected ${id.pkg})`);
  if (!badging.includes(`versionName='${id.vn}'`))
    throw new Error(`cloud APK version mismatch (expected ${id.vn})`);
  if (badging.includes('uses-permission'))
    throw new Error('cloud APK unexpectedly requests permissions');
  const certs = execFileSync(findApksigner(javaEnv()), ['verify', '--print-certs', apkPath],
    { encoding: 'utf8', env: javaEnv() });
  const dn = (certs.match(/Signer #1 certificate DN: (.+)/) || [])[1];
  if (!dn) throw new Error('cloud APK signature not verifiable');

  fs.unlinkSync(tmpZip);
  console.log(`[cloud] verified: ${id.pkg} v${id.vn}, sig ${dn}`);
  console.log('CLOUD APK READY ' + apkPath);
}

main().catch(err => { console.error('CLOUD FETCH FAILED:', err.message); process.exit(1); });
