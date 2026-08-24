#!/usr/bin/env node
/*
 * Factory capability checks - "try before ask" doctrine.
 *
 * The factory NEVER prompts interactively for routine operations. When a
 * capability is missing, it returns a structured report of exactly what the
 * environment/Android requires instead of blocking on a question.
 * Android security is never bypassed, faked, or weakened here.
 */
'use strict';

const fs = require('fs');
const path = require('path');

function probeWrite(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    const probe = path.join(dir, `.factory-probe-${process.pid}`);
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    return { ok: true };
  } catch (err) {
    const code = err.code || 'EUNKNOWN';
    return {
      ok: false,
      requiresUser: [{
        what: `write access to ${dir}`,
        why: `filesystem returned ${code}`,
        exactRequirement: code === 'EACCES' || code === 'EPERM'
          ? 'Android storage grant or IDE file-provider permission for this directory'
          : `resolve filesystem error ${code} for this directory`
      }]
    };
  }
}

function checkGitRemote(root) {
  try {
    require('child_process').execFileSync('git', ['-C', root, 'ls-remote', '--heads', 'origin'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      requiresUser: [{
        what: 'authenticated GitHub access for origin',
        why: 'git ls-remote failed',
        exactRequirement: require('./models').redact(String(err.message || err)).slice(0, 200)
      }]
    };
  }
}

/** Aggregate check used before pipeline stages run. Never prompts. */
function survey(root) {
  return {
    projectWritable: probeWrite(root),
    distWritable: probeWrite(path.join(root, 'dist')),
    gitRemote: root && require('fs').existsSync(path.join(root, '.git'))
      ? checkGitRemote(root) : { ok: true }
  };
}

module.exports = { probeWrite, checkGitRemote, survey };
