import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, gitRepo, acmeConfig, fakesSkip } from './helpers.mjs';

// A fake gh that answers pr view from a state file, records every call, and on pr merge marks
// the PR merged when --match-head-commit names its head.
const fakeGh = `
const fs = require('fs');
const a = process.argv.slice(2);
const file = process.env.FAKE_GH_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(a) + '\\n');
if (state.fail) { process.stderr.write(state.fail + '\\n'); process.exit(1); }
if (a[0] === 'pr' && a[1] === 'view') {
  const fields = a[a.indexOf('--json') + 1].split(',');
  console.log(JSON.stringify(Object.fromEntries(fields.map((f) => [f, state.pr[f]]))));
} else if (a[0] === 'pr' && a[1] === 'merge') {
  if (a[a.indexOf('--match-head-commit') + 1] !== state.pr.headRefOid) { process.stderr.write('head moved\\n'); process.exit(1); }
  state.pr.state = 'MERGED';
  state.pr.mergeCommit = { oid: 'f'.repeat(40) };
  fs.writeFileSync(file, JSON.stringify(state));
} else { process.stderr.write('unexpected gh call\\n'); process.exit(1); }
`;

function setup(t, extra = {}) {
  const s = sandbox();
  t.after(s.clean);
  const source = join(s.root, 'src');
  mkdirSync(source, { recursive: true });
  const api = gitRepo(source, 'acme-api', 'main');
  api.commit('README.md', 'acme api\n');
  api.git('push', '-q', '-u', 'origin', 'main');
  // The PR head comes from another clone and lives only on the remote, as refs/pull/7/head does
  // on GitHub, so the scan can only see it after merge fetches it.
  const contrib = join(s.root, 'contrib');
  const g = (...a) => execFileSync('git', ['-C', contrib, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...a], { stdio: 'ignore' });
  execFileSync('git', ['clone', '-q', api.origin, contrib]);
  writeFileSync(join(contrib, 'feature.txt'), extra.planted ?? 'plain feature\n');
  g('add', 'feature.txt');
  g('commit', '-q', '-m', 'Add the feature');
  g('push', '-q', 'origin', 'HEAD:refs/pull/7/head');
  const head = execFileSync('git', ['-C', contrib, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.throws(() => api.git('cat-file', '-e', `${head}^{commit}`));
  const { planted, ...projectExtra } = extra;
  s.config(acmeConfig(source, join(s.root, 'tickets'), { 'acme-api': { github: 'acme/acme-api', checks: ['checks', 'lint'], baseBranch: 'main' } }, projectExtra));
  s.fake('gh', fakeGh);
  const stateFile = join(s.root, 'gh-state.json');
  const logFile = join(s.root, 'gh-log.jsonl');
  writeFileSync(logFile, '');
  const green = [
    { name: 'checks', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
  ];
  const state = (pr = {}, more = {}) => writeFileSync(stateFile, JSON.stringify({ pr: { state: 'OPEN', isDraft: false, baseRefName: 'main', headRefOid: head, statusCheckRollup: green, ...pr }, ...more }));
  state();
  const runFolder = join(s.root, 'tickets', 'ACME-1');
  const runRecord = (stages) => {
    mkdirSync(runFolder, { recursive: true });
    writeFileSync(join(runFolder, '.run.json'), JSON.stringify({ project: 'acme-shop', ticket: 'ACME-1', stages, repos: {} }));
  };
  const env = { FAKE_GH_STATE: stateFile, FAKE_GH_LOG: logFile };
  const merge = (...a) => s.run(['merge', 'acme-shop', 'acme-api', '7', ...a], env);
  const merged = () => readFileSync(logFile, 'utf8').split('\n').filter(Boolean).some((l) => JSON.parse(l)[1] === 'merge');
  return { s, head, green, state, runFolder, runRecord, merge, merged };
}

const stage = (selected, complete) => ({ selected, complete, rounds: [] });

test('merge refuses missing, unfinished and failed checks, drafts, closed PRs and the wrong base', { skip: fakesSkip }, (t) => {
  const f = setup(t);
  const cases = [
    [{ statusCheckRollup: [f.green[0]] }, 'checks', /lint: missing/],
    [{ statusCheckRollup: [f.green[0], { name: 'lint', status: 'IN_PROGRESS' }] }, 'checks', /lint: not finished/],
    [{ statusCheckRollup: [f.green[0], { context: 'lint', state: 'FAILURE' }] }, 'checks', /lint: failed \(FAILURE\)/],
    [{ isDraft: true }, 'draft', /draft/],
    [{ state: 'CLOSED' }, 'not-open', /CLOSED/],
    [{ baseRefName: 'develop' }, 'wrong-base', /targets develop, not main/],
  ];
  for (const [pr, failure, detail] of cases) {
    f.state(pr);
    const r = f.merge();
    assert.equal(r.status, 1, r.stdout);
    assert.equal(r.json.failure, failure);
    assert.equal(r.json.merged, false);
    assert.match(r.json.detail, detail);
  }
  assert.equal(f.merged(), false);
});

test('merge with --run refuses an incomplete plan or code stage', { skip: fakesSkip }, (t) => {
  const f = setup(t);
  f.runRecord({ plan: stage(true, true), code: stage(true, false) });
  let r = f.merge('--run', f.runFolder);
  assert.equal(r.json.failure, 'stage-incomplete');
  assert.equal(r.json.stage, 'code');
  f.runRecord({ plan: stage(true, false), code: stage(false, false) });
  r = f.merge('--run', f.runFolder);
  assert.equal(r.json.failure, 'stage-incomplete');
  assert.equal(r.json.stage, 'plan');
  assert.equal(f.merge('--run', join(f.runFolder, 'missing')).json.failure, 'no-run');
  assert.equal(f.merged(), false);
});

test('a gh failure comes back as JSON', { skip: fakesSkip }, (t) => {
  const f = setup(t);
  f.state({}, { fail: 'HTTP 401: Bad credentials' });
  const r = f.merge();
  assert.equal(r.status, 1);
  assert.equal(r.json.failure, 'gh-failed');
  assert.match(r.json.detail, /Bad credentials/);
});

test('an ordinary project merges on green checks and complete stages with no names list, and records the merge', { skip: fakesSkip }, (t) => {
  const f = setup(t);
  assert.equal(existsSync(join(f.s.bollplank, 'private-names.txt')), false);
  f.runRecord({ plan: stage(true, true), code: stage(true, true) });
  const r = f.merge('--run', f.runFolder);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.merged, true);
  assert.equal(r.json.finalHead, f.head);
  assert.equal(r.json.mergeCommit, 'f'.repeat(40));
  assert.equal(r.json.privateScan, undefined);
  const rec = JSON.parse(readFileSync(join(f.runFolder, '.run.json'), 'utf8'));
  assert.equal(rec.repos['acme-api'].merged, true);
  assert.equal(rec.repos['acme-api'].pr, 7);
  assert.equal(rec.repos['acme-api'].finalHead, f.head);
  assert.equal(rec.repos['acme-api'].mergeCommit, 'f'.repeat(40));
});

test('a privateScan project refuses when the scan is skipped', { skip: fakesSkip }, (t) => {
  const f = setup(t, { privateScan: true });
  const r = f.merge();
  assert.equal(r.status, 1, r.stdout);
  assert.equal(r.json.failure, 'private-scan');
  assert.equal(r.json.privateScan.outcome, 'skipped');
  assert.equal(f.merged(), false);
});

test('a privateScan project refuses a PR head with a listed name and never prints it', { skip: fakesSkip }, (t) => {
  const f = setup(t, { privateScan: true, planted: 'a note about Zorblax Industries\n' });
  writeFileSync(join(f.s.bollplank, 'private-names.txt'), '# synthetic list\nzorblax\n');
  const r = f.merge();
  assert.equal(r.status, 1, r.stdout);
  assert.equal(r.json.failure, 'private-scan');
  assert.equal(r.json.privateScan.outcome, 'failed');
  assert.deepEqual(r.json.privateScan.hits.map((h) => [h.pattern, h.file]), [[1, 'feature.txt']]);
  assert.ok(!r.stdout.toLowerCase().includes('zorblax'));
  assert.equal(f.merged(), false);
});

test('a privateScan project merges when the scan of the PR head passes', { skip: fakesSkip }, (t) => {
  const f = setup(t, { privateScan: true });
  writeFileSync(join(f.s.bollplank, 'private-names.txt'), 'zorblax\n');
  const r = f.merge();
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.privateScan.outcome, 'passed');
  assert.equal(f.merged(), true);
});

test('merge checks its arguments', (t) => {
  const s = sandbox();
  t.after(s.clean);
  s.config(acmeConfig(join(s.root, 'src'), join(s.root, 'tickets')));
  assert.equal(s.run(['merge', 'acme-shop', 'acme-api']).status, 2);
  assert.equal(s.run(['merge', 'acme-shop', 'acme-api', 'seven']).status, 2);
  assert.equal(s.run(['merge', 'acme-shop', 'acme-nope', '7']).status, 2);
  assert.equal(s.run(['merge', 'acme-shop', 'acme-api', '7', '--run']).status, 2);
});
