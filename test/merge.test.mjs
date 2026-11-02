import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  const out = (...a) => execFileSync('git', ['-C', contrib, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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
  const state = (pr = {}, more = {}) => writeFileSync(stateFile, JSON.stringify({ pr: { state: 'OPEN', isDraft: false, baseRefName: 'main', headRefOid: head, statusCheckRollup: green, title: 'Add the feature', body: 'Plain body.', ...pr }, ...more }));
  state();
  const runFolder = join(s.root, 'tickets', 'ACME-1');
  // The run record and the ticket folder record that ticket create writes.
  const runRecord = (stages, run = {}, ticket = { project: 'acme-shop', ticket: 'ACME-1', repos: { 'acme-api': { kind: 'change' } } }) => {
    mkdirSync(runFolder, { recursive: true });
    writeFileSync(join(runFolder, '.run.json'), JSON.stringify({ project: 'acme-shop', ticket: 'ACME-1', stages, repos: {}, ...run }));
    if (ticket) writeFileSync(join(runFolder, '.ticket.json'), JSON.stringify(ticket));
  };
  const env = { FAKE_GH_STATE: stateFile, FAKE_GH_LOG: logFile };
  const merge = (...a) => s.run(['merge', 'acme-shop', 'acme-api', '7', ...a], env);
  const calls = () => readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const merged = () => calls().some((a) => a[1] === 'merge');
  return { s, api, contrib, out, head, green, state, runFolder, runRecord, merge, merged, calls };
}

// A stage, with one round that reviewed revision when it is complete.
const stage = (selected, complete, revision) => ({ selected, complete, rounds: revision ? [{ revision, verdict: 'Approve' }] : [] });

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

test('merge with --run refuses a record or ticket folder for another project, ticket or repo, and a corrupt record', { skip: fakesSkip }, (t) => {
  const f = setup(t);
  const done = { plan: stage(false, false), code: stage(false, false) };
  const cases = [
    [{ project: 'acme-other' }, undefined, /run record .* is for project acme-other, not acme-shop/],
    [{}, null, /no ticket folder record/],
    [{}, { project: 'acme-other', ticket: 'ACME-1', repos: { 'acme-api': { kind: 'change' } } }, /\.ticket\.json is for project acme-other/],
    [{ ticket: 'ACME-2' }, undefined, /run record is for ACME-2 and the ticket folder for ACME-1/],
    [{}, { project: 'acme-shop', ticket: 'ACME-1', repos: { 'acme-web': { kind: 'change' }, 'acme-api': { kind: 'validate' } } }, /acme-api is not a repo this ticket changes\. The ticket folder changes acme-web\./],
  ];
  for (const [run, ticket, detail] of cases) {
    f.runRecord(done, run, ticket);
    if (ticket === null) rmSync(join(f.runFolder, '.ticket.json'), { force: true });
    const r = f.merge('--run', f.runFolder);
    assert.equal(r.status, 1, r.stdout);
    assert.equal(r.json.failure, 'run-mismatch');
    assert.match(r.json.detail, detail);
  }
  writeFileSync(join(f.runFolder, '.run.json'), '{"project": "acme-shop",');
  const r = f.merge('--run', f.runFolder);
  assert.equal(r.json.failure, 'corrupt');
  assert.equal(r.json.file, join(f.runFolder, '.run.json'));
  assert.doesNotMatch(r.stdout, /at .*\.mjs:\d+/);
  assert.equal(f.merged(), false);
});

test('merge with a code review merges a clean rebase of the approved change and refuses a changed one', { skip: fakesSkip }, (t) => {
  const f = setup(t);
  // The reviewed revision is on the ticket branch. Then the base moves and the PR is rebased.
  f.out('push', '-q', 'origin', 'HEAD:refs/heads/acme-1-feature');
  const approved = f.head;
  f.api.commit('other.txt', 'other work\n');
  f.api.git('push', '-q', 'origin', 'main');
  f.out('fetch', '-q', 'origin');
  f.out('rebase', '-q', 'origin/main');
  f.out('push', '-q', '-f', 'origin', 'HEAD:refs/pull/7/head');
  const rebased = f.out('rev-parse', 'HEAD');
  assert.notEqual(rebased, approved);

  // A change made after the review gives another patch id.
  writeFileSync(join(f.contrib, 'feature.txt'), 'plain feature, changed after review\n');
  f.out('commit', '-q', '-a', '--amend', '--no-edit');
  f.out('push', '-q', '-f', 'origin', 'HEAD:refs/pull/7/head');
  const changed = f.out('rev-parse', 'HEAD');
  f.state({ headRefOid: changed });
  f.runRecord({ plan: stage(false, false), code: stage(true, true, approved) });
  let r = f.merge('--run', f.runFolder);
  assert.equal(r.status, 1, r.stdout);
  assert.equal(r.json.failure, 'review-stale');
  assert.match(r.json.detail, /is not the change the last approved code round reviewed/);
  assert.match(r.json.detail, /bollplank run reopen acme-shop ACME-1 code/);
  assert.notEqual(r.json.review.approvedPatchId, r.json.review.headPatchId);
  assert.equal(f.merged(), false);

  // An approved revision git does not know is refused the same way.
  f.runRecord({ plan: stage(false, false), code: stage(true, true, 'v3') });
  r = f.merge('--run', f.runFolder);
  assert.equal(r.json.failure, 'review-stale');
  assert.match(r.json.detail, /names v3, which is not a commit/);

  // The clean rebase carries the reviewed change, so it merges.
  f.out('push', '-q', '-f', 'origin', `${rebased}:refs/pull/7/head`);
  f.state({ headRefOid: rebased });
  f.runRecord({ plan: stage(false, false), code: stage(true, true, approved) });
  r = f.merge('--run', f.runFolder);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.finalHead, rebased);
  assert.equal(r.json.review.approved, approved);
  assert.equal(r.json.review.approvedPatchId, r.json.review.headPatchId);
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
  // The approved revision is the PR head, reached through the ticket branch as a worktree would.
  f.out('push', '-q', 'origin', 'HEAD:refs/heads/acme-1-feature');
  f.runRecord({ plan: stage(true, true, 'v1'), code: stage(true, true, f.head) });
  const r = f.merge('--run', f.runFolder);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.merged, true);
  assert.equal(r.json.review.approvedPatchId, r.json.review.headPatchId);
  // No scan, so GitHub writes its own squash message.
  assert.equal(f.calls().find((a) => a[1] === 'merge').includes('--subject'), false);
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

test('a privateScan project merges when the scan of the PR head passes, with the scanned title and body as the message', { skip: fakesSkip }, (t) => {
  const f = setup(t, { privateScan: true });
  writeFileSync(join(f.s.bollplank, 'private-names.txt'), 'zorblax\n');
  const r = f.merge();
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.privateScan.outcome, 'passed');
  assert.equal(r.json.messageScan.outcome, 'passed');
  assert.equal(f.merged(), true);
  const call = f.calls().find((a) => a[1] === 'merge');
  assert.equal(call[call.indexOf('--subject') + 1], 'Add the feature (#7)');
  assert.equal(call[call.indexOf('--body') + 1], 'Plain body.');
  assert.ok(call.includes('--squash'));
});

test('a privateScan project refuses a PR title or body with a listed name and never prints it', { skip: fakesSkip }, (t) => {
  const f = setup(t, { privateScan: true });
  writeFileSync(join(f.s.bollplank, 'private-names.txt'), 'zorblax\n');
  for (const pr of [{ title: 'Add the Zorblax feature' }, { body: 'Asked for by\nZorblax Industries.' }]) {
    f.state(pr);
    const r = f.merge();
    assert.equal(r.status, 1, r.stdout);
    assert.equal(r.json.failure, 'private-scan');
    assert.equal(r.json.messageScan.outcome, 'failed');
    assert.deepEqual(r.json.messageScan.hits.map((h) => h.where), [Object.keys(pr)[0]]);
    assert.ok(!r.stdout.toLowerCase().includes('zorblax'));
  }
  assert.equal(f.merged(), false);
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
