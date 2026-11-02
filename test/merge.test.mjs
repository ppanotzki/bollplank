import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, gitRepo, acmeConfig, fakesSkip } from './helpers.mjs';

// A fake gh that answers pr view from a state file, records every call, and on pr merge marks
// the PR merged when --match-head-commit names its head. state.repos holds a PR per -R slug,
// else state.pr is the one PR.
const fakeGh = `
const fs = require('fs');
const a = process.argv.slice(2);
const file = process.env.FAKE_GH_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(a) + '\\n');
if (state.fail) { process.stderr.write(state.fail + '\\n'); process.exit(1); }
const slug = a[a.indexOf('-R') + 1];
const pr = state.repos ? state.repos[slug] : state.pr;
if (a[0] === 'pr' && a[1] === 'view') {
  const fields = a[a.indexOf('--json') + 1].split(',');
  console.log(JSON.stringify(Object.fromEntries(fields.map((f) => [f, pr[f]]))));
} else if (a[0] === 'pr' && a[1] === 'merge') {
  if (a[a.indexOf('--match-head-commit') + 1] !== pr.headRefOid) { process.stderr.write('head moved\\n'); process.exit(1); }
  pr.state = 'MERGED';
  pr.mergeCommit = { oid: pr.mergeOid || 'f'.repeat(40) };
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
  const state = (pr = {}, more = {}) => writeFileSync(stateFile, JSON.stringify({ pr: { state: 'OPEN', isDraft: false, baseRefName: 'main', headRefOid: head, headRefName: 'acme-1-feature', statusCheckRollup: green, title: 'Add the feature', body: 'Plain body.', ...pr }, ...more }));
  state();
  const runFolder = join(s.root, 'tickets', 'ACME-1');
  // The run record and the ticket folder record that ticket create writes.
  const runRecord = (stages, run = {}, ticket = { project: 'acme-shop', ticket: 'ACME-1', branch: 'acme-1-feature', repos: { 'acme-api': { kind: 'change' } } }) => {
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

test('merge with --run refuses another ticket\'s green PR, with no review stage selected', { skip: fakesSkip }, (t) => {
  const f = setup(t);
  const none = { plan: stage(false, false), code: stage(false, false) };
  f.runRecord(none);
  f.state({ headRefName: 'acme-2-other' });
  let r = f.merge('--run', f.runFolder);
  assert.equal(r.status, 1, r.stdout);
  assert.equal(r.json.failure, 'run-mismatch');
  assert.match(r.json.detail, /PR #7 is from the branch acme-2-other, not the ticket branch acme-1-feature/);
  // A ticket folder record without its branch cannot be matched either.
  f.state();
  f.runRecord(none, {}, { project: 'acme-shop', ticket: 'ACME-1', repos: { 'acme-api': { kind: 'change' } } });
  r = f.merge('--run', f.runFolder);
  assert.equal(r.json.failure, 'run-mismatch');
  assert.match(r.json.detail, /names no ticket branch/);
  // Once a PR is recorded for the repo, only that PR merges for it.
  f.runRecord(none, { repos: { 'acme-api': { pr: 9 } } });
  r = f.merge('--run', f.runFolder);
  assert.equal(r.json.failure, 'run-mismatch');
  assert.match(r.json.detail, /the run record has PR #9 for acme-api, not #7/);
  assert.equal(f.merged(), false);
  // The ticket's own PR merges.
  f.runRecord(none);
  r = f.merge('--run', f.runFolder);
  assert.equal(r.status, 0, r.stdout);
  assert.ok(f.calls().find((a) => a[1] === 'view')[f.calls().find((a) => a[1] === 'view').indexOf('--json') + 1].split(',').includes('headRefName'));
});

test('a code review keeps whitespace: a Python line moved into or out of an if needs a new review, and a clean rebase passes', { skip: fakesSkip }, (t) => {
  const f = setup(t);
  f.api.commit('app.py', 'def total(x):\n    if x:\n        a = 1\n    return x\n');
  f.api.git('push', '-q', 'origin', 'main');
  f.out('fetch', '-q', 'origin');
  const branch = (name, text) => {
    f.out('checkout', '-q', '-B', name, 'origin/main');
    writeFileSync(join(f.contrib, 'app.py'), text);
    f.out('commit', '-q', '-a', '-m', 'Log the total');
    f.out('push', '-q', '-f', 'origin', `HEAD:refs/heads/${name}`);
    return f.out('rev-parse', 'HEAD');
  };
  const inside = branch('acme-1-inside', 'def total(x):\n    if x:\n        a = 1\n        log(x)\n    return x\n');
  const outside = branch('acme-1-outside', 'def total(x):\n    if x:\n        a = 1\n    log(x)\n    return x\n');
  // The two changes differ only in indentation, so a patch id that ignores whitespace takes one for the other.
  const stable = (sha) => execFileSync('git', ['-C', f.api.work, 'patch-id', '--stable'], { input: execFileSync('git', ['-C', f.contrib, 'diff', 'origin/main', sha]), encoding: 'utf8' }).split(' ')[0];
  assert.equal(stable(inside), stable(outside));
  for (const [approved, head] of [[inside, outside], [outside, inside]]) {
    f.out('push', '-q', '-f', 'origin', `${head}:refs/pull/7/head`);
    f.state({ headRefOid: head });
    f.runRecord({ plan: stage(false, false), code: stage(true, true, approved) });
    const r = f.merge('--run', f.runFolder);
    assert.equal(r.status, 1, r.stdout);
    assert.equal(r.json.failure, 'review-stale');
    assert.notEqual(r.json.review.approvedPatchId, r.json.review.headPatchId);
  }
  assert.equal(f.merged(), false);
  // The base moves and the reviewed change is rebased onto it without conflicts: it still merges.
  f.api.commit('other.txt', 'other work\n');
  f.api.git('push', '-q', 'origin', 'main');
  f.out('fetch', '-q', 'origin');
  f.out('checkout', '-q', 'acme-1-inside');
  f.out('rebase', '-q', 'origin/main');
  const rebased = f.out('rev-parse', 'HEAD');
  assert.notEqual(rebased, inside);
  f.out('push', '-q', '-f', 'origin', `${rebased}:refs/pull/7/head`);
  f.state({ headRefOid: rebased });
  f.runRecord({ plan: stage(false, false), code: stage(true, true, inside) });
  const r = f.merge('--run', f.runFolder);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.review.approvedPatchId, r.json.review.headPatchId);
});

test('a git without patch-id --verbatim fails the review check closed', { skip: fakesSkip }, (t) => {
  const f = setup(t);
  f.out('push', '-q', 'origin', 'HEAD:refs/heads/acme-1-feature');
  // A git that refuses --verbatim, as one older than 2.40 does, and passes every other call on.
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  f.s.fake('git', `
const a = process.argv.slice(2);
if (a.includes('patch-id') && a.includes('--verbatim')) { process.stderr.write("error: unknown option \`verbatim'\\n"); process.exit(129); }
const r = require('child_process').spawnSync(${JSON.stringify(real)}, a, { stdio: 'inherit' });
process.exit(r.status ?? 1);
`);
  f.runRecord({ plan: stage(false, false), code: stage(true, true, f.head) });
  const r = f.merge('--run', f.runFolder);
  assert.equal(r.status, 1, r.stdout);
  assert.equal(r.json.failure, 'review-stale');
  assert.match(r.json.detail, /no `git patch-id --verbatim`/);
  assert.equal(f.merged(), false);
});

test('one ticket reviews and ships two repos, each merged on its own reviewed head and checked as shipped', { skip: fakesSkip }, (t) => {
  const s = sandbox();
  t.after(s.clean);
  const source = join(s.root, 'src');
  mkdirSync(source, { recursive: true });
  const repos = {};
  for (const name of ['acme-api', 'acme-web']) {
    const r = gitRepo(source, name, 'main');
    r.commit('README.md', `${name}\n`);
    r.git('push', '-q', '-u', 'origin', 'main');
    repos[name] = { github: `acme/${name}`, checks: ['checks'], baseBranch: 'main', deploy: { kind: 'none' } };
  }
  const tickets = join(s.root, 'tickets');
  s.config(acmeConfig(source, tickets, repos, { shipOrder: ['acme-api', 'acme-web'] }));
  s.fake('gh', fakeGh);
  const stateFile = join(s.root, 'gh-state.json');
  const logFile = join(s.root, 'gh-log.jsonl');
  writeFileSync(logFile, '');
  const env = { FAKE_GH_STATE: stateFile, FAKE_GH_LOG: logFile };
  const bollplank = (...a) => s.run(a, env);
  let r = bollplank('ticket', 'create', 'acme-shop', 'ACME-1', '--slug', 'two', '--change', 'acme-api,acme-web');
  assert.equal(r.status, 0, r.stdout);
  const folder = join(tickets, 'ACME-1');
  // Each repo gets its change on the ticket branch and a PR head on the remote: #7 and #8.
  const heads = {};
  const prs = { 'acme-api': 7, 'acme-web': 8 };
  const state = { repos: {} };
  for (const name of ['acme-api', 'acme-web']) {
    const wt = join(folder, name);
    const g = (...a) => execFileSync('git', ['-C', wt, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    writeFileSync(join(wt, 'feature.txt'), `${name} feature\n`);
    g('add', 'feature.txt');
    g('commit', '-q', '-m', 'Add the feature');
    g('push', '-q', 'origin', 'HEAD:refs/heads/acme-1-two', `HEAD:refs/pull/${prs[name]}/head`);
    heads[name] = g('rev-parse', 'HEAD');
    state.repos[`acme/${name}`] = { state: 'OPEN', isDraft: false, baseRefName: 'main', headRefOid: heads[name], headRefName: 'acme-1-two', statusCheckRollup: [{ name: 'checks', status: 'COMPLETED', conclusion: 'SUCCESS' }], title: 'Add the feature', body: '', mergeOid: (name === 'acme-api' ? 'a' : 'b').repeat(40) };
  }
  writeFileSync(stateFile, JSON.stringify(state));
  assert.equal(bollplank('run', 'init', 'acme-shop', 'ACME-1', '--review', 'code').status, 0);
  // One plain revision cannot name the heads of two repos, and a pair must name a changed repo.
  r = bollplank('run', 'stage', 'acme-shop', 'ACME-1', 'code', '--revision', heads['acme-api'], '--verdict', 'Approve');
  assert.equal(r.status, 2);
  assert.match(r.json.detail, /this ticket changes acme-api, acme-web, so name the reviewed head of each with --revisions/);
  assert.equal(bollplank('run', 'stage', 'acme-shop', 'ACME-1', 'code', '--revisions', 'acme-nope=abc1234', '--verdict', 'Approve').status, 2);
  assert.equal(bollplank('run', 'stage', 'acme-shop', 'ACME-1', 'code', '--revisions', 'acme-api', '--verdict', 'Approve').status, 2);
  assert.equal(bollplank('run', 'stage', 'acme-shop', 'ACME-1', 'code', '--revision', 'x', '--revisions', `acme-api=${heads['acme-api']}`, '--verdict', 'Approve').status, 2);
  // A round that names only acme-api approves only acme-api.
  r = bollplank('run', 'stage', 'acme-shop', 'ACME-1', 'code', '--revisions', `acme-api=${heads['acme-api']}`, '--verdict', 'Approve');
  assert.equal(r.json.complete, true, r.stdout);
  r = bollplank('merge', 'acme-shop', 'acme-web', '8', '--run', folder);
  assert.equal(r.status, 1, r.stdout);
  assert.equal(r.json.failure, 'review-stale');
  assert.match(r.json.detail, /names no reviewed head for acme-web/);
  // The next round names both heads, and each repo merges on its own entry.
  bollplank('run', 'reopen', 'acme-shop', 'ACME-1', 'code', '--reason', 'acme-web was not reviewed');
  r = bollplank('run', 'stage', 'acme-shop', 'ACME-1', 'code', '--revisions', `acme-api=${heads['acme-api']},acme-web=${heads['acme-web']}`, '--verdict', 'Approve');
  assert.equal(r.json.complete, true, r.stdout);
  const rec = () => JSON.parse(readFileSync(join(folder, '.run.json'), 'utf8'));
  assert.deepEqual(rec().stages.code.rounds.at(-1).revisions, { 'acme-api': heads['acme-api'], 'acme-web': heads['acme-web'] });
  r = bollplank('merge', 'acme-shop', 'acme-api', '7', '--run', folder);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.review.approved, heads['acme-api']);
  // Nothing is shipped until every changed repo is merged and its merge commit deployed.
  r = bollplank('run', 'check-shipped', 'acme-shop', 'ACME-1');
  assert.equal(r.status, 1, r.stdout);
  assert.equal(r.json.failure, 'not-shipped');
  assert.match(r.json.detail, /acme-api has no deploy recorded for its merge commit a{12}\. acme-web is not merged\./);
  r = bollplank('merge', 'acme-shop', 'acme-web', '8', '--run', folder);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.review.approved, heads['acme-web']);
  bollplank('run', 'deploy', 'acme-shop', 'ACME-1', 'acme-api', '--kind', 'none', '--status', 'succeeded', '--ref', 'none', '--commit', 'a'.repeat(40));
  // A deploy of another commit, or one still running, does not count.
  bollplank('run', 'deploy', 'acme-shop', 'ACME-1', 'acme-web', '--kind', 'none', '--status', 'succeeded', '--ref', 'old', '--commit', 'c'.repeat(40));
  bollplank('run', 'deploy', 'acme-shop', 'ACME-1', 'acme-web', '--kind', 'none', '--status', 'running', '--ref', 'none', '--commit', 'b'.repeat(40));
  r = bollplank('run', 'check-shipped', 'acme-shop', 'ACME-1');
  assert.equal(r.json.failure, 'not-shipped');
  assert.match(r.json.detail, /^acme-web's last deploy of b{12} is running\.$/);
  assert.equal(r.json.repos['acme-api'].deployed, true);
  bollplank('run', 'deploy', 'acme-shop', 'ACME-1', 'acme-web', '--kind', 'none', '--status', 'succeeded', '--ref', 'none', '--commit', 'b'.repeat(40));
  r = bollplank('run', 'check-shipped', 'acme-shop', 'ACME-1');
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.shipped, true);
  assert.deepEqual(Object.keys(r.json.repos), ['acme-api', 'acme-web']);
  assert.deepEqual([rec().repos['acme-api'].pr, rec().repos['acme-web'].pr], [7, 8]);
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
