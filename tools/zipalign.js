#!/usr/bin/env node
/*
 * Pure-Node.js replacement for Android SDK `zipalign` (which ships only as an
 * x86-64 binary and cannot run on this aarch64 host).
 *
 * Aligns uncompressed ("stored") ZIP entries so their data starts on a
 * multiple-of-4 byte offset, matching `zipalign -f 4 <in> <out>` behaviour,
 * by growing the local header extra field with padding (ID 0xd935, as AOSP does).
 *
 * Usage: node zipalign.js <infile> <outfile>
 */
'use strict';

const fs = require('fs');

const U16 = b => b.readUInt16LE(0);
const U32 = b => b.readUInt32LE(0);

function fail(msg) { console.error('zipalign: ' + msg); process.exit(1); }

const [, , inFile, outFile] = process.argv;
if (!inFile || !outFile) fail('usage: node zipalign.js <infile> <outfile>');

const buf = fs.readFileSync(inFile);

/* ---- locate End Of Central Directory ---- */
let eocdPos = -1;
for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) { eocdPos = i; break; }
}
if (eocdPos < 0) fail('EOCD not found');

const entryCount = buf.readUInt16LE(eocdPos + 10);
const cdSize = buf.readUInt32LE(eocdPos + 12);
const cdOffset = buf.readUInt32LE(eocdPos + 16);
const eocdTail = buf.slice(eocdPos + 22); // archive comment etc.

/* ---- parse central directory ---- */
const entries = [];
let p = cdOffset;
for (let n = 0; n < entryCount; n++) {
  if (U32(buf.slice(p)) !== 0x02014b50) fail('bad central directory signature');
  const e = {
    cdStart: p,
    versionMadeBy: buf.readUInt16LE(p + 4),
    versionNeeded: buf.readUInt16LE(p + 6),
    flags: buf.readUInt16LE(p + 8),
    method: buf.readUInt16LE(p + 10),
    modTime: buf.readUInt16LE(p + 12),
    modDate: buf.readUInt16LE(p + 14),
    crc32: buf.readUInt32LE(p + 16),
    compSize: buf.readUInt32LE(p + 20),
    uncompSize: buf.readUInt32LE(p + 24),
    nameLen: buf.readUInt16LE(p + 28),
    extraLen: buf.readUInt16LE(p + 30),
    commentLen: buf.readUInt16LE(p + 32),
    diskStart: buf.readUInt16LE(p + 34),
    intAttrs: buf.readUInt16LE(p + 36),
    extAttrs: buf.readUInt32LE(p + 38),
    localOffset: buf.readUInt32LE(p + 42)
  };
  e.name = buf.slice(p + 46, p + 46 + e.nameLen);
  e.extra = buf.slice(p + 46 + e.nameLen, p + 46 + e.nameLen + e.extraLen);
  e.comment = buf.slice(p + 46 + e.nameLen + e.extraLen, p + 46 + e.nameLen + e.extraLen + e.commentLen);
  entries.push(e);
  p += 46 + e.nameLen + e.extraLen + e.commentLen;
}
if (p !== cdOffset + cdSize) fail('central directory size mismatch');

/* ---- rebuild archive with aligned stored entries ---- */
const ALIGN = 4;
const parts = [];
let outPos = 0;

function push(b) { parts.push(b); outPos += b.length; }

for (const e of entries) {
  if (e.flags & 0x08) fail(`data-descriptor entries unsupported (${e.name})`);

  // parse original local header
  const lo = e.localOffset;
  if (U32(buf.slice(lo)) !== 0x04034b50) fail('bad local header signature');
  const lNameLen = buf.readUInt16LE(lo + 26);
  const lExtraLen = buf.readUInt16LE(lo + 28);
  const lName = buf.slice(lo + 30, lo + 30 + lNameLen);
  const lExtra = buf.slice(lo + 30 + lNameLen, lo + 30 + lNameLen + lExtraLen);
  const dataStart = lo + 30 + lNameLen + lExtraLen;
  const data = buf.slice(dataStart, dataStart + e.compSize);

  // compute padding so that (offset of data start) % 4 == 0 for stored entries
  let pad = 0;
  let extraOut;
  if (e.method === 0 && e.compSize > 0) {
    const base = outPos + 30 + lNameLen;
    pad = (ALIGN - ((base + lExtraLen) % ALIGN)) % ALIGN;
    if (pad > 0) {
      // shrink existing extra first if it leaves room, else append a padding field
      const keepFrom = Math.max(0, lExtraLen - pad);
      const kept = lExtra.slice(keepFrom); // may truncate old extras; they are optional metadata
      const padField = Buffer.alloc(4 + pad);
      padField.writeUInt16LE(0xd935, 0); // AOSP zipalign padding ID
      padField.writeUInt16LE(pad, 2);
      extraOut = Buffer.concat([kept, padField]);
    } else {
      extraOut = lExtra;
    }
  } else {
    extraOut = lExtra;
  }

  const newLocalOffset = outPos;

  // rewrite local header
  const lh = Buffer.alloc(30);
  U32; // noop to keep linter quiet about unused helper
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(buf.readUInt16LE(lo + 4), 4);   // version needed
  lh.writeUInt16LE(buf.readUInt16LE(lo + 6), 6);   // flags
  lh.writeUInt16LE(e.method, 8);
  lh.writeUInt16LE(e.modTime, 10);
  lh.writeUInt16LE(e.modDate, 12);
  lh.writeUInt32LE(e.crc32, 14);
  lh.writeUInt32LE(e.compSize, 18);
  lh.writeUInt32LE(e.uncompSize, 22);
  lh.writeUInt16LE(lNameLen, 26);
  lh.writeUInt16LE(extraOut.length, 28);

  push(lh);
  push(lName);
  push(extraOut);
  push(data);

  e.newLocalOffset = newLocalOffset;
  e.newExtraForCd = extraOut;
}

/* ---- rebuild central directory ---- */
const cdParts = [];
let cdLen = 0;
for (const e of entries) {
  const extra = e.newExtraForCd;
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt16LE(e.versionMadeBy, 4);
  h.writeUInt16LE(e.versionNeeded, 6);
  h.writeUInt16LE(e.flags, 8);
  h.writeUInt16LE(e.method, 10);
  h.writeUInt16LE(e.modTime, 12);
  h.writeUInt16LE(e.modDate, 14);
  h.writeUInt32LE(e.crc32, 16);
  h.writeUInt32LE(e.compSize, 20);
  h.writeUInt32LE(e.uncompSize, 24);
  h.writeUInt16LE(e.name.length, 28);
  h.writeUInt16LE(extra.length, 30);
  h.writeUInt16LE(e.comment.length, 32);
  h.writeUInt16LE(e.diskStart, 34);
  h.writeUInt16LE(e.intAttrs, 36);
  h.writeUInt32LE(e.extAttrs, 38);
  h.writeUInt32LE(e.newLocalOffset, 42);
  cdParts.push(h, e.name, extra, e.comment);
  cdLen += 46 + e.name.length + extra.length + e.comment.length;
}

const newCdOffset = outPos;
push(Buffer.concat(cdParts));

/* ---- EOCD ---- */
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(entries.length, 8);
eocd.writeUInt16LE(entries.length, 10);
eocd.writeUInt32LE(cdLen, 12);
eocd.writeUInt32LE(newCdOffset, 16);
eocd.writeUInt16LE(0, 20);
push(eocd);
if (eocdTail.length) push(eocdTail);

fs.writeFileSync(outFile, Buffer.concat(parts));
console.log(`zipalign: ${entries.length} entries aligned -> ${outFile}`);
