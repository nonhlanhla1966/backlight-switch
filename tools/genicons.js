#!/usr/bin/env node
/*
 * Backlight Switch launcher icon - pure Node (zlib built-in).
 * Glyph: warm glowing sun with 8 rays on a deep indigo gradient tile.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---- PNG encoding ---- */
const CRC_TABLE = (() => { const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t; })();
function crc32(b) { let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]); }
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w); ihdr.writeUInt32BE(h,4);
  ihdr[8]=8; ihdr[9]=6;
  const raw = Buffer.alloc(h*(w*4+1));
  for (let y=0;y<h;y++) { const s=y*(w*4+1); raw[s]=0;
    rgba.copy(raw,s+1,y*w*4,(y+1)*w*4); }
  return Buffer.concat([sig,chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw,{level:9})),chunk('IEND',Buffer.alloc(0))]);
}

function hex(c){return [parseInt(c.slice(1,3),16),parseInt(c.slice(3,5),16),parseInt(c.slice(5,7),16)];}
function lerp(a,b,t){return a+(b-a)*t;}
function mix(c1,c2,t){return [Math.round(lerp(c1[0],c2[0],t)),Math.round(lerp(c1[1],c2[1],t)),Math.round(lerp(c1[2],c2[2],t))];}

/* Sun in 48-unit space: disc r=8 at (24,25); 8 rays from r=11.5 to r=17,
 * ray half-angle ~7deg; soft glow halo r=13. */
const CX=24, CY=25;
function inSun(px, py) {
  const dx=px-CX, dy=py-CY, d=Math.sqrt(dx*dx+dy*dy);
  if (d <= 8) return 'disc';
  if (d <= 12.2 && d > 8) return 'glow';
  if (d >= 14.2 && d <= 19) {
    let ang = Math.atan2(dy, dx);            // -PI..PI
    if (ang < 0) ang += Math.PI * 2;         // 0..2PI
    const seg = ang / (Math.PI / 4);         // 8 segments
    const centre = (Math.floor(seg) + 0.5) * (Math.PI / 4);
    let off = Math.abs(ang - centre);
    // angular distance to nearest ray centre
    const maxOff = 0.10;                      // ~5.7deg half-width
    if (off > Math.PI/2) off = Math.abs(off - Math.PI);
    if (off <= maxOff) return 'ray';
  }
  return null;
}

function shapeAt(px, py) {
  const t = Math.min(1, Math.max(0, py / 48));
  let col = mix(hex('#2b3350'), hex('#10131f'), t);   // deep indigo gradient
  const s = inSun(px, py);
  if (s === 'disc') col = hex('#ffd166');
  else if (s === 'ray') col = hex('#ffb545');
  else if (s === 'glow') {
    const dx=px-CX, dy=py-CY, d=Math.sqrt(dx*dx+dy*dy);
    col = mix(hex('#ffd166'), col, (d-8)/(12.2-8));    // fade glow into bg
  }
  return col;
}

function draw(size, round){
  const S=size/48,img=Buffer.alloc(size*size*4),SS=3,R=23.4;
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    let r=0,g=0,b=0,a=0;
    for(let sy=0;sy<SS;sy++)for(let sx=0;sx<SS;sx++){
      const dx=(x+(sx+.5)/SS)/S,dy=(y+(sy+.5)/SS)/S;
      if(round){const ex=dx-24,ey=dy-24;if(ex*ex+ey*ey>R*R)continue;}
      const c=shapeAt(dx,dy);r+=c[0];g+=c[1];b+=c[2];a++;
    }
    const i=(y*size+x)*4,n=SS*SS;
    img[i]=a?Math.round(r/a):0;img[i+1]=a?Math.round(g/a):0;
    img[i+2]=a?Math.round(b/a):0;img[i+3]=Math.round((a/n)*255);
  }
  return img;
}

const DENSITIES={mdpi:48,hdpi:72,xhdpi:96,xxhdpi:144,xxxhdpi:192};
const outRoot=path.join(__dirname,'..','res');
for(const[d,size]of Object.entries(DENSITIES)){
  const dir=path.join(outRoot,'mipmap-'+d);
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'ic_launcher.png'),encodePNG(size,size,draw(size,false)));
  fs.writeFileSync(path.join(dir,'ic_launcher_round.png'),encodePNG(size,size,draw(size,true)));
  console.log('mipmap-'+d+': OK');
}
console.log('Icons generated.');
