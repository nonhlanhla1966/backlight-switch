#!/usr/bin/env node
/*
 * APK delivery - BUILD SUCCESS is NOT DELIVERY SUCCESS.
 *
 *   node tools/deliver.js [--apk <path>] [--dest <dir>] [--check]
 *
 * Pipeline: FIND -> VERIFY SOURCE -> COPY -> VERIFY DESTINATION -> REPORT.
 * Only prints "APK DELIVERY SUCCESS <path>" after the destination file has
 * been physically verified (exists, readable, size>0, sha256 == source,
 * badging matches, signature verifies). Any failure exits non-zero with the
 * exact reason. --check only probes for a writable public Download dir
 * (exit 3 = none available) so CI hosts can skip delivery tests cleanly.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function findSdk() {
  return process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME || '/opt/android_sdk';
}

function findAapt() {
  const cs = ['/usr/bin/aapt'];
  const bt = path.join(findSdk(), 'build-tools');
  try { for (const v of fs.readdirSync(bt).sort().reverse()) cs.push(path.join(bt, v, 'aapt')); } catch (_) {}
  for (const c of cs) { try { execFileSync(c, ['v'], { stdio: 'ignore' }); return c; } catch (_) {} }
  throw new Error('no usable aapt found');
}

function findJavaHome() {
  if (process.env.JAVA_HOME && fs.existsSync(path.join(process.env.JAVA_HOME, 'bin', 'javac')))
    return process.env.JAVA_HOME;
  const fallback = '/opt/java/jdk1.8.0_212';
  if (fs.existsSync(path.join(fallback, 'bin', 'javac'))) return fallback;
  throw new Error('no JDK found (set JAVA_HOME)');
}

function findApksigner(env) {
  const bt = path.join(findSdk(), 'build-tools');
  for (const v of fs.readdirSync(bt).sort().reverse()) {
    const c = path.join(bt, v, 'apksigner');
    if (fs.existsSync(c)) { try { execFileSync(c, ['--version'], { env, stdio: 'ignore' }); return c; } catch (_) {} }
  }
  throw new Error('no usable apksigner found');
}

function badging(apk) {
  const out = execFileSync(findAapt(), ['dump', 'badging', apk], { encoding: 'utf8' });
  const pkg = (out.match(/package: name='([^']+)'/) || [])[1];
  const vc = (out.match(/versionCode='([^']+)'/) || [])[1];
  const vn = (out.match(/versionName='([^']+)'/) || [])[1];
  if (!pkg || !vc || !vn) throw new Error('cannot parse badging of ' + apk);
  return { pkg, vc, vn };
}

function signatureOk(apk) {
  const env = { ...process.env };
  env.JAVA_HOME = findJavaHome();
  env.PATH = path.join(env.JAVA_HOME, 'bin') + path.delimiter + env.PATH;
  const out = execFileSync(findApksigner(env), ['verify', '--print-certs', apk],
    { encoding: 'utf8', env });
  return (out.match(/Signer #1 certificate DN: (.+)/) || [])[1] || 'verified';
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function writableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const t = path.join(dir, '.opencode-write-test-' + Date.now());
    fs.writeFileSync(t, 'x');
    fs.unlinkSync(t);
    return true;
  } catch (_) { return false; }
}

function downloadDirs() {
  const home = process.env.HOME || '/root';
  const candidates = [
    process.env.OPENCODE_DOWNLOAD_DIR,
    '/storage/emulated/0/Download',
    '/sdcard/Download',
    path.join(home, 'Download'),
    path.join(home, 'storage', 'downloads')
  ].filter(Boolean);
  return [...new Set(candidates)];
}

function fail(msg) { console.error('DELIVERY FAILED: ' + msg); process.exit(1); }

function main() {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };

  // Destination selection (probe before doing any work)
  let destDir = opt('--dest') || downloadDirs().find(writableDir);
  if (!destDir) {
    if (args.includes('--check')) { console.log('NO-WRITABLE-DOWNLOAD'); process.exit(3); }
    fail('no writable Download directory found; tried: ' + downloadDirs().join(', '));
  }

  // [1/6] FIND
  const dist = path.join(ROOT, 'dist');
  const apks = opt('--apk')
    ? [opt('--apk')]
    : (fs.existsSync(dist) ? fs.readdirSync(dist).filter(f => f.endsWith('.apk')) : []);
  if (apks.length !== 1)
    fail('expected exactly one APK in dist/, found: ' + (apks.join(', ') || 'none') +
      '. Run npm run build first.');
  const src = path.resolve(opt('--apk') || path.join(dist, apks[0]));

  if (args.includes('--check')) { console.log('DOWNLOAD-WRITABLE ' + destDir); process.exit(0); }

  console.log('[1/6] found:      ' + src);

  // [2/6] VERIFY SOURCE
  const sb = badging(src);
  const ssig = signatureOk(src);
  const ssha = sha256(src);
  if (fs.statSync(src).size <= 0) fail('source APK is empty');
  console.log(`[2/6] source ok:  ${sb.pkg} v${sb.vn} (${sb.vc}) sig=${ssig.split(',')[0]}`);

  // [3/6] COPY
  const dst = path.join(destDir, path.basename(src));
  try { fs.copyFileSync(src, dst); } catch (e) { fail('copy failed: ' + e.message); }
  try { fs.chmodSync(dst, 0o644); } catch (e) { fail('chmod 644 failed: ' + e.message); }
  console.log('[3/6] copied:     ' + dst + ' (mode 644)');

  // [4/6] VERIFY DESTINATION (physical checks against the copy)
  let st;
  try { st = fs.statSync(dst); } catch (e) { fail('destination missing after copy: ' + e.message); }
  if (st.size !== fs.statSync(src).size)
    fail(`size mismatch: src ${fs.statSync(src).size} vs dst ${st.size}`);
  if (st.size <= 0) fail('destination size is zero');
  let fd; try { fd = fs.openSync(dst, 'r'); fs.closeSync(fd); } catch (e) { fail('destination not readable: ' + e.message); }
  const dsha = sha256(dst);
  if (dsha !== ssha) fail(`sha256 mismatch: src ${ssha} vs dst ${dsha}`);
  console.log(`[4/6] bytes ok:   ${st.size} bytes, sha256 ${dsha.slice(0, 16)}...`);

  // [5/6] VERIFY DESTINATION IDENTITY (badging + signature read FROM destination)
  const db = badging(dst);
  if (db.pkg !== sb.pkg || db.vn !== sb.vn || db.vc !== sb.vc)
    fail(`badging mismatch at destination: ${db.pkg} v${db.vn}(${db.vc})`);
  const dsig = signatureOk(dst);
  if (!dsig) fail('signature not verifiable at destination');
  console.log(`[5/6] ident ok:   ${db.pkg} versionName=${db.vn} versionCode=${db.vc}`);

  // [6/6] Best-effort MediaStore rescan so Downloads UIs see the new file.
  let scan = 'skipped (am unavailable)';
  try {
    execFileSync('am', ['broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE',
      '-d', 'file://' + dst], { stdio: 'ignore', timeout: 10000 });
    scan = 'requested';
  } catch (_) {}
  console.log('[6/6] media scan: ' + scan);

  console.log('APK DELIVERY SUCCESS ' + dst);
}

try { main(); } catch (e) { fail(e.message); }
