import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, acmeConfig, fakesSkip, isWindows } from './helpers.mjs';
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

function setup(t) {
  const s = sandbox();
  t.after(s.clean);
  const script = join(s.root, 'deploy-check.js');
  writeFileSync(script, `process.exit(process.argv[2] === ${JSON.stringify(commit)} ? 0 : 3);\n`);
  const repos = {
    'acme-none': { github: 'acme/acme-none', checks: ['checks'] },
    'acme-cmd': { github: 'acme/acme-cmd', checks: ['checks'], deploy: { kind: 'command', command: `node ${JSON.stringify(script)} {commit}` } },
    'acme-amp': { github: 'acme/acme-amp', checks: ['checks'], baseBranch: 'main', deploy: { kind: 'amplify', appId: 'd1acme', region: 'eu-west-1', profile: 'acme-deploy' } },
    'acme-gha': { github: 'acme/acme-gha', checks: ['checks'], deploy: { kind: 'github-actions', workflow: 'deploy' } },
    // A shell that starts a program in the background and waits for it, so a timeout must stop
    // the whole process group to stop the program.
    'acme-slow': { github: 'acme/acme-slow', checks: ['checks'], deploy: { kind: 'command', command: `sleep 30 & echo $! > ${JSON.stringify(join(s.root, 'child.pid'))}; wait` } },
  };
  s.config(acmeConfig(join(s.root, 'src'), join(s.root, 'tickets'), repos));
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
  const wait = (repo, c = commit, ...a) => s.run(['deploy-wait', 'acme-shop', repo, c, '--interval', '1', ...a], { FAKE_SEQ: seqFile, FAKE_LOG: logFile });
  return { s, seq, log, wait };
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
  let r = f.wait('acme-cmd');
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.exitCode, 0);
  assert.ok(r.json.command.endsWith(commit));
  assert.equal(r.json.status, 'succeeded');
  assert.equal(r.json.ref, r.json.command);
  r = f.wait('acme-cmd', other);
  assert.equal(r.status, 1);
  assert.equal(r.json.failure, 'deploy-failed');
  assert.equal(r.json.status, 'failed');
  assert.equal(r.json.exitCode, 3);
});

test('a command that runs past the timeout is stopped with every program it started', { skip: isWindows ? 'process groups are POSIX' : false }, async (t) => {
  const f = setup(t);
  const r = f.wait('acme-slow', commit, '--timeout', '1');
  assert.equal(r.status, 1, r.stdout);
  assert.equal(r.json.status, 'timeout');
  assert.equal(r.json.failure, 'timeout');
  assert.match(r.json.ref, /^sleep 30 &/);
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
