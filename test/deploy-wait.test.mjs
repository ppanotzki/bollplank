import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, acmeConfig, fakesSkip, isWindows, gitRepo, bin } from './helpers.mjs';
import { sameCommit } from '../lib/commands/deploy-wait.mjs';

const commit = 'abc1234def5678abc1234def5678abc1234def56';
const other = '0123456789abcdef0123456789abcdef01234567';

// A fake aws or gh that prints the next answer of a sequence on each call and logs its arguments
// and AWS_PROFILE. The last answer repeats.
const fakeSeq = `
const fs = require('fs');
const seq = JSON.parse(fs.readFileSync(process.env.FAKE_SEQ, 'utf8'));
const countFile = process.env.FAKE_SEQ + '.count';
const n = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0;
fs.writeFileSync(countFile, String(n + 1));
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2), profile: process.env.AWS_PROFILE ?? null }) + '\\n');
const answer = seq[Math.min(n, seq.length - 1)];
if (answer.fail) { process.stderr.write(answer.fail + '\\n'); process.exit(1); }
console.log(JSON.stringify(answer.out));
`;

// The probe a command deploy runs. It records where it ran and what it saw there, in a file named
// after the commit it was given. PROBE_SLEEP keeps it running for that many milliseconds first.
const probe = `
const { execFileSync } = require('child_process');
const fs = require('fs');
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
const first = git('rev-parse', 'HEAD');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.PROBE_SLEEP || 0));
fs.writeFileSync(process.env.PROBE_OUT + '.' + process.argv[2], JSON.stringify({ cwd: process.cwd(), first, head: git('rev-parse', 'HEAD'), status: git('status', '--porcelain'), nodeModules: fs.existsSync('node_modules/x/index.js') }));
`;

// A source repo with a bare origin and two commits on main, both pushed. node_modules is ignored,
// as in a real repo, and holds one file.
function sourceRepo(src, name) {
  const g = gitRepo(src, name, 'main');
  g.commit('.gitignore', 'node_modules/\n');
  const c1 = g.commit('a.txt', 'one\n');
  const c2 = g.commit('a.txt', 'two\n');
  g.git('push', '-q', 'origin', 'main');
  mkdirSync(join(g.work, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(g.work, 'node_modules', 'x', 'index.js'), '');
  return { ...g, c1, c2 };
}

const worktrees = (work) => execFileSync('git', ['-C', work, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }).split('\n').filter((l) => l.startsWith('worktree '));

function setup(t) {
  const s = sandbox();
  t.after(s.clean);
  const src = join(s.root, 'src');
  const script = join(s.root, 'deploy-check.js');
  writeFileSync(script, 'process.exit(process.argv[2] === process.env.EXPECT ? 0 : 3);\n');
  const probeFile = join(s.root, 'probe.js');
  writeFileSync(probeFile, probe);
  const probeCmd = `node ${JSON.stringify(probeFile)} {commit}`;
  const cmd = (command, extra = {}) => ({ checks: ['checks'], baseBranch: 'main', deploy: { kind: 'command', command }, ...extra });
  const repos = {
    'acme-none': { github: 'acme/acme-none', checks: ['checks'] },
    'acme-cmd': { github: 'acme/acme-cmd', ...cmd(`node ${JSON.stringify(script)} {commit}`) },
    'acme-probe': { github: 'acme/acme-probe', ...cmd(probeCmd) },
    'acme-probe-nm': { github: 'acme/acme-probe-nm', ...cmd(probeCmd, { cloneNodeModules: true }) },
    'acme-gone': { github: 'acme/acme-gone', ...cmd(probeCmd) },
    // A background program that ignores SIGTERM and lets go of the output, and one that keeps it.
    'acme-bg': { github: 'acme/acme-bg', ...cmd(`(trap '' TERM; exec sleep 20) > /dev/null 2>&1 & echo $! > ${JSON.stringify(join(s.root, 'bg.pid'))}; exit 0`) },
    'acme-pipe': { github: 'acme/acme-pipe', ...cmd(`sleep 20 & echo $! > ${JSON.stringify(join(s.root, 'pipe.pid'))}; exit 0`) },
    // A command that locks its own worktree, so git refuses to remove it.
    'acme-lock': { github: 'acme/acme-lock', ...cmd('git worktree lock "$PWD"') },
    'acme-hold': { github: 'acme/acme-hold', ...cmd(`pwd > ${JSON.stringify(join(s.root, 'hold.cwd'))}; sleep 30 & echo $! > ${JSON.stringify(join(s.root, 'hold.pid'))}; wait`) },
    'acme-amp': { github: 'acme/acme-amp', checks: ['checks'], baseBranch: 'main', deploy: { kind: 'amplify', appId: 'd1acme', region: 'eu-west-1', profile: 'acme-deploy' } },
    'acme-gha': { github: 'acme/acme-gha', checks: ['checks'], deploy: { kind: 'github-actions', workflow: 'deploy' } },
    // A shell that starts a program in the background and waits for it, so a timeout must stop
    // the whole process group to stop the program.
    'acme-slow': { github: 'acme/acme-slow', ...cmd(`pwd > ${JSON.stringify(join(s.root, 'slow.cwd'))}; sleep 30 & echo $! > ${JSON.stringify(join(s.root, 'child.pid'))}; wait`) },
  };
  s.config(acmeConfig(src, join(s.root, 'tickets'), repos));
  const git = {};
  for (const name of ['acme-cmd', 'acme-probe', 'acme-probe-nm', 'acme-hold', 'acme-slow', 'acme-bg', 'acme-pipe', 'acme-lock']) git[name] = sourceRepo(src, name);
  const probeOut = join(s.root, 'probe-out');
  const seen = (c) => JSON.parse(readFileSync(`${probeOut}.${c}`, 'utf8'));
  s.fake('aws', fakeSeq);
  s.fake('gh', fakeSeq);
  const seqFile = join(s.root, 'seq.json');
  const logFile = join(s.root, 'log.jsonl');
  const seq = (answers) => {
    writeFileSync(seqFile, JSON.stringify(answers));
    writeFileSync(seqFile + '.count', '0');
    writeFileSync(logFile, '');
  };
  const log = () => readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const env = (more = {}) => ({ FAKE_SEQ: seqFile, FAKE_LOG: logFile, PROBE_OUT: probeOut, EXPECT: git['acme-cmd'].c2, ...more });
  const wait = (repo, c = commit, ...a) => s.run(['deploy-wait', 'acme-shop', repo, c, '--interval', '1', ...a], env());
  // The same call, started without waiting for it, for overlapping calls and signals.
  const start = (repo, c, more = {}) => {
    const child = spawn(process.execPath, [bin, 'deploy-wait', 'acme-shop', repo, c], { env: { ...s.env, ...env(more) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (out += d));
    const done = new Promise((res) => child.on('close', (code) => res({ status: code, json: JSON.parse(out) })));
    return { child, done };
  };
  return { s, seq, log, wait, start, git, seen };
}

test('a repo without a deploy returns at once', (t) => {
  const f = setup(t);
  const r = f.wait('acme-none');
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.kind, 'none');
  assert.equal(r.json.status, 'succeeded');
  assert.equal(r.json.ref, 'none');
});

test('a command deploy runs the command with the commit and uses its exit code', (t) => {
  const f = setup(t);
  const { c1, c2 } = f.git['acme-cmd'];
  let r = f.wait('acme-cmd', c2);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.exitCode, 0);
  assert.ok(r.json.command.endsWith(c2));
  assert.equal(r.json.status, 'succeeded');
  assert.equal(r.json.checkout, 'clean');
  assert.equal(r.json.ref, r.json.command);
  r = f.wait('acme-cmd', c1);
  assert.equal(r.status, 1);
  assert.equal(r.json.failure, 'deploy-failed');
  assert.equal(r.json.status, 'failed');
  assert.equal(r.json.exitCode, 3);
});

test('a command that runs past the timeout is stopped with every program it started', { skip: isWindows ? 'process groups are POSIX' : false }, async (t) => {
  const f = setup(t);
  const r = f.wait('acme-slow', f.git['acme-slow'].c2, '--timeout', '1');
  assert.equal(r.status, 1, r.stdout);
  assert.equal(r.json.status, 'timeout');
  assert.equal(r.json.failure, 'timeout');
  assert.match(r.json.ref, /^pwd > .*sleep 30 &/);
  // The checkout it ran in is gone, and the repo lists only its own folder.
  assert.equal(existsSync(readFileSync(join(f.s.root, 'slow.cwd'), 'utf8').trim()), false);
  assert.equal(worktrees(f.git['acme-slow'].work).length, 1);
  const pid = Number(readFileSync(join(f.s.root, 'child.pid'), 'utf8'));
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 50 && alive(); i++) await new Promise((res) => setTimeout(res, 100));
  assert.equal(alive(), false, 'the background sleep was stopped');
});

test('an amplify deploy waits for the job that built the commit, never the latest job', { skip: fakesSkip }, (t) => {
  const f = setup(t);
  const latestOther = { jobId: '9', commitId: other, status: 'SUCCEED' };
  f.seq([
    { out: { jobSummaries: [latestOther] } },
    { out: { jobSummaries: [latestOther, { jobId: '8', commitId: commit, status: 'RUNNING' }] } },
    { out: { jobSummaries: [latestOther, { jobId: '8', commitId: commit, status: 'SUCCEED' }] } },
  ]);
  const r = f.wait('acme-amp');
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.jobId, '8');
  assert.equal(r.json.jobStatus, 'SUCCEED');
  assert.equal(r.json.status, 'succeeded');
  assert.equal(r.json.ref, '8');
  const calls = f.log();
  assert.equal(calls.length, 3);
  const argv = calls[0].argv;
  assert.deepEqual([argv[argv.indexOf('--app-id') + 1], argv[argv.indexOf('--branch-name') + 1], argv[argv.indexOf('--region') + 1], argv[argv.indexOf('--max-items') + 1]], ['d1acme', 'main', 'eu-west-1', '50']);
  assert.equal(calls[0].profile, 'acme-deploy');
});

test('an amplify deploy reports a failed job, a timeout and an aws failure', { skip: fakesSkip }, (t) => {
  const f = setup(t);
  // A short commit id in upper case is the same commit.
  f.seq([{ out: { jobSummaries: [{ jobId: '8', commitId: commit.slice(0, 12).toUpperCase(), status: 'FAILED' }] } }]);
  let r = f.wait('acme-amp');
  assert.equal(r.status, 1);
  assert.equal(r.json.failure, 'deploy-failed');
  assert.equal(r.json.status, 'failed');
  assert.equal(r.json.jobStatus, 'FAILED');
  assert.equal(r.json.ref, '8');
  f.seq([{ out: { jobSummaries: [] } }]);
  r = f.wait('acme-amp', commit, '--timeout', '0.2');
  assert.equal(r.json.failure, 'timeout');
  assert.equal(r.json.status, 'timeout');
  assert.equal(r.json.ref, 'none');
  assert.match(r.json.detail, /no job for this commit/);
  assert.ok(f.log().length >= 2);
  f.seq([{ fail: 'Unable to locate credentials' }]);
  r = f.wait('acme-amp');
  assert.equal(r.json.failure, 'aws-failed');
  assert.equal(r.json.status, 'failed');
  assert.match(r.json.detail, /Unable to locate credentials/);
});

test('a github-actions deploy waits for the named workflow run on the commit', { skip: fakesSkip }, (t) => {
  const f = setup(t);
  f.seq([
    { out: [] },
    { out: [{ databaseId: 11, status: 'in_progress', conclusion: '', headSha: commit, createdAt: '2026-11-02T10:00:00Z' }] },
    { out: [{ databaseId: 11, status: 'completed', conclusion: 'success', headSha: commit, url: 'https://example.invalid/run/11', createdAt: '2026-11-02T10:00:00Z' }] },
  ]);
  const r = f.wait('acme-gha');
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.runId, 11);
  assert.equal(r.json.conclusion, 'success');
  assert.equal(r.json.status, 'succeeded');
  assert.equal(r.json.runStatus, 'completed');
  assert.equal(r.json.ref, '11');
  const argv = f.log()[0].argv;
  assert.deepEqual(argv.slice(0, 2), ['run', 'list']);
  assert.equal(argv[argv.indexOf('--commit') + 1], commit);
  assert.equal(argv[argv.indexOf('--workflow') + 1], 'deploy');
  assert.equal(argv[argv.indexOf('-R') + 1], 'acme/acme-gha');
});

test('a github-actions deploy reports a failed run, the newest rerun deciding, and a timeout', { skip: fakesSkip }, (t) => {
  const f = setup(t);
  f.seq([{ out: [
    { databaseId: 11, status: 'completed', conclusion: 'success', headSha: commit, createdAt: '2026-11-02T10:00:00Z' },
    { databaseId: 12, status: 'completed', conclusion: 'failure', headSha: commit, createdAt: '2026-11-02T11:00:00Z' },
  ] }]);
  let r = f.wait('acme-gha');
  assert.equal(r.status, 1);
  assert.equal(r.json.failure, 'deploy-failed');
  assert.equal(r.json.runId, 12);
  assert.equal(r.json.status, 'failed');
  f.seq([{ out: [{ databaseId: 13, status: 'queued', conclusion: '', headSha: commit.toUpperCase() }] }]);
  r = f.wait('acme-gha', commit, '--timeout', '0.2');
  assert.equal(r.json.failure, 'timeout');
  assert.equal(r.json.status, 'timeout');
  assert.equal(r.json.ref, '13');
  assert.match(r.json.detail, /run 13 still queued/);
});

test('a command deploy runs in a clean checkout of the commit, never in the source folder', (t) => {
  const f = setup(t);
  const g = f.git['acme-probe'];
  // The source folder is behind the merge commit, with a local edit and an untracked file.
  g.git('checkout', '-q', g.c1);
  writeFileSync(join(g.work, 'a.txt'), 'edited here\n');
  writeFileSync(join(g.work, 'stray.txt'), 'untracked\n');
  const r = f.wait('acme-probe', g.c2);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.checkout, 'clean');
  assert.equal(r.json.nodeModules, null);
  const seen = f.seen(g.c2);
  assert.equal(seen.head, g.c2);
  assert.equal(seen.status, '');
  assert.notEqual(seen.cwd, g.work);
  assert.equal(seen.nodeModules, false);
  // The checkout is gone, and the source folder keeps its revision and its edits.
  assert.equal(existsSync(seen.cwd), false);
  assert.equal(worktrees(g.work).length, 1);
  assert.equal(g.git('rev-parse', 'HEAD'), g.c1);
  assert.equal(readFileSync(join(g.work, 'a.txt'), 'utf8'), 'edited here\n');
  assert.ok(existsSync(join(g.work, 'stray.txt')));
});

test('a command deploy that fails still removes its checkout', (t) => {
  const f = setup(t);
  const g = f.git['acme-probe'];
  const r = f.s.run(['deploy-wait', 'acme-shop', 'acme-probe', g.c1], { PROBE_OUT: join(f.s.root, 'no-such-folder', 'out') });
  assert.equal(r.status, 1, r.stdout);
  assert.equal(r.json.failure, 'deploy-failed');
  assert.equal(r.json.checkout, 'clean');
  assert.equal(worktrees(g.work).length, 1);
});

test('node_modules is in the checkout only when the repo has cloneNodeModules', (t) => {
  const f = setup(t);
  const g = f.git['acme-probe-nm'];
  const r = f.wait('acme-probe-nm', g.c2);
  assert.equal(r.status, 0, r.stdout);
  assert.ok(['cloned', 'copied'].includes(r.json.nodeModules));
  const seen = f.seen(g.c2);
  assert.equal(seen.nodeModules, true);
  // node_modules is ignored, so the checkout is still clean.
  assert.equal(seen.status, '');
  assert.equal(worktrees(g.work).length, 1);
});

test('only a commit on the base branch at origin is checked out', (t) => {
  const f = setup(t);
  const g = f.git['acme-probe'];
  // A commit made here and never pushed.
  const local = g.commit('b.txt', 'local\n');
  let r = f.wait('acme-probe', local);
  assert.equal(r.status, 1, r.stdout);
  assert.equal(r.json.failure, 'commit-missing');
  assert.equal(r.json.status, 'failed');
  assert.match(r.json.detail, /not on origin\/main/);
  // A commit pushed only to a side branch.
  g.git('checkout', '-q', '-b', 'side', g.c2);
  const side = g.commit('c.txt', 'side\n');
  g.git('push', '-q', 'origin', 'side');
  r = f.wait('acme-probe', side);
  assert.equal(r.json.failure, 'commit-missing');
  // A commit no repo has.
  r = f.wait('acme-probe', other);
  assert.equal(r.json.failure, 'commit-missing');
  // A branch whose name looks like a commit id is not that commit.
  g.git('branch', 'deadbee1', g.c2);
  r = f.wait('acme-probe', 'deadbee1');
  assert.equal(r.json.failure, 'commit-missing');
  assert.equal(worktrees(g.work).length, 1);
  // A repo whose folder is missing, and one whose folder is a plain folder.
  r = f.wait('acme-gone', g.c2);
  assert.equal(r.status, 1, r.stdout);
  assert.equal(r.json.failure, 'no-checkout');
  mkdirSync(join(f.s.root, 'src', 'acme-gone'));
  r = f.wait('acme-gone', g.c2);
  assert.equal(r.json.failure, 'no-checkout');
  // A plain folder inside another git repo is not the repo either.
  execFileSync('git', ['init', '-q', join(f.s.root, 'src')]);
  r = f.wait('acme-gone', g.c2);
  assert.equal(r.json.failure, 'no-checkout');
  // A commit already on origin/main needs no fetch, and a fetch that fails names the fetch.
  g.git('checkout', '-q', 'main');
  g.git('remote', 'set-url', 'origin', join(f.s.root, 'no-such-origin.git'));
  r = f.wait('acme-probe', g.c2);
  assert.equal(r.status, 0, r.stdout);
  r = f.wait('acme-probe', local);
  assert.equal(r.json.failure, 'commit-missing');
  assert.match(r.json.detail, /git fetch origin failed/);
  assert.equal(worktrees(g.work).length, 1);
});

test('two calls at once each keep their own checkout for their whole run', async (t) => {
  const f = setup(t);
  const g = f.git['acme-probe'];
  // Origin has moved past what the source folder knows, so both calls fetch at the same time.
  const c3 = g.commit('a.txt', 'three\n');
  const c4 = g.commit('a.txt', 'four\n');
  g.git('push', '-q', 'origin', 'main');
  g.git('update-ref', 'refs/remotes/origin/main', g.c2);
  g.c1 = c3;
  g.c2 = c4;
  const a = f.start('acme-probe', g.c1, { PROBE_SLEEP: '1500' });
  const b = f.start('acme-probe', g.c2, { PROBE_SLEEP: '300' });
  const [ra, rb] = await Promise.all([a.done, b.done]);
  assert.equal(ra.status, 0, JSON.stringify(ra.json));
  assert.equal(rb.status, 0, JSON.stringify(rb.json));
  for (const c of [g.c1, g.c2]) {
    const seen = f.seen(c);
    assert.equal(seen.first, c);
    assert.equal(seen.head, c);
    assert.equal(existsSync(seen.cwd), false);
  }
  assert.notEqual(f.seen(g.c1).cwd, f.seen(g.c2).cwd);
  assert.equal(worktrees(g.work).length, 1);
});

test('a stopped deploy-wait stops the command and removes its checkout', { skip: isWindows ? 'process groups and signals are POSIX' : false }, async (t) => {
  const f = setup(t);
  const g = f.git['acme-hold'];
  const run = f.start('acme-hold', g.c2);
  const pidFile = join(f.s.root, 'hold.pid');
  for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((res) => setTimeout(res, 100));
  assert.ok(existsSync(pidFile), 'the command started');
  run.child.kill('SIGTERM');
  const r = await run.done;
  assert.equal(r.status, 1);
  assert.equal(r.json.failure, 'interrupted');
  assert.equal(r.json.status, 'failed');
  assert.equal(existsSync(readFileSync(join(f.s.root, 'hold.cwd'), 'utf8').trim()), false);
  assert.equal(worktrees(g.work).length, 1);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 50 && alive(); i++) await new Promise((res) => setTimeout(res, 100));
  assert.equal(alive(), false, 'the background sleep was stopped');
});

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('programs a command leaves running are stopped before the result, even ones that ignore SIGTERM', { skip: isWindows ? 'process groups are POSIX' : false }, (t) => {
  const f = setup(t);
  let since = Date.now();
  let r = f.wait('acme-bg', f.git['acme-bg'].c2);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.status, 'succeeded');
  assert.equal(alive(Number(readFileSync(join(f.s.root, 'bg.pid'), 'utf8'))), false, 'the program that ignores SIGTERM was killed');
  assert.ok(Date.now() - since < 15000);
  // A program that keeps the output pipes open does not hold the result back.
  since = Date.now();
  r = f.wait('acme-pipe', f.git['acme-pipe'].c2);
  assert.equal(r.status, 0, r.stdout);
  assert.ok(Date.now() - since < 8000, 'the result came without waiting for the program');
  assert.equal(alive(Number(readFileSync(join(f.s.root, 'pipe.pid'), 'utf8'))), false);
  assert.equal(worktrees(f.git['acme-pipe'].work).length, 1);
});

test('a checkout git refuses to remove is a failed call, even once its folder is gone', (t) => {
  const f = setup(t);
  const r = f.wait('acme-lock', f.git['acme-lock'].c2);
  assert.equal(r.status, 1, r.stdout);
  assert.equal(r.json.failure, 'checkout-failed');
  assert.equal(r.json.status, 'failed');
  assert.match(r.json.detail, /git worktree remove failed/);
  assert.match(r.json.detail, /worktree entry is left/);
});

test('a node_modules clone killed on its own is a failed checkout, and the command never runs', { skip: process.platform === 'darwin' ? false : 'cp -c is used on macOS only' }, (t) => {
  const f = setup(t);
  f.s.fake('cp', "process.kill(process.pid, 'SIGKILL');");
  const g = f.git['acme-probe-nm'];
  const r = f.wait('acme-probe-nm', g.c2);
  assert.equal(r.status, 1, r.stdout);
  assert.equal(r.json.failure, 'checkout-failed');
  assert.match(r.json.detail, /the copy got SIGKILL/);
  assert.equal(existsSync(join(f.s.root, `probe-out.${g.c2}`)), false);
  assert.equal(worktrees(g.work).length, 1);
});

test('deploy-wait checks its arguments', (t) => {
  const f = setup(t);
  assert.equal(f.s.run(['deploy-wait', 'acme-shop', 'acme-cmd']).status, 2);
  assert.equal(f.s.run(['deploy-wait', 'acme-shop', 'acme-cmd', 'abc; rm -rf x']).status, 2);
  assert.equal(f.s.run(['deploy-wait', 'acme-shop', 'acme-nope', commit]).status, 2);
  assert.equal(f.s.run(['deploy-wait', 'acme-shop', 'acme-cmd', commit, '--timeout', 'soon']).status, 2);
  const fast = f.s.run(['deploy-wait', 'acme-shop', 'acme-cmd', commit, '--interval', '0.5']);
  assert.equal(fast.status, 2);
  assert.match(fast.json.detail, /--interval must be a number of seconds, at least 1/);
  // A name inherited from Object is not a repo.
  assert.equal(f.s.run(['deploy-wait', 'acme-shop', 'constructor', commit]).status, 2);
  assert.equal(existsSync(join(f.s.root, 'child.pid')), false);
});

test('commits compare ignoring case, and a short id matches its full id', () => {
  assert.equal(sameCommit(commit.toUpperCase(), commit), true);
  assert.equal(sameCommit(commit.slice(0, 7), commit.toUpperCase()), true);
  assert.equal(sameCommit(commit.slice(0, 6), commit), false);
  assert.equal(sameCommit(other, commit), false);
  assert.equal(sameCommit(null, commit), false);
});
