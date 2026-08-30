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
const SKIP_BUILD=process.env.BLS_TEST_SKIP_BUILD==='1';
let passed=0,failed=0;const failures=[];
const section=n=>console.log('\n== '+n+' ==');
function check(name,fn){try{fn();passed++;console.log('  ok  '+name);}
  catch(err){failed++;failures.push(name+': '+err.message);console.log('FAIL  '+name+'\n      '+err.message);}}
const assert=(c,m)=>{if(!c)throw new Error(m||'assertion failed');};
const eq=(a,b,m)=>assert(JSON.stringify(a)===JSON.stringify(b),(m||'mismatch')+
  ' expected='+JSON.stringify(b)+' got='+JSON.stringify(a));
/* Node 8-safe String.prototype.matchAll replacement (engine-local). */
function allMatches(content,re){
  const out=[];const rx=new RegExp(re.source,re.flags||'g');let m;
  while((m=rx.exec(content)))out.push(m);
  return out;}

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
  eq(Core.onScreenOff({overridden:true,base:70}),{overridden:false,base:null,kind:null});});

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
  eq(out.map(a=>a.packageName),['com.alpha','com.nolabel','com.zeta']);
  eq(out[1].label,'com.nolabel');});
check('sanitizeApps tolerates non-lists',()=>{
  eq(Core.sanitizeApps(null),[]);eq(Core.sanitizeApps('x'),[]);});

section('Core v2: weekly schedule model');
check('defaultWeekly is inactive, weekdays, 21:00, 30%, 60 min',()=>{
  const d=Core.defaultSchedule();
  eq(d.active,false);eq(d.hour,21);eq(d.minute,0);eq(d.pct,30);
  eq(d.durationMin,60);eq(d.previewMin,Core.PREVIEW_MIN);
  eq(d.days,[0,1,2,3,4,5,6]);});
check('parseWeekly clamps hostile fields and falls back on garbage',()=>{
  const s=Core.parseWeekly(JSON.stringify({active:true,hour:99,minute:-5,pct:1000,
    durationMin:5,previewMin:0,days:'nope'}));
  eq(s.hour,23);eq(s.minute,0);eq(s.pct,100);eq(s.durationMin,10);eq(s.previewMin,1);
  eq(s.days,[0,1,2,3,4,5,6]);
  eq(Core.parseWeekly('{nope').active,false);eq(Core.parseWeekly(null).active,false);});
check('weekly serialize -> parse round-trip',()=>{
  const s=Core.defaultSchedule();s.active=true;s.hour=7;s.minute=45;s.days=[0,2];
  const back=Core.parseWeekly(Core.serializeWeekly(s));
  eq(back,{active:true,hour:7,minute:45,days:[0,2],pct:30,durationMin:60,previewMin:1});});
check('isInWindow true inside, false outside (same day)',()=>{
  const s=Core.parseWeekly(JSON.stringify({active:true,hour:21,minute:0,durationMin:60,
    days:[0,1,2,3,4,5,6]}));
  const tue2105=new Date(2026,7,25,21,5,0).getTime();   // Tues
  const tue2155=new Date(2026,7,25,21,55,0).getTime();
  const tue2000=new Date(2026,7,25,20,0,0).getTime();
  const tue2200=new Date(2026,7,25,22,0,0).getTime();
  assert(Core.isInWindow(s,tue2105),'21:05 should be in window');
  assert(Core.isInWindow(s,tue2155),'21:55 should be in window');
  assert(!Core.isInWindow(s,tue2000),'20:00 outside');
  assert(!Core.isInWindow(s,tue2200),'22:00 outside (window is [21:00,22:00))');});
check('isInWindow respects chosen days',()=>{
  const s=Core.parseWeekly(JSON.stringify({active:true,hour:21,minute:0,
    days:[2],durationMin:60}));                      // Tuesday only
  const tue=new Date(2026,7,25,21,30,0).getTime();   // Tues
  const wed=new Date(2026,7,26,21,30,0).getTime();   // Wed
  const sun=new Date(2026,7,23,21,30,0).getTime();   // Sun
  assert(Core.isInWindow(s,tue),'Tuesday should be in window');
  assert(!Core.isInWindow(s,wed),'Wednesday should not');
  assert(!Core.isInWindow(s,sun),'Sunday should not');});
check('isInWindow handles overnight windows wrapping midnight',()=>{
  const s=Core.parseWeekly(JSON.stringify({active:true,hour:23,minute:30,
    durationMin:120,days:[2]}));                     // 23:30 Tue -> 01:30 Wed
  const lateTue=new Date(2026,7,25,23,45,0).getTime();
  const earlyWed=new Date(2026,7,26,1,0,0).getTime();
  const earlyThu=new Date(2026,7,27,1,0,0).getTime();  // wait, Wed window tail
  // correct: tail belongs to Wed early hours (Tue 23:30 + 120min = Wed 01:30)
  assert(Core.isInWindow(s,earlyWed),'01:00 Wednesday is the Tuesday window tail');
  assert(!Core.isInWindow(s,earlyThu),'01:00 Thursday outside');
  assert(Core.isInWindow(s,lateTue),'23:45 Tuesday inside');});
check('weeklyActiveAt reports active + remaining ms',()=>{
  const s=Core.parseWeekly(JSON.stringify({active:true,hour:21,minute:0,
    durationMin:60,days:[1]}));                       // Monday
  const mon2130=new Date(2026,7,24,21,30,0).getTime();
  assert(Core.weeklyActiveAt(s,mon2130).active===true);
  const rem=Core.weeklyActiveAt(s,mon2130).remainingMs;
  assert(rem===30*60*1000,'remainingMs should be 30 min: '+rem);});
check('nextWeeklyTrigger finds the next enabled weekday hour',()=>{
  const s=Core.parseWeekly(JSON.stringify({active:true,hour:21,minute:0,
    days:[2],durationMin:60}));
  const tue2000=new Date(2026,7,25,20,0,0).getTime();  // Tuesday 20:00
  const next=Core.nextWeeklyTrigger(s,tue2000);
  assert(next===new Date(2026,7,25,21,0,0).getTime(),'should be Tue 21:00 today');
  const tue2200=new Date(2026,7,25,22,0,0).getTime();
  const next2=Core.nextWeeklyTrigger(s,tue2200);
  assert(next2===new Date(2026,8,1,21,0,0).getTime(),'should roll to next Tue 21:00');});
check('disabled weekly has no triggers',()=>{
  const s=Core.defaultSchedule(); // inactive
  eq(Core.nextWeeklyTrigger(s,Date.now()),null);
  eq(Core.weeklyTriggersBetween(s,0,Date.now()+604800000),[]);});
check('weeklyTriggersBetween counts weekly repetition',()=>{
  const s=Core.parseWeekly(JSON.stringify({active:true,hour:21,minute:0,
    days:[2],durationMin:60}));
  const start=new Date(2026,7,25,0,0,0).getTime();  // Tue
  const end=start+3*604800000;
  const hits=Core.weeklyTriggersBetween(s,start,end);
  eq(hits.length,3,'should hit 3 Tuesdays across 3 weeks');});
check('preview happens only in the last PREVIEW_MIN before activation',()=>{
  const s=Core.parseWeekly(JSON.stringify({active:true,hour:21,minute:0,
    days:[2],durationMin:60}));
  const tue2059=new Date(2026,7,25,20,59,20).getTime();  // 40s before
  const tue2055=new Date(2026,7,25,20,55,0).getTime();   // 5m before
  const tue1900=new Date(2026,7,25,19,0,0).getTime();
  assert(Core.inPreviewAt(s,tue2059).previewing===true,'should preview 40s before');
  assert(Core.inPreviewAt(s,tue2055).previewing===false,'5m before is outside preview');
  assert(Core.inPreviewAt(s,tue1900).previewing===false,'way early is no preview');
  const inside=Core.inPreviewAt(s,new Date(2026,7,25,21,5,0).getTime());
  assert(inside.previewing===false,'resolved window is not preview');});
check('preview ramps monotonically and resolves to exact target',()=>{
  const cur=70,tgt=30,win=60000;
  const mid=Core.previewLevel(cur,tgt,30000,win);
  const near=Core.previewLevel(cur,tgt,59000,win);
  const end=Core.previewLevel(cur,tgt,60000,win);
  assert(mid>tgt&&mid<cur,'mid should be between: '+mid);
  assert(near<=mid&&near>tgt||near===tgt,'monotone towards target: '+near);
  eq(end,tgt,'resolution must be exact target');
  eq(Core.previewLevel(cur,cur,0,win),cur,'no-op when equal');});
check('weeklyBlocked: manual inside window blocks, outside re-arms',()=>{
  const s=Core.parseWeekly(JSON.stringify({active:true,hour:21,minute:0,
    days:[2],durationMin:60}));
  const tue2115=new Date(2026,7,25,21,15,0).getTime();
  const tue2050=new Date(2026,7,25,20,50,0).getTime();
  assert(Core.weeklyBlocked(s,tue2115,tue2115)===true,'manual 21:15 blocks at 21:15');
  assert(Core.weeklyBlocked(s,tue2050,tue2115)===false,'manual before window start = ok');
  assert(Core.weeklyBlocked(s,null,tue2115)===false,'no manual = never blocked');
  assert(Core.weeklyCanApply(s,tue2050,tue2115)===true,'unblocked window applies');
  assert(Core.weeklyCanApply(s,tue2115,tue2115)===false,'blocked window does not apply');});

section('Core v2: sensor rules + hysteresis');
check('normalizeSensorRule rounds threshold to 0.1 and clamps pct',()=>{
  eq(Core.normalizeSensorRule('com.a',55.04,20),{pkg:'com.a',threshold:55,pct:20});
  eq(Core.normalizeSensorRule('com.a',55.05,3),{pkg:'com.a',threshold:55.1,pct:5});});
check('normalizeSensorRule rejects invalid packages/thresholds',()=>{
  const throws=(fn)=>{try{fn();return false;}catch(e){return true;}};
  assert(throws(()=>Core.normalizeSensorRule('nodot',55,20)));
  assert(throws(()=>Core.normalizeSensorRule('com.a',0,20)));
  assert(throws(()=>Core.normalizeSensorRule('com.a',151,20)));});
check('sensor rule store round-trip, set/get/remove',()=>{
  let r=Core.defaultSensorRules();
  r=Core.setSensorRule(r,'com.hot',58.2,15);
  eq(r['com.hot'],{threshold:58.2,pct:15});
  eq(Core.getSensorRule(r,'com.hot'),r['com.hot']);
  eq(Core.getSensorRule(r,'com.cold'),null);
  r=Core.removeSensorRule(r,'com.hot');
  eq(Core.getSensorRule(r,'com.hot'),null);
  const back=Core.parseSensorRules(Core.serializeSensorRules(
    {'com.hot':{threshold:58.2,pct:15}}));
  eq(back,{'com.hot':{threshold:58.2,pct:15}});});
check('parseSensorRules drops malformed entries and bad JSON',()=>{
  const back=Core.parseSensorRules({'com.ok':{threshold:50,pct:20},
    'nodot':{threshold:50,pct:20},'com.bad':{threshold:0,pct:20}});
  eq(back,{'com.ok':{threshold:50,pct:20}});
  eq(Core.parseSensorRules('{garbage'),{});eq(Core.parseSensorRules(null),{});});
check('sensorDecision: threshold triggers, 2C hysteresis clears, band holds',()=>{
  const r={threshold:55,pct:20};
  assert(Core.sensorDecision(54.9,r,false).triggered===false);
  assert(Core.sensorDecision(55.0,r,false).triggered===true,'at threshold triggers');
  assert(Core.sensorDecision(56,r,false).triggered===true);
  assert(Core.sensorDecision(53.5,r,true).triggered===true,'inside band keeps previous');
  assert(Core.sensorDecision(53.5,r,false).triggered===false,'inside band keeps previous');
  assert(Core.sensorDecision(53.0,r,true).triggered===false,'<=threshold-2 clears');
  assert(Core.sensorDecision(NaN,r,true).triggered===true,'unknown temp holds decision');
  assert(Core.sensorDecision(56,null,false).triggered===false,'no rule = never triggered');});

section('Core v2: priority regime');
function pctx(over){
  const o={rules:'{"com.app":{"pct":15}}',
    sensorRules:'{"com.hot":{"threshold":55,"pct":25}}',
    sensorValue:56,sensorPrev:null,
    weekly:JSON.stringify({active:true,hour:21,minute:0,days:[2],pct:35,
      durationMin:60,previewMin:1}),
    lastManualAt:null,fgPkg:'com.app',presetActive:false};
  return Object.assign(o,over||{});
}
function kick_tue(h,m){
  return new Date(2026,7,25,h,m,0).getTime(); // Tues
}
check('per-app override beats sensor and weekly',()=>{
  const p=Core.resolvePriority(pctx({sensorValue:70}));
  eq(p,{kind:'app',value:15});});
check('sensor rule beats weekly when triggered',()=>{
  const p=Core.resolvePriority(pctx({rules:'{}',fgPkg:'com.hot',sensorValue:70}));
  eq(p,{kind:'sensor',value:25});
  const notHot=Core.resolvePriority(pctx({rules:'{}',fgPkg:'com.hot',sensorValue:40,
    nowMs:new Date(2026,7,25,21,10,0).getTime()}));
  eq(notHot.kind,'weekly','cool temp should fall through to weekly');});
check('weekly preset applies when nothing else',()=>{
  const p=Core.resolvePriority(pctx({rules:'{}',fgPkg:'com.none',
    nowMs:kick_tue(21,10)}));
  eq(p,{kind:'weekly',value:35});});
check('manual lastManualAt blocks weekly but never app rule',()=>{
  const b=Core.resolvePriority(pctx({fgPkg:'com.app',
    lastManualAt:kick_tue(21,15),nowMs:kick_tue(21,20)}));
  eq(b,{kind:'app',value:15},'app rule is immune to manual');
  const none=Core.resolvePriority(pctx({rules:'{}',fgPkg:'com.none',
    lastManualAt:kick_tue(21,15),nowMs:kick_tue(21,20)}));
  eq(none,{kind:'none',value:null},'weekly blocked by manual -> none');});
check('outside the weekly window there is no scheduled action',()=>{
  const p=Core.resolvePriority(pctx({rules:'{}',fgPkg:'com.none',
    nowMs:kick_tue(22,10)}));
  eq(p,{kind:'none',value:null});});
check('decideAutoAction emits set/preview/idle correctly',()=>{
  const a1=Core.decideAutoAction(pctx({fgPkg:'com.app'}),
    {currentBrightness:50,cur:null});
  eq(a1.action,'set');eq(a1.value,15);
  const idle=Core.decideAutoAction(pctx({rules:'{}',fgPkg:'com.none',
    nowMs:new Date(2026,7,24,18,0,0).getTime()}),
    {currentBrightness:50,cur:null});
  eq(idle.action,'idle');
  const pv=Core.decideAutoAction(pctx({rules:'{}',fgPkg:'com.none',
    nowMs:new Date(2026,7,25,20,59,30).getTime()}),{currentBrightness:70,cur:null});
  eq(pv.action,'preview');eq(pv.previewing,true);eq(pv.remainingMs<=60000,true);
  assert(pv.value<=70&&pv.value>=35,'preview value between current and target');});
check('applyManual records a timestamp',()=>{
  const t=12345678;
  eq(Core.applyManual(t),t);});

section('Core v2: bridge isolation & safe fallback');
const BRIDGE=fs.readFileSync(path.join(ROOT,'www','js','bridge.js'),'utf8');
check('app.js never touches window.Android directly',()=>{
  const src=fs.readFileSync(path.join(ROOT,'www','js','app.js'),'utf8');
  assert(!/window\.Android/.test(src),'app.js must use only BacklightBridge');
  assert(src.includes('BacklightBridge'),'app.js does not reference BacklightBridge');});
check('bridge.js declares a clean UMD surface with no native leakage',()=>{
  assert(BRIDGE.includes('BacklightBridge'),'no BacklightBridge global');
  assert(/typeof\s+module\s*===\s*'object'/.test(BRIDGE),'no UMD guard');
  assert(!/window\.Android\s*=/.test(BRIDGE.replace(/exposeMock[\s\S]*?}/g,'')),
    'bridge must not assign Android except in the mock helper');});
check('bridge falls back safely with no native present',()=>{
  const sandbox={};
  new Function('window',BRIDGE).call(sandbox,sandbox);
  assert(sandbox.BacklightBridge.available===false,'no native -> unavailable');
  eq(sandbox.BacklightBridge.getRules(),'{}');
  eq(sandbox.BacklightBridge.getSensor(),{value:null,err:'no bridge'});
  eq(sandbox.BacklightBridge.status(),{});
  assert(sandbox.BacklightBridge.version().name===undefined||
    JSON.stringify(sandbox.BacklightBridge.version())==='{}','unexpected version fallback');});
check('bridge parses native JSON replies and guards exceptions',()=>{
  const sandbox={};
  new Function('window',BRIDGE).call(sandbox,sandbox);
  sandbox.Android={
    getSensor:function(){throw new Error('boom');},
    getRules:function(){return '{"a":{"pct":5}}';},
  };
  sandbox.BacklightBridge.exposeMock(sandbox.Android);
  const s=sandbox.BacklightBridge.getSensor();
  assert(s.value===null,'throwing native must degrade to null sensor');
  eq(sandbox.BacklightBridge.getRules(),'{"a":{"pct":5}}');});
check('weekly JSON stays canonical through the service contract',()=>{
  const s=Core.parseWeekly(Core.serializeWeekly(
    {active:true,hour:21,minute:30,days:[0,6],pct:25,durationMin:60,previewMin:1}));
  eq(s,{active:true,hour:21,minute:30,days:[0,6],pct:25,durationMin:60,
    previewMin:1},'canonical weekly contract');});

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
  const found=allMatches(MANIFEST,/<uses-permission android:name="([^"]+)"/g)
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
check('manifest carries v2 identity + cleartext guard',()=>{
  const m=fs.readFileSync(path.join(ROOT,'AndroidManifest.xml'),'utf8');
  assert(m.includes('android:versionName="2.0.1"'),'versionName not 2.0.1');
  assert(m.includes('android:versionCode="3"'),'versionCode not 3');
  assert(m.includes('android:usesCleartextTraffic="false"'),'cleartext guard missing');});
if(SKIP_BUILD){
  check('local APK build skipped (thermal-safe mode; CI builds + signs)',()=>true);
}else{
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
  assert(path.basename(apkPath)==='Backlight-Switch-v2.0.1.apk','unexpected name '+apkPath);
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
  assert(badging.includes("versionName='2.0.1'"),'wrong version');
  assert(badging.includes("application-label:'Backlight Switch'"),'wrong label');
  assert(badging.includes("sdkVersion:'26'"),'minSdk wrong');
  const perms=allMatches(badging,/uses-permission: name='([^']+)'/g).map(m=>m[1]).sort();
  eq(perms,[...ALLOWED].sort(),'APK permission set differs from manifest allow-list');
  const listing=execFileSync(aapt,['list',apkPath],{encoding:'utf8'}).split('\n');
  assert(listing.includes('classes.dex'),'no dex');
  assert(listing.includes('assets/index.html'),'no index.html');
  assert(listing.includes('assets/js/core.js'),'no core.js');
  assert(listing.includes('res/mipmap-xxxhdpi-v4/ic_launcher.png'),'no icon in APK');
  const out=execFileSync(signer,['verify','--verbose',apkPath],{encoding:'utf8',env});
  assert(/Verified using v\d scheme/i.test(out)&&!/NOT verified/i.test(out),'signature failed');});
}

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


section('Factory orchestration (checkpoint/resume/multi-model/$0)');
check('orchestration modules inherited',()=>{
  ['checkpoint.js','models.js','perm.js','factory.js','net.js'].forEach(f=>
    assert(fs.existsSync(path.join(ROOT,'tools',f)),'missing tools/'+f));
  const Ckpt=require(path.join(ROOT,'tools','checkpoint'));
  const ModelsMod=require(path.join(ROOT,'tools','models'));
  const PermMod=require(path.join(ROOT,'tools','perm'));
  assert(Ckpt.STAGES.includes('DOWNLOAD_READY'),'stage list incomplete');
  assert(typeof ModelsMod.route==='function'&&typeof ModelsMod.redact==='function','models API missing');
  assert(typeof PermMod.probeWrite==='function','perm API missing');});
check('checkpoint roundtrip + resume skips completed stages',()=>{
  const os=require('os'),Ckpt=require(path.join(ROOT,'tools','checkpoint'));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ckpt-'));
  const s=Ckpt.fresh('idea x');
  Ckpt.save(dir,s);
  const loaded=Ckpt.load(dir);
  Ckpt.complete(dir,loaded,'TEST');
  const again=Ckpt.load(dir);
  assert(again.completed.TEST&&Ckpt.nextStage(again)==='LOCAL_VALIDATION','roundtrip broken');
  const st=Ckpt.fresh(null);
  st.stage='IDEA';
  const plan=Ckpt.resumePlan(st,{hasManifest:true,hasGit:true,distApks:[]});
  assert(plan.from==='TEST'&&!plan.skip.includes('TEST'),'resume plan wrong');});
check('free-first routing; paid never routed without explicit opt-in',()=>{
  const ModelsMod=require(path.join(ROOT,'tools','models'));
  const reg={models:[{ref:'openai/gpt-x',provider:'openai',cost:'paid'},
    {ref:'ollama/llama3',provider:'ollama',cost:'free'},
    {ref:'host/m',provider:'host',cost:'unknown'}]};
  const order=ModelsMod.route(reg,{});
  if(order[0].ref!=='ollama/llama3')throw new Error('free model not first');
  if(order.some(m=>m.cost==='paid'))throw new Error('paid leaked into route');
  let msg=null;
  try{ModelsMod.route({models:[{ref:'anthropic/c',provider:'anthropic',cost:'paid'}]},{});}catch(e){msg=e.message;}
  assert(msg&&/Paid model\/provider would be required\./.test(msg),'paid prevention message wrong: '+msg);});
check('model fallback on unavailable + rate limit; finite exhaustion',()=>{
  const r=spawnSync(process.execPath,['-e',
    'const path=require("path");const Models=require(path.join(process.argv[1],"tools","models"));'+
    'const reg={models:[{ref:"a/dead",provider:"a",cost:"free"},'+
    '{ref:"b/lim",provider:"b",cost:"free"},{ref:"c/ok",provider:"c",cost:"free"}]};'+
    'const invoker=async ref=>{if(ref==="a/dead")throw Object.assign(new Error("command not found"),{kind:"unavailable"});'+
    'if(ref==="b/lim")throw Object.assign(new Error("rate limit (429)"),{kind:"ratelimit"});return "ok-out";};'+
    'Models.invoke({prompt:"t"},{registry:reg,health:{},invoker,validate:()=>true}).then(res=>{'+
    'if(res.model!=="c/ok"||res.tried.length!==2)process.exit(1);'+
    'let n=0;const reg2={models:[{ref:"x/d",provider:"x",cost:"free"}]};'+
    'Models.invoke({prompt:"t"},{registry:reg2,health:{},validate:()=>true,'+
    'invoker:async()=>{n++;throw new Error("unavailable");}})'+
    '.then(()=>process.exit(1)).catch(e=>{if(/MODEL_EXHAUSTED/.test(e.message)&&n<=3)console.log("FALLBACK_OK");else process.exit(1);});})'+
    '.catch(e=>{console.error(e.message);process.exit(1);});',
    ROOT],{encoding:'utf8'});
  assert(r.status===0&&/FALLBACK_OK/.test(r.stdout),(r.stderr||r.stdout).trim());});
check('credential protection: redaction works, discovery skips secret keys',()=>{
  const os=require('os'),ModelsMod=require(path.join(ROOT,'tools','models'));
  const ghTok='ghp_'+'abcdefghijklmnopqrstuv1234567890';
  const clean=ModelsMod.redact('tok '+ghTok+' sk-abcdef123456 password=ignoreme');
  assert(!/ghp_|sk-abcdef|ignoreme/.test(clean),'redact missed secrets');
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'cfg-'));
  fs.mkdirSync(path.join(home,'.config'));
  fs.mkdirSync(path.join(home,'.config','opencode'));
  const secretValue='sk-'+'SECRETVALUE';
  fs.writeFileSync(path.join(home,'.config','opencode','opencode.json'),
    JSON.stringify({model:'host/session-model',apiKey:secretValue}));
  const disc=ModelsMod.discover({},home);
  assert(disc.models.some(m=>m.ref==='host/session-model'),'model not discovered');
  assert(!JSON.stringify(disc).includes(secretValue),'secret leaked into discovery');});
check('permissions report exact requirements instead of prompting; no prompt code in tools',()=>{
  const PermMod=require(path.join(ROOT,'tools','perm'));
  const okRes=PermMod.probeWrite(require('os').tmpdir());
  assert(okRes.ok===true,'tmp writable dir reported blocked');
  const strip=src=>src.replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'');
  fs.readdirSync(path.join(ROOT,'tools')).filter(f=>f.endsWith('.js')).forEach(f=>{
    const src=strip(fs.readFileSync(path.join(ROOT,'tools',f),'utf8'));
    [/require\(\s*['"]readline['"]\s*\)/,/readline\s*\.\s*createInterface/,/\bconfirm\s*\(/,/\bprompt\s*\(/].forEach(p=>
      assert(!p.test(src),f+' appears to prompt interactively'));});
  const fsrc=strip(fs.readFileSync(path.join(ROOT,'tools','factory.js'),'utf8'));
  ['FACTORY_ALLOW_PAID','APK READY — DOWNLOAD AVAILABLE','--resume'].forEach(s=>
    assert(fsrc.includes(s),'factory.js missing: '+s));});

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

/* Runtime WebView interaction wiring suite: drives the REAL index.html +
 * app.js against a strict recording native mock. Runs even when a static
 * test failed - it is the primary guard for the "buttons look alive but
 * actions don't execute" class of defect. */
try { require('./run-wiring-tests.js'); }
catch (err) { console.error('WIRING SUITE CRASHED: ' + err.message); process.exit(1); }

if(failed){failures.forEach(f=>console.log(' - '+f));process.exit(1);}
console.log('ALL TESTS PASSED');
