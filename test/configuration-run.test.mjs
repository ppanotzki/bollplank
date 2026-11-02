import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configurationRun } from '../lib/configuration-run.mjs';
import { sandbox } from './helpers.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bollplank-config-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profile = { mode: 'configuration', runs: true, allowedTickets: ['ACME-1'], tickets: join(root, 'runs'), board: { teamId: 'synthetic-team', projectId: 'synthetic-project' }, targets: { internal: { id: 'synthetic' } }, verificationChecks: ['hierarchy', 'history'] };
  const put = (name, text) => {
    const p = join(root, name);
    writeFileSync(p, text);
    return p;
  };
  const brief = put('brief.md', 'Brief v1\nApproval: Approved by Ada on 2026-10-27 (https://example.invalid/approval)\nCross-model review: plan. Test\n');
  const live = join(root, 'live.json');
  const refresh = () => put('live.json', JSON.stringify({ id: 'ACME-1', teamId: profile.board.teamId, projectId: profile.board.projectId, observedAt: new Date().toISOString(), description: readFileSync(brief, 'utf8') }));
  refresh();
  const plan = put('plan.md', 'Synthetic configuration plan');
  const proof = put('proof.json', '{"synthetic":true}');
  const run = (cmd, opts = {}, positional = []) => configurationRun({ project: 'acme-ops', ticket: 'ACME-1', profile, cmd, opts, positional, approver: 'Ada' });
  const init = () => run('init', { brief, approval: 'https://example.invalid/approval', instruction: 'synthetic run instruction', review: 'plan', 'board-readback': live });
  const reviewed = () => {
    init();
    const p = run('plan', { path: plan });
    run('stage', { revision: p.record.plan.sha256, verdict: 'Approve', evidence: proof }, ['plan']);
  };
  const ready = () => {
    reviewed();
    run('change', { id: 'op1', target: 'internal', status: 'intent', evidence: proof });
    run('change', { id: 'op1', target: 'internal', status: 'verified', evidence: proof });
    for (const check of profile.verificationChecks) run('verify', { check, status: 'pass', evidence: proof });
  };
  return { root, profile, put, brief, live, refresh, plan, proof, run, init, reviewed, ready };
}

test('check is read only and disabled or unrelated tickets are refused', (t) => {
  const f = fixture(t);
  assert.equal(f.run('check').exists, false);
  assert.equal(existsSync(f.profile.tickets), false);
  f.profile.allowedTickets = [];
  assert.throws(() => f.run('check'), /not enabled/);
  f.profile.allowedTickets = ['ACME-1'];
  f.profile.runs = false;
  assert.throws(() => f.run('init'), /disabled/);
  delete f.profile.runs;
  assert.throws(() => f.run('init'), (e) => e.failure === 'runs-disabled');
  assert.equal(existsSync(f.profile.tickets), false);
});

test('init needs approval by the configured approver and an explicit instruction, and resume never resets the record', (t) => {
  const f = fixture(t);
  assert.throws(() => f.run('init', { brief: f.brief }), /instruction/);
  assert.throws(() => f.run('init', { brief: f.brief, approval: 'x' }), /instruction/);
  writeFileSync(f.brief, 'Approval: Pending\nCross-model review: plan\n');
  assert.throws(() => f.init(), /not approved/);
  writeFileSync(f.brief, 'Brief v1\nApproval: Approved by Grace on today (https://example.invalid/approval)\nCross-model review: plan\n');
  f.refresh();
  assert.throws(() => f.init(), /not approved/);
  writeFileSync(f.brief, 'Brief v1\nApproval: Approved by Ada on today (https://example.invalid/approval)\nCross-model review: plan\n');
  f.refresh();
  const r = f.init().record;
  assert.equal(r.critic, null);
  f.run('log', { event: 'stopped for synthetic input' });
  const resumed = f.init();
  assert.equal(resumed.resume, true);
  assert.equal(resumed.record.started, r.started);
  assert.equal(resumed.record.log.length, 1);
});

test('an approved brief with a Critic line initializes, and a differing review is still refused', (t) => {
  const f = fixture(t);
  writeFileSync(f.brief, 'Brief v1\nApproval: Approved by Ada on today (https://example.invalid/approval)\nCross-model review: plan. Synthetic\nCritic: same\n');
  f.refresh();
  const args = { brief: f.brief, approval: 'synthetic', instruction: 'synthetic run', 'board-readback': f.live };
  assert.throws(() => f.run('init', { ...args, review: 'none' }), /review differs/);
  assert.equal(existsSync(join(f.profile.tickets, 'ACME-1', '.run.json')), false);
  const r = f.run('init', { ...args, review: 'plan' }).record;
  assert.equal(r.critic, 'same');
  assert.equal(r.baselines[0].critic, 'same');
  assert.equal(r.stages.plan.selected, true);
});

test('a Critic line naming an unknown critic is refused', (t) => {
  const f = fixture(t);
  writeFileSync(f.brief, 'Brief v1\nApproval: Approved by Ada on today\nCross-model review: plan\nCritic: cousin\n');
  f.refresh();
  assert.throws(() => f.init(), /Critic line/);
});

test('the old --linear-readback flag name still works', (t) => {
  const f = fixture(t);
  const r = f.run('init', { brief: f.brief, approval: 'synthetic', instruction: 'synthetic run', review: 'plan', 'linear-readback': f.live });
  assert.equal(r.record.baseline, 1);
  assert.ok(r.record.baselines[0].liveEvidence.path.endsWith('board-readback.json'));
});

test('selected review blocks writes and plan mutation invalidates the gate', (t) => {
  const f = fixture(t);
  f.init();
  assert.throws(() => f.run('change', { id: 'one', target: 'internal', status: 'intent', evidence: f.proof }), /plan/);
  const p = f.run('plan', { path: f.plan });
  assert.throws(() => f.run('gate', {}, ['plan']), /review/);
  assert.throws(() => f.run('stage', { revision: 'wrong', verdict: 'Approve', evidence: f.proof }, ['plan']), /current plan/);
  f.run('stage', { revision: p.record.plan.sha256, verdict: 'Approve', evidence: f.proof }, ['plan']);
  assert.equal(f.run('gate', {}, ['plan']).complete, true);
  writeFileSync(f.plan, 'Changed unreviewed plan');
  assert.throws(() => f.run('gate', {}, ['plan']), /changed/);
  f.run('plan', { path: f.plan });
  assert.throws(() => f.run('gate', {}, ['plan']), /review/);
});

test('unconfigured target aliases and duplicate operation writes are rejected', (t) => {
  const f = fixture(t);
  f.reviewed();
  assert.throws(() => f.run('change', { id: 'one', target: 'Elsewhere', status: 'intent', evidence: f.proof }), /outside/);
  assert.throws(() => f.run('change', { id: 'one', target: 'internal', status: 'verified', evidence: f.proof }), /intent/);
  f.run('change', { id: 'one', target: 'internal', status: 'intent', evidence: f.proof });
  assert.throws(() => f.run('change', { id: 'one', target: 'internal', status: 'intent', evidence: f.proof }), /already recorded/);
  f.run('change', { id: 'one', target: 'internal', status: 'verified', evidence: f.proof });
  assert.throws(() => f.run('change', { id: 'one', target: 'internal', status: 'verified', evidence: f.proof }), /already verified/);
});

test('completion requires every check and evidence and stops at Acceptance', (t) => {
  const f = fixture(t);
  f.reviewed();
  assert.throws(() => f.run('complete'), /changes/);
  f.run('change', { id: 'one', target: 'internal', status: 'intent', evidence: f.proof });
  assert.throws(() => f.run('complete'), /changes/);
  f.run('change', { id: 'one', target: 'internal', status: 'verified', evidence: f.proof });
  assert.throws(() => f.run('complete'), /verification/);
  for (const check of f.profile.verificationChecks) f.run('verify', { check, status: 'pass', evidence: f.proof });
  assert.equal(f.run('complete').record.status, 'Acceptance');
  f.run('change', { id: 'two', target: 'internal', status: 'intent', evidence: f.proof });
  assert.equal(f.run('show').record.status, 'In Progress');
  assert.throws(() => f.run('complete'), /changes/);
});

test('changed brief, profile or review evidence blocks further changes', (t) => {
  const f = fixture(t);
  f.ready();
  writeFileSync(f.proof, 'changed evidence');
  assert.throws(() => f.run('complete'), /evidence/);
  assert.throws(() => f.run('change', { id: 'new', target: 'internal', status: 'intent', evidence: f.proof }), /evidence/);
  f.profile.targets.other = {};
  assert.throws(() => f.run('gate', {}, ['plan']), /profile changed/);
  delete f.profile.targets.other;
  const r = f.run('show').record;
  writeFileSync(r.brief.path, 'changed baseline');
  assert.throws(() => f.run('complete'), /brief evidence/);
});

test('initial baseline matches fresh board content while approval references have no format gate', (t) => {
  const f = fixture(t);
  const opts = { brief: f.brief, approval: 'https://example.invalid/approval', instruction: 'synthetic run', review: 'plan', 'board-readback': f.live };
  const original = JSON.parse(readFileSync(f.live));
  const alter = (fields) => writeFileSync(f.live, JSON.stringify({ ...original, ...fields }));
  alter({ observedAt: '2000-01-01T00:00:00Z' });
  assert.throws(() => f.run('init', opts), /Linear readback must be freshly/);
  alter({ id: 'ACME-9' });
  assert.throws(() => f.run('init', opts), /identity/);
  alter({ teamId: 'wrong-team' });
  assert.throws(() => f.run('init', opts), /identity/);
  alter({ description: original.description.replace('Brief v1', 'Brief v2') });
  assert.throws(() => f.run('init', opts), /differs from current/);
  alter({});
  assert.equal(existsSync(f.profile.tickets), false);
  const r = f.run('init', { ...opts, approval: 'verified board comment synthetic-approval' }).record;
  assert.equal(r.approval, 'verified board comment synthetic-approval');
  assert.equal(r.baselines[0].version, 'Brief v1');
  assert.equal(r.baselines[0].number, 1);
  assert.notEqual(r.baselines[0].liveEvidence.path, f.live);
});

test('superseded operations retain failed attempts and require resolution evidence', (t) => {
  const f = fixture(t);
  f.reviewed();
  const args = { id: 'abandoned', target: 'internal', evidence: f.proof };
  f.run('change', { ...args, status: 'intent' });
  f.run('change', { ...args, status: 'failed' });
  assert.throws(() => f.run('change', { ...args, status: 'superseded' }), /reason/);
  assert.throws(() => f.run('change', { ...args, status: 'superseded', reason: 'different approach', residual: 'corrected', replacement: 'correction' }), /already be verified/);
  f.run('change', { id: 'correction', target: 'internal', status: 'intent', evidence: f.proof });
  assert.throws(() => f.run('change', { ...args, status: 'superseded', reason: 'different approach', residual: 'corrected', replacement: 'correction' }), /already be verified/);
  f.run('change', { id: 'correction', target: 'internal', status: 'verified', evidence: f.proof });
  const r = f.run('change', { ...args, status: 'superseded', reason: 'corrected with readback', residual: 'corrected', replacement: 'correction' }).record;
  assert.deepEqual(r.changes[0].events.map((e) => e.status), ['intent', 'failed', 'superseded']);
  assert.throws(() => f.run('change', { ...args, status: 'verified' }), /superseded/);
  for (const check of f.profile.verificationChecks) f.run('verify', { check, status: 'pass', evidence: f.proof });
  assert.equal(f.run('complete').record.status, 'Acceptance');
});

test('unexecuted intent can be safely superseded with no residual effects', (t) => {
  const f = fixture(t);
  f.ready();
  f.run('change', { id: 'unexecuted', target: 'internal', status: 'intent', evidence: f.proof });
  f.run('change', { id: 'unexecuted', target: 'internal', status: 'superseded', evidence: f.proof, reason: 'readback confirms no effect', residual: 'none' });
  for (const check of f.profile.verificationChecks) f.run('verify', { check, status: 'pass', evidence: f.proof });
  assert.equal(f.run('complete').record.status, 'Acceptance');
});

test('approved amendment preserves prior baseline and operations and resets review and verification', (t) => {
  const f = fixture(t);
  f.ready();
  const before = f.run('show').record;
  const brief2 = f.put('brief2.md', readFileSync(f.brief, 'utf8').replace('Brief v1', 'Brief v2') + 'Amended scope\n');
  const live2 = f.put('live2.json', JSON.stringify({ ...JSON.parse(readFileSync(f.live)), description: readFileSync(brief2, 'utf8'), observedAt: new Date().toISOString() }));
  const args = { brief: brief2, approval: 'https://example.invalid/approval', review: 'plan', 'board-readback': live2, reason: 'approved amendment', authorization: 'synthetic human decision', 'scope-evidence': f.proof };
  writeFileSync(brief2, readFileSync(brief2, 'utf8').replace('Approval: Approved by Ada on 2026-10-27 (https://example.invalid/approval)', 'Approval: Pending'));
  assert.throws(() => f.run('rebaseline', args), /not approved/);
  assert.equal(f.run('show').record.baseline, 1);
  writeFileSync(brief2, JSON.parse(readFileSync(live2)).description);
  const r = f.run('rebaseline', args).record;
  assert.equal(r.baselines.length, 2);
  assert.equal(r.baselines[0].version, 'Brief v1');
  assert.equal(r.baselines[1].version, 'Brief v2');
  assert.deepEqual(r.changes, before.changes);
  assert.deepEqual(r.amendments[0].previousVerification, before.verification);
  assert.equal(r.plan, null);
  assert.equal(r.stages.plan.complete, false);
  assert.deepEqual(r.verification, {});
  assert.throws(() => f.run('complete'), /plan/);
  const p = f.run('plan', { path: f.plan });
  f.run('stage', { revision: p.record.plan.sha256, verdict: 'Approve', evidence: f.proof }, ['plan']);
  for (const check of f.profile.verificationChecks) f.run('verify', { check, status: 'pass', evidence: f.proof });
  assert.equal(f.run('complete').record.status, 'Acceptance');
});

test('profile correction can be reconciled with retained scope evidence without deleting journal', (t) => {
  const f = fixture(t);
  f.reviewed();
  f.profile.targets.internal.id = 'corrected-synthetic-id';
  assert.throws(() => f.run('plan', { path: f.plan }), /profile changed/);
  f.run('log', { event: 'stopped pending profile reconciliation' });
  const r = f.run('rebaseline', { brief: f.brief, approval: 'https://example.invalid/approval', review: 'plan', 'board-readback': f.live, reason: 'correct intended identity', authorization: 'original synthetic scope instruction', 'scope-evidence': f.proof }).record;
  assert.equal(r.baselines[0].profile.targets.internal.id, 'synthetic');
  assert.equal(r.baselines[1].profile.targets.internal.id, 'corrected-synthetic-id');
  assert.ok(r.log.some((e) => e.event === 'stopped pending profile reconciliation'));
  assert.equal(r.plan, null);
});

// Exercise the documented local recovery procedure. The helper does not move files itself.
function moveOrphanAside(f, name) {
  const folder = join(f.profile.tickets, 'ACME-1');
  const recordPath = join(folder, '.run.json');
  const committed = existsSync(recordPath) ? readFileSync(recordPath, 'utf8') : null;
  const orphan = join(folder, name);
  if (committed && JSON.parse(committed).baselines.some((b) => b.brief.path.startsWith(orphan + '/') || b.liveEvidence.path.startsWith(orphan + '/'))) throw new Error('referenced baseline cannot be moved');
  const archive = join(folder, 'recovery', name);
  mkdirSync(archive, { recursive: true });
  renameSync(orphan, join(archive, 'snapshot'));
  const pending = recordPath + '.tmp';
  if (existsSync(pending)) renameSync(pending, join(archive, 'pending-run.json'));
  writeFileSync(join(archive, 'recovery.json'), JSON.stringify({ reason: 'synthetic interrupted save', source: orphan, at: new Date().toISOString() }));
  if (committed) assert.equal(readFileSync(recordPath, 'utf8'), committed);
  return archive;
}

test('documented recovery preserves orphan initialization evidence and permits a fresh retry', (t) => {
  const f = fixture(t);
  const orphan = join(f.profile.tickets, 'ACME-1', 'baseline-1');
  mkdirSync(orphan, { recursive: true });
  writeFileSync(join(orphan, 'approved-brief.md'), 'partially saved synthetic artifact');
  writeFileSync(join(f.profile.tickets, 'ACME-1', '.run.json.tmp'), '{"synthetic":"pending init"}');
  assert.throws(() => f.init(), /Interrupted local save/);
  assert.equal(existsSync(join(f.profile.tickets, 'ACME-1', '.run.json')), false);
  const archive = moveOrphanAside(f, 'baseline-1');
  assert.equal(readFileSync(join(archive, 'snapshot/approved-brief.md'), 'utf8'), 'partially saved synthetic artifact');
  assert.equal(JSON.parse(readFileSync(join(archive, 'pending-run.json'))).synthetic, 'pending init');
  f.refresh();
  const r = f.init().record;
  assert.equal(r.baseline, 1);
  assert.deepEqual(r.changes, []);
  f.run('log', { event: 'recovery retained at ' + archive });
  assert.equal(f.run('show').record.log.length, 1);
});

test('documented amendment recovery preserves committed history and never replays operations', (t) => {
  const f = fixture(t);
  f.ready();
  const before = f.run('show').record;
  const folder = join(f.profile.tickets, 'ACME-1');
  const orphan = join(folder, 'baseline-2');
  mkdirSync(orphan);
  writeFileSync(join(orphan, 'approved-brief.md'), 'partial amendment');
  writeFileSync(join(folder, '.run.json.tmp'), '{"synthetic":"pending amendment"}');
  f.profile.targets.internal.id = 'corrected-synthetic-id';
  const args = { brief: f.brief, approval: 'synthetic verified comment', review: 'plan', 'board-readback': f.live, reason: 'correct intended target', authorization: 'original synthetic scope', 'scope-evidence': f.proof };
  assert.throws(() => f.run('rebaseline', args), /Interrupted local save/);
  assert.throws(() => moveOrphanAside(f, 'baseline-1'), /referenced baseline/);
  const archive = moveOrphanAside(f, 'baseline-2');
  assert.equal(JSON.parse(readFileSync(join(archive, 'pending-run.json'))).synthetic, 'pending amendment');
  f.refresh();
  const r = f.run('rebaseline', args).record;
  assert.deepEqual(r.changes, before.changes);
  assert.equal(r.baselines[0].brief.sha256, before.baselines[0].brief.sha256);
  assert.equal(r.baseline, 2);
  assert.equal(r.plan, null);
  assert.deepEqual(r.verification, {});
});

test('the CLI routes configuration mode while repository init and deploy still work', (t) => {
  const s = sandbox();
  t.after(s.clean);
  const tickets = join(s.root, 'tickets');
  s.config({
    approver: { name: 'Ada' },
    board: { kind: 'linear' },
    projects: {
      'acme-ops': { mode: 'configuration', runs: true, source: join(s.root, 'ops'), tickets: join(s.root, 'ops-runs'), board: { teamId: 'synthetic-team', projectId: 'synthetic-project' }, allowedTickets: ['ACME-1'], targets: { internal: { id: 'synthetic' } }, runbook: 'docs/runbook.md', verificationChecks: ['hierarchy'] },
      'acme-shop': { source: join(s.root, 'src'), tickets, runs: true, repos: { 'acme-api': { github: 'acme/acme-api', checks: ['checks'] } } },
    },
  });
  let r = s.run(['run', 'check', 'acme-ops', 'ACME-1']);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.mode, 'configuration');
  r = s.run(['run', 'check', 'acme-ops', 'ACME-2']);
  assert.equal(r.status, 1);
  assert.equal(r.json.failure, 'ticket-not-enabled');
  r = s.run(['run', 'init', 'acme-ops', 'ACME-1', '--review', 'plan']);
  assert.equal(r.json.failure, 'usage');
  const folder = join(tickets, 'ACME-2');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, '.ticket.json'), '{}');
  r = s.run(['run', 'init', 'acme-shop', 'ACME-2', '--review', 'none']);
  assert.equal(r.status, 0, r.stdout);
  r = s.run(['run', 'deploy', 'acme-shop', 'ACME-2', 'acme-api', '--kind', 'merge', '--commit', 'abc1234', '--status', 'succeeded']);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.deploy.status, 'succeeded');
  assert.equal(JSON.parse(readFileSync(join(folder, '.run.json'))).deploys.length, 1);
});

test('a configuration run record that is not valid JSON is a corrupt failure through the CLI, never a crash', (t) => {
  const s = sandbox();
  t.after(s.clean);
  const runs = join(s.root, 'ops-runs');
  s.config({
    approver: { name: 'Ada' },
    board: { kind: 'linear' },
    projects: { 'acme-ops': { mode: 'configuration', runs: true, source: join(s.root, 'ops'), tickets: runs, board: { teamId: 'synthetic-team', projectId: 'synthetic-project' }, allowedTickets: ['ACME-1'], targets: { internal: { id: 'synthetic' } }, runbook: 'docs/runbook.md', verificationChecks: ['hierarchy'] } },
  });
  mkdirSync(join(runs, 'ACME-1'), { recursive: true });
  writeFileSync(join(runs, 'ACME-1', '.run.json'), '{"plan":');
  const r = s.run(['run', 'show', 'acme-ops', 'ACME-1']);
  assert.equal(r.status, 1, r.stdout);
  assert.equal(r.json.failure, 'corrupt');
  assert.match(r.json.detail, /ACME-1 run in .*ops-runs\/ACME-1 could not be read/);
});
