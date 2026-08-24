#!/usr/bin/env node
/*
 * Factory checkpoint / resume system.
 *
 * Persistent, crash-safe stage tracking for the unattended pipeline:
 * IDEA -> DESIGN -> CODE -> TEST -> LOCAL_VALIDATION -> GITHUB_PUSH ->
 * CI_BUILD -> (CI_REPAIR) -> APK_VERIFY -> RELEASE -> DOWNLOAD_READY.
 *
 * State lives in <root>/.factory-state.json (git-ignored). After any stop,
 * resumePlan() inspects the last completed checkpoint plus the repository
 * and returns the safest unfinished stage - completed work is never redone.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const STAGES = ['IDEA', 'DESIGN', 'CODE', 'TEST', 'LOCAL_VALIDATION',
  'GITHUB_PUSH', 'CI_BUILD', 'CI_REPAIR', 'APK_VERIFY', 'RELEASE', 'DOWNLOAD_READY'];

const STATE_FILE = '.factory-state.json';
const MAX_CI_REPAIRS = 3;
const MAX_LOCAL_REPAIRS = 3;

function stateFile(root) { return path.join(root || process.cwd(), STATE_FILE); }

function load(root) {
  const f = stateFile(root);
  if (fs.existsSync(f)) {
    try {
      const s = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (s && s.version === 1) return normalize(s);
    } catch (_) { /* corrupted state -> start clean, never crash-resume on garbage */ }
  }
  return fresh();
}

function fresh(idea) {
  return {
    version: 1,
    idea: idea || null,
    stage: 'IDEA',
    completed: {},            /* STAGE -> { at, artifact } */
    repairs: { ci: 0, local: 0 },
    lastError: null,
    updatedAt: new Date().toISOString()
  };
}

function normalize(s) {
  const base = fresh(s.idea);
  base.stage = STAGES.includes(s.stage) ? s.stage : base.stage;
  base.completed = s.completed && typeof s.completed === 'object' ? s.completed : {};
  if (s.repairs && typeof s.repairs === 'object') {
    base.repairs.ci = Number(s.repairs.ci) || 0;
    base.repairs.local = Number(s.repairs.local) || 0;
  }
  base.lastError = s.lastError || null;
  return base;
}

function save(root, state) {
  state.updatedAt = new Date().toISOString();
  const tmp = stateFile(root) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, stateFile(root)); /* atomic: never a half-written checkpoint */
  return state;
}

function isCompleted(state, stage) { return !!state.completed[stage]; }

/* Mark a stage done and advance the cursor to the next stage. */
function complete(root, state, stage, artifact) {
  if (!STAGES.includes(stage)) throw new Error('unknown stage: ' + stage);
  state.completed[stage] = { at: new Date().toISOString(), artifact: artifact || null };
  const idx = STAGES.indexOf(stage);
  const next = STAGES[idx + 1];
  if (next && (state.stage === stage || STAGES.indexOf(state.stage) <= idx)) state.stage = next;
  return save(root, state);
}

/* First not-completed stage at or after the cursor. */
function nextStage(state) {
  for (let i = STAGES.indexOf(state.stage); i < STAGES.length; i++) {
    if (!isCompleted(state, STAGES[i])) return STAGES[i];
  }
  return null; /* everything done */
}

/* Cheap repository inspection so resume never repeats expensive work:
 * an existing verified dist/ APK means cloud fetch can be skipped only if
 * its checkpoint exists - presence alone never marks CI stages complete. */
function inspectRepo(root) {
  const r = { root, hasGit: fs.existsSync(path.join(root, '.git')),
    distApks: [], hasManifest: false };
  try {
    const dist = path.join(root, 'dist');
    if (fs.existsSync(dist)) {
      r.distApks = fs.readdirSync(dist)
        .filter(f => f.endsWith('.apk') && !f.endsWith('.part'));
    }
    r.hasManifest = fs.existsSync(path.join(root, 'AndroidManifest.xml'));
  } catch (_) { /* unreadable dist treated as empty */ }
  return r;
}

/*
 * Resume decision. Returns { from, skip, reason } where `from` is the stage
 * to run and `skip` lists completed stages that must NOT be repeated.
 */
function resumePlan(state, repo) {
  repo = repo || inspectRepo(state.root || process.cwd());
  const skip = Object.keys(state.completed);
  let from = nextStage(state);

  /* Safety upgrades from repository reality: */
  if ((from === 'IDEA' || from === 'DESIGN' || from === 'CODE') &&
      repo.hasManifest && !state.idea) {
    /* Existing app with no recorded idea: code already exists. */
    from = 'TEST';
    skip.push('IDEA', 'DESIGN', 'CODE');
  }
  if (from === 'LOCAL_VALIDATION' && !repo.hasManifest) {
    throw new Error('cannot build: AndroidManifest.xml missing');
  }
  return { from, skip: [...new Set(skip)], reason: 'resume from safest unfinished stage' };
}

module.exports = { STAGES, STATE_FILE, MAX_CI_REPAIRS, MAX_LOCAL_REPAIRS,
  load, save, fresh, complete, nextStage, isCompleted, resumePlan, inspectRepo, stateFile };
