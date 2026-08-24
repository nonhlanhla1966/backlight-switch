#!/usr/bin/env node
/* Backlight Switch - full factory test suite.
 * Behavior first: rule store, brightness resolution and the enter/exit
 * transition state machine are exercised as pure logic; then files,
 * manifest permissions (exact allow-list), icons, build, APK badging,
 * signature, publish config and the cloud-first policy.
 */
'use strict';
const fs=require('fs'),path=require('path'),{execFileSync,spawnSync}=require('child_process');
const ROOT=path.join(__dirname,'..');
let passed=0,failed=0;const failures=[];
const section=n=>console.log('\n== '+n+' ==');
function check(name,fn){try{fn();passed++;console.log('  ok  '+name);}
  catch(err){failed++;failures.push(name+': '+err.message);console.log('FAIL  '+name+'\n      '+err.message);}}
const assert=(c,m)=>{if(!c)throw new Error(m||'assertion failed');};
const eq=(a,b,m)=>assert(JSON.stringify(a)===JSON.stringify(b),(m||'mismatch')+
  ' expected='+JSON.stringify(b)+' got='+JSON.stringify(a));

const Core = require(path.join(ROOT,'www','js','core.js'));

section('Core behavior: brightness values');
check('clampPct clamps to 5..100 and rounds',()=>{
  eq(Core.clampPct(5),5);eq(Core.clampPct(100),100);
  eq(Core.clampPct(1),5);eq(Core.clampPct(99.4),99);eq(Core.clampPct(250),100);});
check('clampPct rejects non-numeric',()=>{
  const throws=(fn)=>{try{fn();return false;}catch(e){return true;}};
  assert(throws(()=>Core.clampPct('abc')));assert(throws(()=>Core.clampPct(NaN)));});
check('validPackage accepts real packages, rejects junk',()=>{
  assert(Core.validPackage('com.example.app'));
  assert(Core.validPackage('com.nonhlanhla1966.backlightswitch'));
  assert(!Core.validPackage('no-dots'));assert(!Core.validPackage(''));
  assert(!Core.validPackage('.starts.bad'));assert(!Core.validPackage(null));
  assert(!Core.validPackage('1num.start'));});

section('Core behavior: rule store');
check('setRule stores normalized pct',()=>{
  const r={};Core.setRule(r,'com.test.reader',33);
  eq(r['com.test.reader'],{pct:33});});
check('setRule clamps pct into range',()=>{
  const r={};Core.setRule(r,'com.test.reader',1);
  eq(r['com.test.reader'],{pct:5});
  Core.setRule(r,'com.test.reader',999);eq(r['com.test.reader'],{pct:100});});
check('removeRule deletes only the target',()=>{
  const r={};Core.setRule(r,'com.a',10);Core.setRule(r,'com.b',20);
  Core.removeRule(r,'com.a');eq(Core.getRule(r,'com.a'),null);
  eq(Core.getRule(r,'com.b'),{pct:20});});
check('getRule unknown pkg returns null',()=>{
  eq(Core.getRule({},'com.x'),null);eq(Core.getRule(null,'com.x'),null);});

section('Core behavior: persistence round-trip');
check('rules survive serialize -> parse unchanged',()=>{
  const r={};Core.setRule(r,'com.a',11);Core.setRule(r,'com.b.c.d',90);
  const back=Core.parseRules(Core.serializeRules(r));
  eq(back,{'com.a':{pct:11},'com.b.c.d':{pct:90}});});
check('corrupt JSON falls back to empty rules safely',()=>{
  eq(Core.parseRules('{not json'),{});eq(Core.parseRules('null'),{});
  eq(Core.parseRules('[1,2]'),{});eq(Core.parseRules(undefined),{});});
check('malformed entries are dropped, good ones kept',()=>{
  const back=Core.parseRules({'com.ok':{pct:40},'nodot':{pct:50},'com.nan':'x'});
  eq(back,{'com.ok':{pct:40}});});

section('Core behavior: resolution precedence');
check('rule wins over global',()=>{
  const rules={'com.dim':{'pct':12}};
  eq(Core.resolveBrightness(rules,'com.dim',80),12);
  eq(Core.resolveBrightness(rules,'com.other',80),80);});
check('no rules means global everywhere',()=>{
  eq(Core.resolveBrightness({},'com.any',66),66);});

section('Core behavior: transition state machine');
const R={'com.night':{'pct':15}};
check('same app or null next -> none',()=>{
  const s0={overridden:false,base:null};
  let d=Core.decideTransition('com.x','com.x',R,s0,50);
  eq(d.action,'none');eq(d.state.overridden,false);
  d=Core.decideTransition('com.x',null,R,s0,50);eq(d.action,'none');});
check('enter ruled app applies rule and captures base',()=>{
  const d=Core.decideTransition(null,'com.night',R,{overridden:false,base:null},70);
  eq(d.action,'apply');eq(d.value,15);eq(d.state.base,70);eq(d.state.overridden,true);});
check('switching ruled->ruled keeps original base',()=>{
  const two={'com.night':{'pct':15},'com.book':{'pct':35}};
  const a=Core.decideTransition(null,'com.night',two,{overridden:false,base:null},70);
  const b=Core.decideTransition('com.night','com.book',two,a.state,a.value);
  eq(b.action,'apply');eq(b.value,35);eq(b.state.base,70);});
check('leaving ruled to unruled restores base once',()=>{
  const entered=Core.decideTransition(null,'com.night',R,{overridden:false,base:null},70);
  const left=Core.decideTransition('com.night','com.home',R,entered.state,15);
  eq(left.action,'restore');eq(left.value,70);
  eq(left.state.overridden,false);eq(left.state.base,null);});
check('leaving unruled to unruled does nothing',()=>{
  const d=Core.decideTransition('com.home','com.other',{},{overridden:false,base:null},55);
  eq(d.action,'none');});
check('screen off clears override state',()=>{
  eq(Core.onScreenOff({overridden:true,base:70}),{overridden:false,base:null});});

section('Core behavior: settings persistence');
check('settings round-trip and corrupt fallback',()=>{
  eq(Core.parseSettings(Core.serializeSettings({auto:true,theme:'light'})),
     {auto:true,theme:'light'});
  eq(Core.parseSettings('garbage'),Core.defaultSettings());
  eq(Core.parseSettings('{}').theme,'dark');});

section('Core behavior: installed-app sanitisation');
check('sanitizeApps dedupes, drops invalid, sorts by label',()=>{
  const out=Core.sanitizeApps([
    {pkg:'com.zeta',label:'Zeta'},
    {pkg:'com.alpha',label:'alpha'},
    {pkg:'com.zeta',label:'dup'},
    {pkg:'bad',label:'no'},
    {pkg:'com.nolabel'}]);
  eq(out.map(a=>a.pkg),['com.alpha','com.nolabel','com.zeta']);
  eq(out[1].label,'com.nolabel');});
check('sanitizeApps tolerates non-lists',()=>{
  eq(Core.sanitizeApps(null),[]);eq(Core.sanitizeApps('x'),[]);});

section('Required files');
['package.json','build.js','AndroidManifest.xml','AGENTS.md','res/values/strings.xml',
 'www/index.html','www/css/styles.css','www/js/core.js','www/js/app.js',
 'src/com/nonhlanhla1966/backlightswitch/MainActivity.java',
 'src/com/nonhlanhla1966/backlightswitch/BrightnessWatcherService.java',
 'src/com/nonhlanhla1966/backlightswitch/BootReceiver.java',
 '.github/workflows/build.yml','.gitignore'].forEach(f=>
  check('exists: '+f,()=>assert(fs.existsSync(path.join(ROOT,f)),'missing '+f)));

section('Manifest & permissions');
const MANIFEST=fs.readFileSync(path.join(ROOT,'AndroidManifest.xml'),'utf8');
check('package/name/intent correct',()=>{
  assert(MANIFEST.includes('package="com.nonhlanhla1966.backlightswitch"'),'wrong package');
  assert(MANIFEST.includes('android.intent.category.LAUNCHER'),'no LAUNCHER');});
const ALLOWED=['android.permission.WRITE_SETTINGS','android.permission.PACKAGE_USAGE_STATS',
  'android.permission.FOREGROUND_SERVICE','android.permission.RECEIVE_BOOT_COMPLETED'];
check('permissions exactly match the required allow-list',()=>{
  const found=[...MANIFEST.matchAll(/<uses-permission android:name="([^"]+)"/g)]
    .map(m=>m[1]).sort();
  eq(found,[...ALLOWED].sort());});
check('watcher service + boot receiver registered',()=>{
  assert(MANIFEST.includes('.BrightnessWatcherService'),'service missing');
  assert(MANIFEST.includes('.BootReceiver'),'receiver missing');
  assert(MANIFEST.includes('BOOT_COMPLETED'),'boot intent missing');});

section('Icons');
[['mdpi',48],['hdpi',72],['xhdpi',96],['xxhdpi',144],['xxxhdpi',192]].forEach(([d,s])=>{
  ['ic_launcher.png','ic_launcher_round.png'].forEach(n=>{
    check(`icon mipmap-${d}/${n} is ${s}x${s}`,()=>{
      const p=path.join(ROOT,'res','mipmap-'+d,n);
      assert(fs.existsSync(p),'missing icon');
      const b=fs.readFileSync(p);
      assert(b.readUInt32BE(16)===s&&b.readUInt32BE(20)===s,'wrong dimensions');});});});

section('Build & APK');
const APK_DIR=path.join(ROOT,'dist');
let apkPath=null;
check('npm run build succeeds',()=>{execFileSync(process.execPath,[path.join(ROOT,'build.js')],
  {cwd:ROOT,encoding:'utf8',timeout:300000,stdio:['ignore','pipe','inherit']});
  const list=fs.readdirSync(APK_DIR).filter(f=>f.endsWith('.apk'));
  assert(list.length===1,'expected exactly one APK');});
let badging='';
function findSdkRoot(){return process.env.ANDROID_SDK_ROOT||process.env.ANDROID_HOME||'/opt/android_sdk';}
function deliverAapt(){
  const cs=['/usr/bin/aapt'];const bt=path.join(findSdkRoot(),'build-tools');
  try{for(const v of fs.readdirSync(bt).sort().reverse())cs.push(path.join(bt,v,'aapt'));}catch(_){}
  for(const c of cs){try{execFileSync(c,['v'],{stdio:'ignore'});return c;}catch(_){}}
  throw new Error('no aapt for verification');}
check('APK badging: package/version/label/minSdk26/icon/exact permissions',()=>{
  apkPath=path.join(APK_DIR,fs.readdirSync(APK_DIR).find(f=>f.endsWith('.apk')));
  assert(path.basename(apkPath)==='Backlight-Switch-v1.0.0.apk','unexpected name '+apkPath);
  const jh=(process.env.JAVA_HOME&&fs.existsSync(path.join(process.env.JAVA_HOME,'bin','javac')))
    ?process.env.JAVA_HOME:'/opt/java/jdk1.8.0_212';
  if(!fs.existsSync(path.join(jh,'bin','javac'))&&!process.env.JAVA_HOME)
    throw new Error('no JDK found');
  const env={...process.env};env.JAVA_HOME=jh;
  env.PATH=path.join(jh,'bin')+path.delimiter+env.PATH;
  const bt=path.join(findSdkRoot(),'build-tools');
  let signer=null;
  fs.readdirSync(bt).sort().reverse().some(v=>{const c=path.join(bt,v,'apksigner');
    if(fs.existsSync(c)){signer=c;return true;}return false;});
  const aapt=deliverAapt();
  badging=execFileSync(aapt,['dump','badging',apkPath],{encoding:'utf8'});
  assert(badging.includes("package: name='com.nonhlanhla1966.backlightswitch'"),'wrong package');
  assert(badging.includes("versionName='1.0.0'"),'wrong version');
  assert(badging.includes("application-label:'Backlight Switch'"),'wrong label');
  assert(badging.includes("sdkVersion:'26'"),'minSdk wrong');
  const perms=[...badging.matchAll(/uses-permission: name='([^']+)'/g)].map(m=>m[1]).sort();
  eq(perms,[...ALLOWED].sort(),'APK permission set differs from manifest allow-list');
  const listing=execFileSync(aapt,['list',apkPath],{encoding:'utf8'}).split('\n');
  assert(listing.includes('classes.dex'),'no dex');
  assert(listing.includes('assets/index.html'),'no index.html');
  assert(listing.includes('assets/js/core.js'),'no core.js');
  assert(listing.includes('res/mipmap-xxxhdpi-v4/ic_launcher.png'),'no icon in APK');
  const out=execFileSync(signer,['verify','--verbose',apkPath],{encoding:'utf8',env});
  assert(/Verified using v\d scheme/i.test(out)&&!/NOT verified/i.test(out),'signature failed');});

section('Publish (browser-based download; no phone-storage copy)');
check('release.js publishes verified APK as release asset',()=>{
  const p=path.join(ROOT,'tools','release.js');
  assert(fs.existsSync(p),'missing tools/release.js');
  const s=fs.readFileSync(p,'utf8');
  assert(s.includes('DOWNLOAD AVAILABLE'),'release.js lacks final status line');
  assert(s.includes('uploads.github.com'),'does not upload release assets');});
check('no automatic phone-storage delivery remains',()=>{
  const pkgJson=JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'),'utf8'));
  const scripts=Object.values(pkgJson.scripts||{}).join(' ');
  assert(!scripts.includes('deliver.js'),'package.json still invokes deliver.js');
  assert(!fs.existsSync(path.join(ROOT,'tools','deliver.js')),'deliver.js still present');
  const a=fs.readFileSync(path.join(ROOT,'AGENTS.md'),'utf8');
  assert(/never\s+copies\s+apks/i.test(a),'AGENTS.md does not prohibit automatic copies');
  assert(a.includes('APK READY'),'AGENTS.md missing APK READY status');});
check('AGENTS.md documents browser-based user-controlled download',()=>{
  const a=fs.readFileSync(path.join(ROOT,'AGENTS.md'),'utf8');
  assert(/default browser/i.test(a),'default-browser flow missing');
  assert(/user-controlled|USER-CONTROLLED/.test(a),'user-control principle missing');});

section('Cloud-first policy (thermal-safe)');
check('build.js enforces single-build lock + wall-clock protection',()=>{
  const b=fs.readFileSync(path.join(ROOT,'build.js'),'utf8');
  assert(b.includes('appfactory-android-build.lock'),'no factory build lock');
  assert(b.includes('OPENCODE_LOCAL_BUILD_TIMEOUT'),'no local build deadline guard');
  assert(b.includes('GitHub Actions'),'cloud-first banner missing');});
check('fetch-cloud-apk.js waits for Actions artifact of current HEAD',()=>{
  const p=path.join(ROOT,'tools','fetch-cloud-apk.js');
  assert(fs.existsSync(p),'missing tools/fetch-cloud-apk.js');
  const s=fs.readFileSync(p,'utf8');
  assert(s.includes('/actions/runs'),'does not query Actions runs');
  assert(s.includes('.apk')&&s.includes('inflateRawSync'),'cannot extract APK from artifact');
  assert(s.includes('versionName'),'does not verify version');});
check('AGENTS.md documents the thermal-safe cloud-first policy',()=>{
  const a=fs.readFileSync(path.join(ROOT,'AGENTS.md'),'utf8');
  assert(/thermal-safe cloud-first/i.test(a),'policy section missing');
  assert(/never\s+bypass/i.test(a),'thermal-bypass prohibition missing');});


section('Network retry policy (TLS never disabled)');
check('net.js exists and exports the shared retry API',()=>{
  const Net=require(path.join(ROOT,'tools','net.js'));
  assert(typeof Net.withRetry==='function','withRetry missing');
  assert(Net.MAX_ATTEMPTS===3,'MAX_ATTEMPTS must be 3');
  assert(typeof Net.classify==='function','classify missing');});
check('transient certificate failure retries; later attempt succeeds and workflow continues',()=>{
  const r=spawnSync(process.execPath,['-e',
    'const Net=require(process.argv[1]);let n=0;'+
    'Net.withRetry(()=>{n++;if(n<3){const e=new Error("certificate verification error: unable to verify the first certificate");throw e;}return "ok";},{delayMs:1,label:"t"})'+
    '.then(v=>{if(v==="ok"&&n===3)console.log("RECOVERED AUTOMATICALLY - attempt 3 succeeded");else process.exit(1);})'+
    '.catch(e=>{console.error(e.message);process.exit(1);});',
    path.join(ROOT,'tools','net.js')],{encoding:'utf8'});
  assert(r.status===0,'retry did not recover: '+r.stderr);
  assert(/RECOVERED AUTOMATICALLY/.test(r.stdout),'no recovery marker');});
check('maximum 3 attempts enforced with exact error report',()=>{
  const r=spawnSync(process.execPath,['-e',
    'const Net=require(process.argv[1]);let n=0;'+
    'Net.withRetry(()=>{n++;throw new Error("socket hang up");},{delayMs:1,label:"t"})'+
    '.then(()=>process.exit(1)).catch(e=>{if(n===3&&/FAILED AFTER 3 ATTEMPTS/.test(e.message))process.exit(0);process.exit(1);});',
    path.join(ROOT,'tools','net.js')],{encoding:'utf8'});
  assert(r.status===0,'expected exactly 3 attempts then FAILED AFTER 3 ATTEMPTS: '+r.stderr);});
check('permanent errors fail immediately (never retried)',()=>{
  const r=spawnSync(process.execPath,['-e',
    'const Net=require(process.argv[1]);let n=0;'+
    'Net.withRetry(()=>{n++;const e=new Error("Bad credentials");e.status=401;throw e;},{delayMs:1,label:"t"})'+
    '.then(()=>process.exit(1)).catch(e=>{if(n===1&&/PERMANENT FAILURE/.test(e.message))process.exit(0);process.exit(1);});',
    path.join(ROOT,'tools','net.js')],{encoding:'utf8'});
  assert(r.status===0,'401 must fail once without retry: '+r.stderr);});
check('classifier: cert/transient vs credentials/not-found permanent',()=>{
  const Net=require(path.join(ROOT,'tools','net.js'));
  assert(Net.classify({message:'certificate verification error'})==='transient','cert must be transient');
  assert(Net.classify({code:'ECONNRESET'})==='transient','ECONNRESET must be transient');
  assert(Net.classify({message:'rate limit exceeded',status:429})==='transient','429 must be transient');
  assert(Net.classify({message:'Bad credentials',status:401})==='permanent','401 must be permanent');
  assert(Net.classify({message:'Not Found',status:404})==='permanent','404 must be permanent');});
function assertNoTlsBypass(fileLabel,rawSrc){
  const s=rawSrc.replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'');
  [/rejectUnauthorized\s*:\s*false/,/NODE_TLS_REJECT_UNAUTHORIZED/,/GIT_SSL_NO_VERIFY/,
   /--insecure/,/curl\s+-k/,/sslVerify\s*[:=]\s*false/].forEach(p=>
    assert(!p.test(s),fileLabel+' disables TLS verification: '+p));}
check('TLS verification is never disabled anywhere in factory scripts',()=>{
  ['tools/net.js','tools/fetch-cloud-apk.js','tools/release.js','build.js'].forEach(f=>{
    const s=fs.readFileSync(path.join(ROOT,f),'utf8');
    assertNoTlsBypass(f,s);});});
check('TLS scanner: executable bypass is caught; comment-only mention passes',()=>{
  let caught=null;
  try{assertNoTlsBypass('synthetic-evil.js',
    'https.request({ hostname: "x", path: "/", rejectUnauthorized: false });');}catch(e){caught=e;}
  assert(caught&&/disables TLS verification/.test(caught.message),
    'executable rejectUnauthorized:false was NOT caught by scanner');
  assertNoTlsBypass('synthetic-doc.js',
    '/** docs: never set rejectUnauthorized:false anywhere */\n'+
    '// see also: rejectUnauthorized: false is forbidden\n'+
    'https.get("https://api.github.com");\n');
  let caughtInString=null;
  try{assertNoTlsBypass('synthetic-string.js','const flag = "rejectUnauthorized: false";');}catch(_){caughtInString=true;}
  assert(caughtInString,'string-literal occurrence must stay flagged (conservative)');});
check('partial cloud APKs rejected: atomic publish, verify before rename, cleanup on failure',()=>{
  const s=fs.readFileSync(path.join(ROOT,'tools','fetch-cloud-apk.js'),'utf8');
  assert(s.includes('.part'),'no partial-file staging');
  assert(s.includes('renameSync'),'publish not atomic');
  assert(s.indexOf("'dump', 'badging'")<s.indexOf('renameSync'),'verification must precede publish');
  assert(s.includes('unlinkSync(partPath)'),'failed fetch leaves partial APK behind');
  assert(s.includes('Buffer.concat'),'download must buffer fully before use');
  assert(s.includes('withRetry'),'network calls not wrapped in retry policy');});

console.log('\n========================================');
console.log('PASSED: '+passed+'  FAILED: '+failed);
if(failed){failures.forEach(f=>console.log(' - '+f));process.exit(1);}
console.log('ALL TESTS PASSED');
