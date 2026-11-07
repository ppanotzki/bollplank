import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configurationRun } from '../lib/configuration-run.mjs';
import { sandbox, gitRepo } from './helpers.mjs';

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

// The project's AGENTS.md in its source folder, for the --agents cases.
function withAgents(f, text = 'Release notes stay on the ticket.\n') {
  const source = join(f.root, 'workspace');
  mkdirSync(source, { recursive: true });
  f.profile.source = source;
  const agents = join(source, 'AGENTS.md');
  writeFileSync(agents, text);
  return agents;
}
const sha = (text) => createHash('sha256').update(text).digest('hex');
const rebaselineArgs = (f, extra = {}) => ({ brief: f.brief, approval: 'synthetic approval', review: 'both', 'board-readback': f.live, reason: 'synthetic amendment', authorization: 'synthetic decision', 'scope-evidence': f.proof, ...extra });

test('init with --agents keeps a copy of the project AGENTS.md and its hash, and show prints them', (t) => {
  const f = fixture(t);
  const agents = withAgents(f);
  const r = f.run('init', { brief: f.brief, approval: 'synthetic approval', instruction: 'synthetic explicit run', review: 'both', 'board-readback': f.live, agents }).record;
  assert.equal(r.agents.sha256, sha('Release notes stay on the ticket.\n'));
  assert.equal(r.agents.path, join(f.profile.tickets, 'ACME-5', 'baseline-1', 'agents.md'));
  assert.equal(readFileSync(r.agents.path, 'utf8'), 'Release notes stay on the ticket.\n');
  assert.equal(r.baselines[0].agents.sha256, r.agents.sha256);
  writeFileSync(agents, 'Changed after the start.\n');
  const shown = f.run('show').record;
  assert.equal(shown.agents.sha256, r.agents.sha256);
  assert.equal(f.init().resume, true);
  assert.deepEqual(f.run('show').record.agents, r.agents);
});

test('init without --agents still works and records no profile', (t) => {
  const f = fixture(t);
  withAgents(f);
  const r = f.init().record;
  assert.equal(r.agents, null);
  assert.equal(r.baselines[0].agents, null);
});

test('--agents must be the AGENTS.md in the source folder and must not be empty', (t) => {
  const f = fixture(t);
  const agents = withAgents(f);
  const base = { brief: f.brief, approval: 'synthetic approval', instruction: 'synthetic explicit run', review: 'both', 'board-readback': f.live };
  const nested = join(f.profile.source, 'repos', 'acme-api');
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, 'AGENTS.md'), 'A nested repo of its own.\n');
  assert.throws(() => f.run('init', { ...base, agents: join(nested, 'AGENTS.md') }), /source folder/);
  assert.throws(() => f.run('init', { ...base, agents: f.proof }), /source folder/);
  assert.throws(() => f.run('init', { ...base, agents: '' }), /--agents is required/);
  const link = join(f.root, 'linked-agents.md');
  symlinkSync(agents, link);
  writeFileSync(agents, '');
  assert.throws(() => f.run('init', { ...base, agents: link }), /empty/);
  delete f.profile.source;
  writeFileSync(agents, 'Text\n');
  assert.throws(() => f.run('init', { ...base, agents }), /no source configured/);
  assert.equal(existsSync(join(f.profile.tickets, 'ACME-5', '.run.json')), false);
});

test('a Git source with a local AGENTS.md change records the local bytes the run reads', (t) => {
  const f = fixture(t);
  const repo = gitRepo(f.root, 'workspace');
  repo.commit('AGENTS.md', 'Committed rules.\n');
  repo.git('push', '-q', 'origin', 'main');
  writeFileSync(join(repo.work, 'AGENTS.md'), 'Uncommitted local rules.\n');
  f.profile.source = repo.work;
  const r = f.run('init', { brief: f.brief, approval: 'synthetic approval', instruction: 'synthetic explicit run', review: 'both', 'board-readback': f.live, agents: join(repo.work, 'AGENTS.md') }).record;
  assert.equal(r.agents.sha256, sha('Uncommitted local rules.\n'));
  assert.notEqual(r.agents.sha256, sha(repo.git('show', 'origin/main:AGENTS.md') + '\n'));
});

test('a rebaseline with only a changed AGENTS.md succeeds and keeps the prior copy', (t) => {
  const f = fixture(t);
  const agents = withAgents(f, 'First rules.\n');
  f.run('init', { brief: f.brief, approval: 'synthetic approval', instruction: 'synthetic explicit run', review: 'both', 'board-readback': f.live, agents });
  assert.throws(() => f.run('rebaseline', rebaselineArgs(f, { agents })), /unchanged/);
  writeFileSync(agents, 'Second rules.\n');
  const r = f.run('rebaseline', rebaselineArgs(f, { agents })).record;
  assert.equal(r.baselines.length, 2);
  assert.equal(readFileSync(r.baselines[0].agents.path, 'utf8'), 'First rules.\n');
  assert.equal(r.agents.sha256, sha('Second rules.\n'));
});

test('a rebaseline without --agents carries the recorded copy forward', (t) => {
  const f = fixture(t);
  const agents = withAgents(f, 'Recorded rules.\n');
  f.run('init', { brief: f.brief, approval: 'synthetic approval', instruction: 'synthetic explicit run', review: 'both', 'board-readback': f.live, agents });
  writeFileSync(agents, 'Edited later.\n');
  assert.throws(() => f.run('rebaseline', rebaselineArgs(f)), /unchanged/);
  const brief2 = f.put('brief2.md', readFileSync(f.brief, 'utf8').replace('Brief v1', 'Brief v2'));
  const live2 = f.put('live2.json', JSON.stringify({ ...JSON.parse(readFileSync(f.live)), description: readFileSync(brief2, 'utf8'), observedAt: new Date().toISOString() }));
  const r = f.run('rebaseline', rebaselineArgs(f, { brief: brief2, 'board-readback': live2 })).record;
  assert.equal(r.baselines[1].agents.sha256, sha('Recorded rules.\n'));
  assert.equal(r.baselines[1].agents.path, join(f.profile.tickets, 'ACME-5', 'baseline-2', 'agents.md'));
  assert.equal(r.baselines[1].agents.source, r.baselines[0].agents.source);
  assert.deepEqual(r.agents, r.baselines[1].agents);
  writeFileSync(r.agents.path, 'Tampered copy.\n');
  const brief3 = f.put('brief3.md', readFileSync(f.brief, 'utf8').replace('Brief v1', 'Brief v3'));
  const live3 = f.put('live3.json', JSON.stringify({ ...JSON.parse(readFileSync(f.live)), description: readFileSync(brief3, 'utf8'), observedAt: new Date().toISOString() }));
  assert.throws(() => f.run('rebaseline', rebaselineArgs(f, { brief: brief3, 'board-readback': live3 })), /prior AGENTS.md/);
});

test('a rebaseline without --agents on a run that never recorded one keeps working', (t) => {
  const f = fixture(t);
  withAgents(f);
  f.init();
  const brief2 = f.put('brief2.md', readFileSync(f.brief, 'utf8').replace('Brief v1', 'Brief v2'));
  const live2 = f.put('live2.json', JSON.stringify({ ...JSON.parse(readFileSync(f.live)), description: readFileSync(brief2, 'utf8'), observedAt: new Date().toISOString() }));
  const r = f.run('rebaseline', rebaselineArgs(f, { brief: brief2, 'board-readback': live2 })).record;
  assert.equal(r.baselines[1].agents, null);
  assert.equal(r.agents, null);
});

test('completion refuses a changed AGENTS.md copy', (t) => {
  const f = fixture(t, 'none');
  const agents = withAgents(f);
  f.run('init', { brief: f.brief, approval: 'synthetic approval', instruction: 'synthetic explicit run', review: 'none', 'board-readback': f.live, agents });
  f.run('plan', { path: f.plan });
  f.run('change', { id: 'report', target: 'workspace', status: 'intent', evidence: f.proof });
  f.run('change', { id: 'report', target: 'workspace', status: 'verified', evidence: f.proof });
  f.run('verify', { check: 'brief-acceptance', status: 'pass', evidence: f.proof });
  const copy = f.run('show').record.agents.path;
  writeFileSync(copy, 'Tampered.\n');
  assert.throws(() => f.run('complete'), /baseline evidence/);
});

test('the CLI takes --agents for a consulting init', (t) => {
  const s = sandbox();
  t.after(s.clean);
  const source = join(s.root, 'advice');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'AGENTS.md'), 'Release notes stay on the ticket.\n');
  const tickets = join(s.root, 'advice-runs');
  const project = { mode: 'consulting', runs: true, source, tickets, board: { teamId: 'synthetic-team', projectId: 'synthetic-project' }, ticketPrefix: 'ACME', targets: { workspace: { synthetic: true } }, runbook: 'docs/runbook.md', verificationChecks: ['brief-acceptance'] };
  s.config({ approver: { name: 'Ada' }, board: { kind: 'linear' }, projects: { 'acme-advice': project } });
  const brief = join(s.root, 'brief.md');
  writeFileSync(brief, 'Brief v1\nApproval: Approved by Ada on today\nCross-model review: plan. Synthetic\n');
  const live = join(s.root, 'live.json');
  writeFileSync(live, JSON.stringify({ id: 'ACME-5', teamId: 'synthetic-team', projectId: 'synthetic-project', observedAt: new Date().toISOString(), description: readFileSync(brief, 'utf8') }));
  const r = s.run(['run', 'init', 'acme-advice', 'ACME-5', '--brief', brief, '--approval', 'synthetic', '--instruction', 'synthetic run', '--review', 'plan', '--board-readback', live, '--agents', join(source, 'AGENTS.md')]);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.record.agents.sha256, sha('Release notes stay on the ticket.\n'));
  assert.equal(s.run(['run', 'show', 'acme-advice', 'ACME-5']).json.record.agents.sha256, r.json.record.agents.sha256);
});
