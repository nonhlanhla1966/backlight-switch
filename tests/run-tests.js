#!/usr/bin/env node
/* Backlight Switch - full factory test suite.
 * Behavior first: rule store, brightness resolution and the enter/exit
 * transition state machine are exercised as pure logic; then files,
 * manifest permissions (exact allow-list), icons, build, APK badging,
 * signature, physical delivery and the cloud-first policy config.
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

section('Delivery (BUILD SUCCESS != DELIVERY SUCCESS)');
check('deliver.js present and executable logic',()=>{
  const p=path.join(ROOT,'tools','deliver.js');
  assert(fs.existsSync(p),'missing tools/deliver.js');
  const src=fs.readFileSync(p,'utf8');
  assert(src.includes('APK DELIVERY SUCCESS'),'delivery tool lacks success gate');
  assert(src.includes('sha256'),'delivery tool does not verify content');});
const dlCheck=spawnSync(process.execPath,[path.join(ROOT,'tools','deliver.js'),'--check'],{encoding:'utf8'});
if(dlCheck.status===3){
  console.log('  skip delivery verification: no writable Download dir on this host');
}else{
  check('delivered APK physically verified in public Download',()=>{
    const r=spawnSync(process.execPath,[path.join(ROOT,'tools','deliver.js')],{encoding:'utf8'});
    if(r.status!==0)
      throw new Error('delivery failed: '+(r.stderr||r.stdout||'exit '+r.status).trim());
    const line=(r.stdout.split('\n').find(l=>l.startsWith('APK DELIVERY SUCCESS'))||'').trim();
    assert(line,'no success marker in delivery output');
    const dst=line.replace('APK DELIVERY SUCCESS ','').trim();
    const st=fs.statSync(dst);
    assert(st.size>0,'delivered file is empty');
    assert((st.mode&0o004)!==0,'delivered file not world-readable (invisible to apps)');
    const out=execFileSync(deliverAapt(),['dump','badging',dst],{encoding:'utf8'});
    assert(out.includes("package: name='com.nonhlanhla1966.backlightswitch'"),'wrong pkg at destination');
    assert(out.includes("versionName='1.0.0'"),'wrong version at destination');});
}

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

console.log('\n========================================');
console.log('PASSED: '+passed+'  FAILED: '+failed);
if(failed){failures.forEach(f=>console.log(' - '+f));process.exit(1);}
console.log('ALL TESTS PASSED');
