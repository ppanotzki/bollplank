import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configurationRun } from '../lib/configuration-run.mjs';
import { sandbox } from './helpers.mjs';

function fixture(t, review = 'both', extraHeader = '') {
  const root = mkdtempSync(join(tmpdir(), 'bollplank-consulting-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profile = { mode: 'consulting', runs: true, ticketPrefix: 'ACME', tickets: join(root, 'runs'), board: { teamId: 'synthetic-team', projectId: 'synthetic-project' }, targets: { workspace: { synthetic: true } }, verificationChecks: ['brief-acceptance'] };
  const put = (name, content) => {
    const p = join(root, name);
    writeFileSync(p, content);
    return p;
  };
  const brief = put('brief.md', `Brief v1\nApproval: Approved by Ada on today (synthetic approval)\nCross-model review: ${review}. Synthetic case\n${extraHeader}`);
  const live = put('live.json', JSON.stringify({ id: 'ACME-5', teamId: profile.board.teamId, projectId: profile.board.projectId, observedAt: new Date().toISOString(), description: readFileSync(brief, 'utf8') }));
  const plan = put('plan.md', 'Synthetic plan');
  const code = put('code-subject.json', '{"repository":"synthetic","head":"synthetic-head"}');
  const proof = put('proof.json', '{"synthetic":true}');
  const run = (cmd, opts = {}, positional = [], ticket = 'ACME-5') => configurationRun({ project: 'acme-advice', ticket, profile, cmd, opts, positional, approver: 'Ada' });
  const init = (r = review) => run('init', { brief, approval: 'synthetic approval', instruction: 'synthetic explicit run', review: r, 'board-readback': live });
  const planned = () => {
    init();
    const p = run('plan', { path: plan });
    if (['plan', 'both'].includes(review)) run('stage', { revision: p.record.plan.sha256, verdict: 'Approve', evidence: proof }, ['plan']);
  };
  return { root, profile, put, brief, live, plan, code, proof, run, init, planned };
}

test('project prefix admits present and future tickets without creating a run', (t) => {
  const f = fixture(t);
  for (const ticket of ['ACME-4', 'ACME-5', 'ACME-6', 'ACME-9999']) {
    assert.equal(f.run('check', {}, [], ticket).exists, false);
  }
  for (const ticket of ['OTHER-5', 'ACME-0', 'ACME-../5', 'ACME-5/extra']) {
    assert.throws(() => f.run('check', {}, [], ticket), /not enabled/);
  }
  assert.equal(existsSync(f.profile.tickets), false);
  f.profile.runs = false;
  assert.throws(() => f.run('check'), /disabled/);
  assert.equal(existsSync(f.profile.tickets), false);
});

test('project eligibility retains approval, identity, freshness and explicit start requirements', (t) => {
  const f = fixture(t);
  assert.throws(() => f.run('init', { brief: f.brief }), /instruction/);
  writeFileSync(f.brief, 'Brief v1\nApproval: Pending\nCross-model review: both\n');
  assert.throws(() => f.init(), /not approved/);
  writeFileSync(f.brief, 'Brief v1\nApproval: Approved by Ada on today\nCross-model review: both\n');
  const live = JSON.parse(readFileSync(f.live));
  writeFileSync(f.live, JSON.stringify({ ...live, teamId: 'wrong-team', description: readFileSync(f.brief, 'utf8') }));
  assert.throws(() => f.init(), /identity mismatch/);
  writeFileSync(f.live, JSON.stringify({ ...live, description: readFileSync(f.brief, 'utf8') }));
  const r = f.init().record;
  assert.equal(r.mode, 'consulting');
  assert.equal(r.stages.plan.selected, true);
  assert.equal(r.stages.code.selected, true);
  f.run('log', { event: 'Blocked pending the other synthetic ticket. Return control to the user.' });
  assert.equal(f.init().resume, true);
  assert.equal(f.run('show').record.log.length, 1);
  assert.equal(existsSync(join(f.profile.tickets, 'ACME-4')), false);
});

test('an approved brief with Critic: same initializes a consulting run, and a differing review is still refused', (t) => {
  const f = fixture(t, 'both', 'Critic: same\n');
  assert.throws(() => f.init('plan'), /review differs/);
  assert.throws(() => f.init('none'), /review differs/);
  assert.equal(existsSync(join(f.profile.tickets, 'ACME-5', '.run.json')), false);
  const r = f.init('both').record;
  assert.equal(r.critic, 'same');
  assert.equal(r.stages.code.selected, true);
});

test('plan and code review gates bind exact subjects and evidence before integration', (t) => {
  const f = fixture(t);
  f.init();
  assert.throws(() => f.run('code', { path: f.code }), /plan/);
  const p = f.run('plan', { path: f.plan });
  assert.throws(() => f.run('gate', {}, ['plan']), /review/);
  f.run('stage', { revision: p.record.plan.sha256, verdict: 'Approve', evidence: f.proof }, ['plan']);
  const c = f.run('code', { path: f.code });
  assert.throws(() => f.run('change', { id: 'merge', target: 'workspace', status: 'intent', evidence: f.proof, gate: 'code' }), /code review/);
  assert.throws(() => f.run('stage', { revision: 'stale', verdict: 'Approve', evidence: f.proof }, ['code']), /current code hash/);
  f.run('stage', { revision: c.record.code.sha256, verdict: 'Approve', evidence: f.proof }, ['code']);
  assert.equal(f.run('gate', {}, ['code']).complete, true);
  writeFileSync(f.code, 'Changed synthetic code subject');
  assert.throws(() => f.run('gate', {}, ['code']), /changed/);
  f.run('code', { path: f.code });
  assert.throws(() => f.run('gate', {}, ['code']), /review/);
});

test('completion checks the selected code gate and actual brief acceptance evidence', (t) => {
  const f = fixture(t);
  f.planned();
  f.run('change', { id: 'artifact', target: 'workspace', status: 'intent', evidence: f.proof });
  f.run('change', { id: 'artifact', target: 'workspace', status: 'verified', evidence: f.proof });
  f.run('verify', { check: 'brief-acceptance', status: 'pass', evidence: f.proof });
  assert.throws(() => f.run('complete'), /code subject/);
  const c = f.run('code', { path: f.code });
  f.run('stage', { revision: c.record.code.sha256, verdict: 'Approve', evidence: f.proof }, ['code']);
  assert.throws(() => f.run('complete'), /verification incomplete/);
  f.run('verify', { check: 'brief-acceptance', status: 'pass', evidence: f.proof });
  assert.equal(f.run('complete').record.status, 'Acceptance');
  f.run('plan', { path: f.plan });
  assert.equal(f.run('show').record.stages.code.complete, false);
  assert.equal(f.run('show').record.code, null);
});

test('research with no code review needs no artificial code artifact or deployment', (t) => {
  const f = fixture(t, 'none');
  f.planned();
  f.run('change', { id: 'report', target: 'workspace', status: 'intent', evidence: f.proof });
  f.run('change', { id: 'report', target: 'workspace', status: 'verified', evidence: f.proof });
  f.run('verify', { check: 'brief-acceptance', status: 'pass', evidence: f.proof });
  assert.equal(f.run('complete').record.status, 'Acceptance');
  assert.equal(f.run('show').record.code, null);
});

test('legacy configuration records stay readable and cannot be silently converted', (t) => {
  const f = fixture(t);
  const folder = join(f.profile.tickets, 'ACME-5');
  mkdirSync(folder, { recursive: true });
  const p = join(folder, '.run.json');
  const original = JSON.stringify({ mode: 'configuration', project: 'acme-advice', ticket: 'ACME-5', status: 'Acceptance', synthetic: true });
  writeFileSync(p, original);
  assert.equal(f.run('show').record.mode, 'configuration');
  assert.throws(() => f.run('log', { event: 'convert' }), /identity mismatch/);
  assert.equal(readFileSync(p, 'utf8'), original);
});

test('the CLI routes consulting runs, reads the approver from config and prints large records whole', (t) => {
  const s = sandbox();
  t.after(s.clean);
  const tickets = join(s.root, 'advice-runs');
  const project = { mode: 'consulting', runs: true, source: join(s.root, 'advice'), tickets, board: { teamId: 'synthetic-team', projectId: 'synthetic-project' }, ticketPrefix: 'ACME', targets: { workspace: { synthetic: true } }, runbook: 'docs/runbook.md', verificationChecks: ['brief-acceptance'] };
  s.config({ approver: { name: 'Ada' }, board: { kind: 'linear' }, projects: { 'acme-advice': project } });
  let r = s.run(['run', 'check', 'acme-advice', 'ACME-1234']);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.mode, 'consulting');
  assert.equal(existsSync(tickets), false);
  assert.equal(s.run(['run', 'check', 'acme-advice', 'ACME-../5']).json.failure, 'usage');

  const brief = join(s.root, 'brief.md');
  writeFileSync(brief, 'Brief v1\nApproval: Approved by Ada on today\nCross-model review: plan. Synthetic\nCritic: same\n');
  const live = join(s.root, 'live.json');
  writeFileSync(live, JSON.stringify({ id: 'ACME-5', teamId: 'synthetic-team', projectId: 'synthetic-project', observedAt: new Date().toISOString(), description: readFileSync(brief, 'utf8') }));
  const init = (review) => s.run(['run', 'init', 'acme-advice', 'ACME-5', '--brief', brief, '--approval', 'synthetic', '--instruction', 'synthetic run', '--review', review, '--board-readback', live]);
  r = init('both');
  assert.equal(r.status, 1);
  assert.equal(r.json.failure, 'refused');
  assert.match(r.json.detail, /review differs/);
  r = init('plan');
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.record.critic, 'same');

  // A different approver in config no longer matches the brief.
  s.config({ approver: { name: 'Grace' }, board: { kind: 'linear' }, projects: { 'acme-advice': project } });
  rmSync(join(tickets, 'ACME-5'), { recursive: true });
  assert.match(init('plan').json.detail, /not approved/);
  s.config({ approver: { name: 'Ada' }, board: { kind: 'linear' }, projects: { 'acme-advice': project } });
  assert.equal(init('plan').status, 0);

  const path = join(tickets, 'ACME-5', '.run.json');
  const record = JSON.parse(readFileSync(path, 'utf8'));
  record.largeEvidence = 'x'.repeat(90000);
  writeFileSync(path, JSON.stringify(record));
  const shown = s.run(['run', 'show', 'acme-advice', 'ACME-5']);
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.json.record.largeEvidence.length, 90000);

  s.config({ approver: { name: 'Ada' }, board: { kind: 'linear' }, projects: { 'acme-advice': { ...project, runs: false } } });
  r = s.run(['run', 'show', 'acme-advice', 'ACME-5']);
  assert.equal(r.json.failure, 'runs-disabled');
});
