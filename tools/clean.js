#!/usr/bin/env node
/* Removes generated build artifacts. Zero dependencies. */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
for (const dir of ['build', 'dist']) {
  fs.rmSync(path.join(ROOT, dir), { recursive: true, force: true });
  console.log(`removed ${dir}/`);
}
