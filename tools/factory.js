#!/usr/bin/env node
/*
 * Factory orchestrator - autonomous, resumable, multi-model pipeline.
 *
 *   node tools/factory.js "one-line app idea"        # full pipeline
 *   node tools/factory.js --resume                   # continue after a stop
 *   node tools/factory.js --status                   # show checkpoint state
 *
 * Unattended by design: routine decisions (files, tests, builds, commits,
 * pushes, transient retries) never prompt. Missing capabilities are reported
 * as exact requirements instead of interactive questions. Paid models are
 * never used without explicit FACTORY_ALLOW_PAID=1.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const Net = require('./net');
const Ckpt = require('./checkpoint');
const Models = require('./models');
const Perm = require('./perm');

/* ---------------- status display ---------------- */

function banner(kind, fields) {
  console.log('\n' + kind);
  Object.entries(fields || {}).forEach(([k, v]) => console.log(`${k}: ${v}`));
}

/* ---------------- file-application protocol ---------------- */

function applyFiles(modelText, root) {
  const applied = [];
  const re = /<<<FILE:\s*([^>]+?)\s*>>>\n([\s\S]*?)<<<END>>>/g;
  let m;
  while ((m = re.exec(String(modelText))) !== null) {
    const rel = m[1].trim();
    if (/^\/|^[A-Za-z]:[/\\]/.test(rel) || /(^|[/\\])\.\.([/\\]|$)/.test(rel) || /[\\]/.test(rel))
      throw new Error('unsafe path in model output: ' + rel);
    const dest = path.join(root, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, m[2]);
    applied.push(rel);
  }
  return applied;
}

/* ---------------- default real dependencies ---------------- */

function realDeps(root, env) {
  env = env || process.env;
  return {
    root,
    exec(cmd, args, opts) {
      const r = spawnSync(cmd, args, Object.assign({ cwd: root, encoding: 'utf8' }, opts));
      return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
    },
    async model(task, opts) {
      return Models.invoke(task, opts);
    }
  };
}

/* ---------------- stage implementations ---------------- */

const ROLE_PROMPTS = {
  design: 'You are the DESIGN model. Produce a compact product spec and UI/UX plan',
  coding: 'You are the CODING model. Produce complete files using the protocol <<<FILE: relative/path>>> ... <<<END>>>',
  debug: 'You are the DEBUG model. Produce the smallest correct fix as complete files using protocol <<<FILE: relative/path>>> ... <<<END>>>'
};

async function aiStage(pipeline, role, subjectPrompt) {
  const ctx = pipeline.ctx;
  banner('BUILDING', { Model: ctx.modelHint, Stage: role, Attempt: '1/' + Ckpt.MAX_CI_REPAIRS });
  const res = await pipeline.deps.model(
    { role, prompt: `${ROLE_PROMPTS[role]} for: ${subjectPrompt}` },
    ctx.modelOpts());
  const applied = applyFiles(res.text, pipeline.deps.root);
  banner('MODEL OK', { Model: res.model, Files: applied.join(', ') || '(plan only)' });
  return res;
}

function runTestStage(pipeline) {
  const d = pipeline.deps;
  banner('BUILDING', { Stage: 'npm test', Attempt: '1/' + Ckpt.MAX_LOCAL_REPAIRS });
  let r = d.exec(process.execPath, ['tests/run-tests.js']);
  let attempt = 1;
  /* finite automatic repair loop */
  while (r.status !== 0 && attempt < Ckpt.MAX_LOCAL_REPAIRS && pipeline.ctx.canRepair('local')) {
    banner('RECOVERING', { Reason: 'local test failure', Retry: `${attempt + 1}/${Ckpt.MAX_LOCAL_REPAIRS}` });
    pipeline.ctx.repair('local');
    attempt++;
    r = d.exec(process.execPath, ['tests/run-tests.js']);
  }
  if (r.status !== 0) {
    throw new Error('TEST failed after ' + attempt + ' attempt(s): ' +
      Models.redact((r.stderr || r.stdout).slice(-800)));
  }
  return true;
}

function runBuildStage(pipeline) {
  banner('BUILDING', { Stage: 'Android build', Model: 'n/a (GitHub Actions preferred)', Attempt: '1/3' });
  const r = pipeline.deps.exec(process.execPath, ['build.js']);
  if (r.status !== 0) {
    throw new Error('LOCAL_VALIDATION build failed: ' +
      Models.redact((r.stderr || r.stdout).slice(-800)));
  }
  return true;
}

function runPushStage(pipeline) {
  const d = pipeline.deps;
  return Net.withRetry(() => {
    let r = d.exec('git', ['add', '-A']);
    if (r.status !== 0) throw new Error('git add failed: ' + r.stderr);
    r = d.exec('git', ['-c', 'user.email=factory@local', '-c', 'user.name=AppFactory',
      'commit', '-m', 'factory: automated pipeline update']);
    if (r.status !== 0 && !/nothing to commit/.test(r.stdout + r.stderr)) {
      throw new Error('git commit failed: ' + r.stderr);
    }
    r = d.exec('git', ['push', 'origin', 'HEAD']);
    if (r.status !== 0) {
      const e = new Error('git push failed: ' + Models.redact(r.stderr));
      e.permanent = /Permission.*denied|Authentication|403/i.test(r.stderr);
      throw e;
    }
    return true;
  }, { label: 'git push', delayMs: 2000 });
}

function ghApi(root, reqPath) {
  const tokenFile = path.join(require('os').homedir(), '.cloudbuilder', 'gh_token');
  const token = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN ||
    (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : ''));
  return new Promise((resolve, reject) => {
    const https = require('https');
    https.get({ hostname: 'api.github.com', path,
      headers: { 'Authorization': 'token ' + token, 'User-Agent': 'app-factory-orchestrator',
        'Accept': 'application/vnd.github.v3+json' } },
      res => {
        let b = '';
        res.on('data', c => b += c);
        res.on('end', () => resolve({ status: res.statusCode,
          json: (() => { try { return JSON.parse(b); } catch (_) { return null; } })(),
          text: b }));
      }).on('error', reject);
  });
}

async function runCiStage(pipeline) {
  const d = pipeline.deps;
  const sha = d.exec('git', ['rev-parse', 'HEAD']).stdout.trim();
  const remote = d.exec('git', ['config', '--get', 'remote.origin.url']).stdout.trim();
  const m = remote.match(/github\.com[/:](.+?)\/(.+?)(?:\.git)?$/);
  if (!m) throw new Error('cannot parse origin remote: ' + remote);
  const slug = `${m[1]}/${m[2]}`;
  const timeoutMs = parseInt(process.env.OPENCODE_CLOUD_WAIT_SECONDS || '1800', 10) * 1000;
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const r = await Net.withRetry(() => d.api(`/repos/${slug}/actions/runs?head_sha=${sha}&per_page=5`),
      { label: 'Actions polling' });
    const run = ((r.json && r.json.workflow_runs) || []).find(x => x.head_sha === sha);
    banner('BUILDING', { Stage: 'GitHub Actions', Model: 'cloud runner',
      Attempt: `${pipeline.deps.state.repairs.ci + 1}/${Ckpt.MAX_CI_REPAIRS}` });
    if (run && run.status === 'completed') {
      if (run.conclusion === 'success') return run;
      return pipeline.ciRepair(slug, run); /* may recurse once per repair round */
    }
    await new Promise(res => setTimeout(res, 20000));
  }
  throw new Error('CI_BUILD timed out waiting for Actions run');
}

/* ---------------- pipeline assembly ---------------- */

function createPipeline(deps) {
  const state = deps.state;
  const pipeline = {
    deps,
    state,
    ctx: {
      get stateRef() { return state; },
      registry: deps.registry,
      health: deps.health,
      modelHint: (Models.route(deps.registry, { health: deps.health })[0] || {}).ref || 'none',
      canRepair(kind) {
        return kind === 'ci'
          ? state.repairs.ci < Ckpt.MAX_CI_REPAIRS
          : state.repairs.local < Ckpt.MAX_LOCAL_REPAIRS;
      },
      repair(kind) { state.repairs[kind]++; Ckpt.save(deps.root, state); },
      modelOpts() {
        return { registry: deps.registry, health: deps.health, root: deps.root,
          allowPaid: deps.allowPaid === true, validate:
            t => /./.test(String(t || '').trim()) ? true : 'empty model output' };
      }
    },
    async ciRepair(slug, failedRun) {
      if (!this.ctx.canRepair('ci')) {
        throw new Error(`CI_REPAIR exhausted (${Ckpt.MAX_CI_REPAIRS} attempts): ${failedRun.html_url}`);
      }
      banner('RECOVERING', { Reason: 'CI failure', Retry: `${state.repairs.ci + 1}/${Ckpt.MAX_CI_REPAIRS}` });
      this.ctx.repair('ci');
      const jobs = await Net.withRetry(() => this.deps.api(`/repos/${slug}/actions/runs/${failedRun.id}/jobs`),
        { label: 'job list' });
      const failedJob = ((jobs.json && jobs.json.jobs) || []).find(j => j.conclusion === 'failure');
      const logText = failedJob && this.deps.fetchLogs
        ? await this.deps.fetchLogs(failedJob.id) : '';
      const errTail = Models.redact(String(logText).split('\n')
        .filter(l => /error|failed|exception/i.test(l)).slice(-30).join('\n'));
      const res = await aiStage(this, 'debug', `CI log excerpt:\n${errTail}`);
      runTestStage(this);
      runPushStage(this);
      return runCiStage(this); /* wait for the new run */
    },
    stages: {
      IDEA(idea) { return idea || state.idea || null; },
      async DESIGN() { return aiStage(pipeline, 'design', state.idea || 'current app'); },
      async CODE() { return aiStage(pipeline, 'coding', state.idea || 'current app'); },
      TEST() { return runTestStage(pipeline); },
      LOCAL_VALIDATION() { return runBuildStage(pipeline); },
      GITHUB_PUSH() { return runPushStage(pipeline); },
      CI_BUILD() { return runCiStage(pipeline); },
      async APK_VERIFY() {
        banner('BUILDING', { Stage: 'Cloud APK verification', Attempt: '1/3' });
        const r = this.deps.exec(process.execPath, ['tools/fetch-cloud-apk.js']);
        if (r.status !== 0) throw new Error('APK_VERIFY failed: ' +
          Models.redact(((r.stderr || r.stdout) + '').slice(-500)));
        return true;
      },
      async RELEASE() {
        const r = this.deps.exec(process.execPath, ['tools/release.js']);
        if (r.status !== 0) throw new Error('RELEASE failed: ' +
          Models.redact(((r.stderr || r.stdout) + '').slice(-500)));
        const url = (r.stdout.split('\n').filter(l => /^https:\/\//.test(l.trim())).pop() || '').trim();
        return url;
      }
    },

    async run(startStage, ideaArg) {
      let stage = startStage || Ckpt.nextStage(state) || 'IDEA';
      let guard = 0;
      while (stage) {
        if (++guard > Ckpt.STAGES.length * (Ckpt.MAX_CI_REPAIRS + 1)) {
          throw new Error('stage loop guard tripped - aborting to avoid infinite loop');
        }
        if (stage === 'IDEA') {
          state.idea = ideaArg || state.idea;
          if (!state.idea) throw new Error('no app idea recorded; cannot start');
          Ckpt.complete(this.deps.root, state, 'IDEA', state.idea.slice(0, 120));
        } else if (stage === 'DOWNLOAD_READY') {
          const done = state.completed.RELEASE;
          const url = (done && done.artifact) || '';
          Ckpt.complete(this.deps.root, state, 'DOWNLOAD_READY', url);
          console.log('\nAPK READY — DOWNLOAD AVAILABLE ' + url);
          return { ok: true, url };
        } else {
          const fn = this.stages[stage];
          if (!fn) throw new Error('no implementation for stage ' + stage);
          const artifact = await fn.call(this, ideaArg);
          Ckpt.complete(this.deps.root, state, stage,
            artifact && typeof artifact === 'string' ? artifact : null);
        }
        stage = Ckpt.nextStage(state);
      }
      return { ok: true };
    }
  };
  return pipeline;
}

/* ---------------- CLI ---------------- */

async function main(argv) {
  const root = process.cwd();
  const args = argv.slice(2);
  const ideaIdx = args.findIndex(a => !a.startsWith('--'));
  const idea = ideaIdx !== -1 ? args[ideaIdx] : null;
  const resume = args.includes('--resume');

  /* capability survey first - report exact requirements, never prompt */
  const caps = Perm.survey(root);
  const blockers = [caps.projectWritable, caps.distWritable, caps.gitRemote]
    .flatMap(c => c.requiresUser || []);
  if (blockers.length) {
    console.error('FACTORY BLOCKED — genuine authorization required (not a routine prompt):');
    blockers.forEach(b => console.error(` - ${b.what}: ${b.exactRequirement} (${b.why})`));
    process.exit(3);
  }

  const state = resume || fs.existsSync(Ckpt.stateFile(root))
    ? Ckpt.load(root) : Ckpt.fresh(idea);
  if (idea) state.idea = idea;

  const discovery = Models.discover(process.env, process.env.HOME || '');
  let registry = discovery;
  if (discovery.note) console.log('[models] ' + discovery.note);

  const allowPaid = process.env.FACTORY_ALLOW_PAID === '1';
  try {
    /* fail fast with the clear paid-required message before doing work */
    Models.route(registry, { health: Models.loadHealth(root), allowPaid });
  } catch (e) {
    console.error(e.message);
    process.exit(4);
  }

  const deps = Object.assign(realDeps(root, process.env), {
    state, registry, health: Models.loadHealth(root), allowPaid,
    api: ghApi, fetchLogs: async jobId => {
      const r = await ghApi(root, `/repos/${slugOf(root)}/actions/jobs/${jobId}/logs`);
      return r.text || '';
    }
  });
  const plan = Ckpt.resumePlan(state, Ckpt.inspectRepo(root));
  banner('FACTORY RESUME', { From: plan.from, Skipped: plan.skip.length + ' completed stage(s)' });

  const result = await createPipeline(deps).run(plan.from, idea);
  if (result && result.ok) process.exit(0);
}

function slugOf(root) {
  const remote = spawnSync('git', ['-C', root, 'config', '--get', 'remote.origin.url'],
    { encoding: 'utf8' }).stdout.trim();
  const m = remote.match(/github\.com[/:](.+?)\/(.+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : '';
}

if (require.main === module) {
  main(process.argv).catch(err => {
    console.error('FACTORY FAILED:', Models.redact(err.message));
    process.exit(1);
  });
}

module.exports = { createPipeline, applyFiles, banner, realDeps };
