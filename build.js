#!/usr/bin/env node
/*
 * Simple Calculator - APK build orchestrator.
 *
 * Drives the Android SDK command-line tools directly (no Gradle):
 *   aapt      -> compile resources + generate R.java + package resources/assets
 *   javac     -> compile Java sources against android.jar
 *   d8        -> dex the compiled classes
 *   zipalign  -> align the uncompressed APK
 *   apksigner -> sign the final APK
 *
 * Zero npm dependencies. Node >= 14.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const BUILD = path.join(ROOT, 'build');
const DIST = path.join(ROOT, 'dist');

/* App identity is read from the manifest/strings - no duplicate config. */
function readManifest() {
  return fs.readFileSync(path.join(ROOT, 'AndroidManifest.xml'), 'utf8');
}
function manifestAttr(manifest, attr) {
  const m = manifest.match(new RegExp(`android:${attr}="([^"]+)"`));
  return m ? m[1] : null;
}
function appSlug() {
  const strings = fs.readFileSync(path.join(ROOT, 'res', 'values', 'strings.xml'), 'utf8');
  const label = (strings.match(/<string name="app_name">([^<]+)<\/string>/) || [])[1] || 'App';
  return label.trim().replace(/[^\w\s-]/g, '').replace(/[\s_]+/g, '-');
}

function appLabel() {
  const strings = fs.readFileSync(path.join(ROOT, 'res', 'values', 'strings.xml'), 'utf8');
  return ((strings.match(/<string name="app_name">([^<]+)<\/string>/) || [])[1] || 'App').trim();
}

const MANIFEST = readManifest();
const APP_NAME = manifestAttr(MANIFEST, 'versionName') ? appSlug() : 'App';
const VERSION_NAME = manifestAttr(MANIFEST, 'versionName') || '1.0.0';
const APK_NAME = `${APP_NAME}-v${VERSION_NAME}.apk`;

/* ------------------------------------------------------------------ */
/* Thermal-safe cloud-first policy                                     */
/* ------------------------------------------------------------------ */
/* GitHub Actions is the default builder for FINAL APKs. A local build  */
/* is for fast feedback/diagnosis only: never two at once, and it must  */
/* abort cleanly on an excessive wall clock instead of heating the      */
/* phone. Android thermal management is never bypassed.                 */

const LOCK_PATH = path.join(os.tmpdir(), 'appfactory-android-build.lock');
const LOCAL_BUILD_TIMEOUT_MS =
  parseInt(process.env.OPENCODE_LOCAL_BUILD_TIMEOUT || '900', 10) * 1000;
const BUILD_T0 = Date.now();

function readLock() {
  try { return JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8')); } catch (_) { return {}; }
}

function lockHolderAlive(info) {
  if (!info || !info.pid || info.pid === process.pid) return false;
  try { process.kill(info.pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

function acquireBuildLock(waitMs) {
  const deadline = Date.now() + waitMs;
  let announced = false;
  for (;;) {
    let fd;
    try {
      fd = fs.openSync(LOCK_PATH, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, t: Date.now(), app: APP_NAME }));
      fs.closeSync(fd);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const info = readLock();
      const stale = !info.t || (Date.now() - info.t) > 45 * 60 * 1000;
      if (!lockHolderAlive(info) || stale) {
        // Holder is dead or ancient - safe to take over.
        try { fs.unlinkSync(LOCK_PATH); } catch (_) {}
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error('another factory Android build is already running (pid ' +
          info.pid + ', started ' + Math.round((Date.now() - info.t) / 1000) +
          's ago). Never run two heavy builds simultaneously - wait for it or reuse its result.');
      }
      if (!announced) {
        console.log('[lock] another factory build is active (pid ' + info.pid + '); waiting - single-build rule.');
        announced = true;
      }
      try { execFileSync('sleep', ['5']); } catch (_) {}
    }
  }
}

function releaseBuildLock() {
  const info = readLock();
  if (info && info.pid === process.pid) { try { fs.unlinkSync(LOCK_PATH); } catch (_) {} }
}

/* ------------------------------------------------------------------ */
/* Toolchain discovery                                                 */
/* ------------------------------------------------------------------ */

function firstExisting(paths) {
  for (const p of paths) {
    try {
      fs.accessSync(p);
      return p;
    } catch (_) { /* keep looking */ }
  }
  return null;
}

function findJavaHome() {
  const fromEnv = process.env.JAVA_HOME;
  if (fromEnv && fs.existsSync(path.join(fromEnv, 'bin', 'javac'))) return fromEnv;
  const candidates = [
    '/opt/java/jdk1.8.0_212',
    ...fs.readdirSync('/opt/java').filter(d => /^jdk/.test(d)).map(d => path.join('/opt/java', d)),
    ...safeReaddir('/usr/lib/jvm').map(d => path.join('/usr/lib/jvm', d))
  ];
  const found = firstExisting(candidates.map(j => j));
  return found && fs.existsSync(path.join(found, 'bin', 'javac')) ? found : null;
}

function safeReaddir(dir) {
  try { return fs.readdirSync(dir); } catch (_) { return []; }
}

function findSdk() {
  const candidates = [
    process.env.ANDROID_SDK_ROOT,
    process.env.ANDROID_HOME,
    '/opt/android_sdk',
    '/usr/local/lib/android/sdk',
    path.join(process.env.HOME || '', 'Android', 'Sdk')
  ].filter(Boolean);
  const sdk = firstExisting(candidates);
  if (!sdk) throw new Error('Android SDK not found. Set ANDROID_SDK_ROOT.');
  return sdk;
}

function pickBuildTools(sdk) {
  const btDir = path.join(sdk, 'build-tools');
  const versions = safeReaddir(btDir)
    .filter(v => /^\d+(\.\d+)*$/.test(v))
    .sort((a, b) => Number(b.split('.')[0]) - Number(a.split('.')[0]) || Number(b.split('.')[1] || 0) - Number(a.split('.')[1] || 0));
  for (const v of versions) {
    const dir = path.join(btDir, v);
    // d8/apksigner are Java launchers - they must exist; native binaries are
    // probed individually later (some SDK builds are x86-64-only).
    if (fs.existsSync(path.join(dir, 'd8')) && fs.existsSync(path.join(dir, 'apksigner'))) return dir;
  }
  throw new Error('No suitable build-tools directory found in ' + btDir);
}

/* Probe whether a binary actually executes on this host (arch-safe). */
function binaryWorks(cmd, args) {
  const r = require('child_process').spawnSync(cmd, args, { stdio: 'ignore', timeout: 15000 });
  // ENOENT/EACCES-style errors mean the binary cannot run on this host;
  // any real exit status (even non-zero) proves it executed.
  return !(r.error && typeof r.error.code === 'string' && /ENOENT|EACCES|EFTYPE|EXEC/.test(r.error.code));
}

/* Pick the first candidate binary that actually runs. */
function resolveNativeTool(candidates, probeArgs) {
  for (const c of candidates) {
    if (c && fs.existsSync(c) && binaryWorks(c, probeArgs)) return c;
  }
  return null;
}

function pickPlatform(sdk) {
  const platDir = path.join(sdk, 'platforms');
  const plats = safeReaddir(platDir)
    .filter(p => /^android-\d+$/.test(p))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const p of plats) {
    const jar = path.join(platDir, p, 'android.jar');
    if (fs.existsSync(jar)) return jar;
  }
  throw new Error('No android.jar platform found in ' + platDir);
}

/* ------------------------------------------------------------------ */
/* Command runner                                                      */
/* ------------------------------------------------------------------ */

function run(cmd, args, opts) {
  const elapsed = Date.now() - BUILD_T0;
  if (elapsed > LOCAL_BUILD_TIMEOUT_MS) {
    throw new Error('LOCAL BUILD ABORTED after ' + Math.round(elapsed / 1000) +
      's (limit ' + Math.round(LOCAL_BUILD_TIMEOUT_MS / 1000) + 's). Thermal/resource protection: ' +
      'do not immediately retry the identical build - push this state and let GitHub Actions perform the final build.');
  }
  console.log('  $ ' + cmd + ' ' + args.map(a => /[\s"]/.test(a) ? JSON.stringify(a) : a).join(' '));
  execFileSync(cmd, args, Object.assign({ stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' }, opts));
}

/* ------------------------------------------------------------------ */
/* Build steps                                                         */
/* ------------------------------------------------------------------ */

function ensureKeystore(javaHome, keystore) {
  // Stable keystore location (keys/ is gitignored): once generated it is
  // reused so release signatures stay consistent across builds.
  if (fs.existsSync(keystore)) return;
  fs.mkdirSync(path.dirname(keystore), { recursive: true });
  const keytool = path.join(javaHome, 'bin', 'keytool');
  run(keytool, [
    '-genkeypair', '-v',
    '-keystore', keystore,
    '-storepass', 'android', '-keypass', 'android',
    '-alias', 'simplecalc',
    '-keyalg', 'RSA', '-keysize', '2048',
    '-validity', '10000',
    '-dname', `CN=${appLabel()},O=AppFactory,C=US`
  ]);
}

function main() {
  console.log('[cloud-first] GitHub Actions builds the FINAL APK; this local build is for fast feedback/diagnosis only.');
  const javaHome = findJavaHome();
  if (!javaHome) throw new Error('JDK not found. Set JAVA_HOME.');
  const sdk = findSdk();
  const buildTools = pickBuildTools(sdk);
  const androidJar = pickPlatform(sdk);

  const env = Object.assign({}, process.env);
  env.JAVA_HOME = javaHome;
  env.PATH = path.join(javaHome, 'bin') + path.delimiter + env.PATH;

  // aapt: prefer the SDK copy, fall back to a distro/native build
  // (SDK binaries are sometimes x86-64-only and cannot run on this host).
  const AAPT = resolveNativeTool([
    path.join(buildTools, 'aapt'),
    '/usr/bin/aapt',
    '/usr/lib/android-sdk/build-tools/debian/aapt'
  ], ['v']);
  if (!AAPT) throw new Error('No runnable aapt found');

  const D8 = path.join(buildTools, 'd8');
  const APKSIGNER = path.join(buildTools, 'apksigner');
  // zipalign: use the SDK binary when it can run, otherwise the pure-Node
  // replacement in tools/zipalign.js (same alignment semantics).
  const sdkZipalign = resolveNativeTool([path.join(buildTools, 'zipalign')], ['-h', '1']);
  const ZIPALIGN_MODE = sdkZipalign ? 'sdk' : 'node';

  console.log(`== ${APP_NAME} v${VERSION_NAME} build ==`);
  console.log(`APK         : ${APK_NAME}`);
  console.log(`JAVA_HOME   : ${javaHome}`);
  console.log(`SDK         : ${sdk}`);
  console.log(`build-tools : ${path.basename(buildTools)}`);
  console.log(`platform    : ${path.basename(path.dirname(androidJar))}`);
  console.log(`aapt        : ${AAPT}`);
  console.log(`zipalign    : ${ZIPALIGN_MODE === 'sdk' ? sdkZipalign : 'tools/zipalign.js (node)'}`);

  // 0. fresh output dirs + generated assets (icons are source-controlled,
  //    but regenerate if missing so the build is self-healing)
  fs.rmSync(BUILD, { recursive: true, force: true });
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(BUILD, { recursive: true });
  fs.mkdirSync(DIST, { recursive: true });
  fs.mkdirSync(path.join(BUILD, 'gen'), { recursive: true });
  fs.mkdirSync(path.join(BUILD, 'classes'), { recursive: true });
  fs.mkdirSync(path.join(BUILD, 'obj'), { recursive: true });

  const iconDirs = safeReaddir(path.join(ROOT, 'res')).filter(d => d.startsWith('mipmap-'));
  if (!iconDirs.length) {
    console.log('Icons missing - regenerating...');
    run(process.execPath, [path.join(ROOT, 'tools', 'genicons.js')]);
  }

  // 1. Generate R.java from resources
  console.log('\n[1/7] Generating R.java (aapt)');
  run(AAPT, [
    'package', '-f', '-m',
    '-J', path.join(BUILD, 'gen'),
    '-M', path.join(ROOT, 'AndroidManifest.xml'),
    '-S', path.join(ROOT, 'res'),
    '-I', androidJar
  ], { env });

  // 2. Compile Java sources
  console.log('[2/7] Compiling Java (javac)');
  const javac = path.join(javaHome, 'bin', 'javac');
  const sources = [];
  collectFiles(path.join(BUILD, 'gen'), '.java', sources);
  collectFiles(path.join(ROOT, 'src'), '.java', sources);
  run(javac, [
    '-source', '1.8', '-target', '1.8',
    '-encoding', 'UTF-8',
    '-bootclasspath', androidJar,
    '-classpath', androidJar,
    '-d', path.join(BUILD, 'classes'),
    '-Xlint:-options',
    ...sources
  ], { env });

  // 3. Dex
  console.log('[3/7] Dexing classes (d8)');
  const classFiles = [];
  collectFiles(path.join(BUILD, 'classes'), '.class', classFiles);
  run(D8, [
    '--release',
    '--lib', androidJar,
    '--output', path.join(BUILD, 'obj'),
    ...classFiles
  ], { env });
  const dexFile = path.join(BUILD, 'obj', 'classes.dex');
  if (!fs.existsSync(dexFile)) throw new Error('d8 did not produce classes.dex');

  // 4. Package resources + assets
  console.log('[4/7] Packaging resources & assets (aapt)');
  const unsigned = path.join(BUILD, 'unsigned-unaligned.apk');
  run(AAPT, [
    'package', '-f',
    '-M', path.join(ROOT, 'AndroidManifest.xml'),
    '-S', path.join(ROOT, 'res'),
    '-A', path.join(ROOT, 'www'),
    '-I', androidJar,
    '-F', unsigned
  ], { env });

  // 5. Add classes.dex into the APK
  console.log('[5/7] Adding classes.dex to APK (aapt)');
  fs.copyFileSync(dexFile, path.join(BUILD, 'classes.dex'));
  run(AAPT, ['add', unsigned, 'classes.dex'], { env, cwd: BUILD });

  // 6. Align
  console.log('[6/7] Zipaligning APK');
  const aligned = path.join(BUILD, `${APK_NAME}.aligned`);
  if (ZIPALIGN_MODE === 'sdk') {
    run(sdkZipalign, ['-f', '4', unsigned, aligned], { env });
  } else {
    run(process.execPath, [path.join(ROOT, 'tools', 'zipalign.js'), unsigned, aligned], { env });
  }

  // 7. Sign (stable release keystore kept outside build/ so it survives clean)
  console.log('[7/7] Signing APK (apksigner)');
  const keystore = path.join(ROOT, 'keys', 'release.keystore');
  ensureKeystore(javaHome, keystore);
  const apkOut = path.join(DIST, APK_NAME);
  run(APKSIGNER, [
    'sign',
    '--ks', keystore,
    '--ks-pass', 'pass:android',
    '--ks-key-alias', 'simplecalc',
    '--out', apkOut,
    aligned
  ], { env });

  // Verify signature as part of the build
  const verify = execFileSync(APKSIGNER, ['verify', '--print-certs', apkOut], { env, encoding: 'utf8' });
  console.log('\nSignature verified:\n' + verify.trim().split('\n').slice(0, 3).join('\n'));

  // Copy to device Download folder when running on-device
  const downloadDir = '/storage/emulated/0/Download';
  if (fs.existsSync(downloadDir)) {
    try {
      fs.copyFileSync(apkOut, path.join(downloadDir, APK_NAME));
      console.log(`Copied to ${downloadDir}/${APK_NAME}`);
    } catch (e) {
      console.warn(`Warning: could not copy to ${downloadDir}: ${e.message}`);
    }
  }

  const size = fs.statSync(apkOut).size;
  console.log(`\nBUILD OK -> ${apkOut} (${(size / 1024).toFixed(1)} KB)`);
}

function collectFiles(dir, ext, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, ext, out);
    else if (entry.name.endsWith(ext)) out.push(full);
  }
}

try {
  const lockWaitMs = parseInt(process.env.OPENCODE_LOCK_WAIT || '600', 10) * 1000;
  acquireBuildLock(lockWaitMs);
  try { main(); }
  finally { releaseBuildLock(); }
} catch (err) {
  console.error('\nBUILD FAILED:', err.message || err);
  process.exit(1);
}
