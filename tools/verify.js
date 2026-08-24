#!/usr/bin/env node
/* Verifies the built APK: existence, ZIP validity, badging, signature. */
'use strict';
const fs=require('fs'),path=require('path'),{execFileSync}=require('child_process');
const ROOT=path.join(__dirname,'..');
const DIST=path.join(ROOT,'dist');
function findJavaHome(){const j='/opt/java/jdk1.8.0_212';
  if(process.env.JAVA_HOME&&fs.existsSync(path.join(process.env.JAVA_HOME,'bin','javac')))return process.env.JAVA_HOME;
  if(fs.existsSync(path.join(jdk(),'bin','javac')))return jdk();throw new Error('JDK not found');}
function jdk(){return '/opt/java/jdk1.8.0_212';}
function env(){const e={...process.env};e.JAVA_HOME=findJavaHome();e.PATH=path.join(findJavaHome(),'bin')+path.delimiter+e.PATH;return e;}
function findSdk(){return process.env.ANDROID_SDK_ROOT||process.env.ANDROID_HOME||'/opt/android_sdk';}
function findAapt(){const cs=['/usr/bin/aapt'];const bt=path.join(findSdk(),'build-tools');
  try{for(const v of fs.readdirSync(bt).sort().reverse())cs.push(path.join(bt,v,'aapt'));}catch(_){}
  for(const c of cs){try{execFileSync(c,['v'],{stdio:'ignore'});return c;}catch(_){}}
  throw new Error('no runnable aapt');}
function findSigner(){const bt=path.join(findSdk(),'build-tools');
  for(const v of fs.readdirSync(bt).sort().reverse()){const c=path.join(bt,v,'apksigner');
    if(fs.existsSync(c)){try{execFileSync(c,['--version'],{stdio:'ignore',env:env()});return c;}catch(_){}}}
  throw new Error('apksigner not found');}

const apks=fs.existsSync(DIST)?fs.readdirSync(DIST).filter(f=>f.endsWith('.apk')):[];
if(!apks.length){console.error('VERIFY FAILED: no APK in dist/');process.exit(1);}
const apk=path.join(DIST,apks[0]);
console.log('Verifying',apks[0]);
const badging=execFileSync(findAapt(),['dump','badging',apk],{encoding:'utf8'});
execFileSync(findAapt(),['list',apk],{encoding:'utf8'});
const out=execFileSync(findSigner(),['verify','--verbose',apk],{encoding:'utf8',env:env()});
const ok=/Verified using v\d scheme/i.test(out)&&!/NOT verified/i.test(out);
console.log('signature:',ok?'OK':'FAILED');
console.log(ok?'APK VERIFIED OK':'VERIFY FAILED');process.exit(ok?0:1);
