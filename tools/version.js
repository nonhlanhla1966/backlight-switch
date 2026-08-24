#!/usr/bin/env node
/*
 * Version management - single source of truth: AndroidManifest.xml.
 *
 *   node tools/version.js                 show current version
 *   node tools/version.js bump            increment versionCode, bump patch
 *   node tools/version.js bump minor      increment versionCode, bump minor
 *   node tools/version.js bump major      increment versionCode, bump major
 *
 * Only call this when producing a real release - routine dev builds do not
 * bump the version.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const MANIFEST = path.join(__dirname, '..', 'AndroidManifest.xml');

function read() {
  const m = fs.readFileSync(MANIFEST, 'utf8');
  const code = parseInt((m.match(/android:versionCode="(\d+)"/) || [])[1] || '1', 10);
  const name = (m.match(/android:versionName="([^"]+)"/) || [])[1] || '1.0.0';
  return { code, name };
}

function write(code, name) {
  let m = fs.readFileSync(MANIFEST, 'utf8');
  m = m.replace(/android:versionCode="[^"]*"/, `android:versionCode="${code}"`);
  m = m.replace(/android:versionName="[^"]*"/, `android:versionName="${name}"`);
  fs.writeFileSync(MANIFEST, m);
}

function bumpPart(name, part) {
  const parts = name.split('.').map(n => parseInt(n, 10) || 0);
  while (parts.length < 3) parts.push(0);
  if (part === 'major') { parts[0]++; parts[1] = 0; parts[2] = 0; }
  else if (part === 'minor') { parts[1]++; parts[2] = 0; }
  else { parts[2]++; }
  return parts.join('.');
}

const [, , cmd, partArg] = process.argv;
const cur = read();

if (!cmd || cmd === 'show' || cmd === 'current') {
  console.log(`versionName=${cur.name}`);
  console.log(`versionCode=${cur.code}`);
  process.exit(0);
}

if (cmd === 'bump') {
  const part = ['major', 'minor', 'patch'].includes(partArg) ? partArg : 'patch';
  const next = { code: cur.code + 1, name: bumpPart(cur.name, part) };
  write(next.code, next.name);
  console.log(`bumped (${part}): versionName=${next.name} versionCode=${next.code}`);
  process.exit(0);
}

console.error('usage: node tools/version.js [show|bump [major|minor|patch]]');
process.exit(2);
