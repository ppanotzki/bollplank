import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, acmeConfig } from './helpers.mjs';

function setup(t, extra = {}) {
  const s = sandbox();
  t.after(s.clean);
  const tickets = join(s.root, 'tickets');
  s.config(acmeConfig(join(s.root, 'src'), tickets, undefined, extra));
  const folder = join(tickets, 'ACME-1');
  const ticketFolder = () => {
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, '.ticket.json'), '{}');
  };
  const run = (...args) => s.run(['run', ...args]);
  return { s, tickets, folder, ticketFolder, run, record: () => JSON.parse(readFileSync(join(folder, '.run.json'), 'utf8')) };
}

test('repository init refuses a project whose runs are not switched on', (t) => {
  const f = setup(t, { runs: false });
  f.ticketFolder();
  const r = f.run('init', 'acme-shop', 'ACME-1', '--review', 'both');
  assert.equal(r.status, 1);
  assert.equal(r.json.failure, 'runs-disabled');
});

test('repository init needs the ticket folder and a review value, and resumes an existing record', (t) => {
  const f = setup(t);
  assert.equal(f.run('init', 'acme-shop', 'ACME-1', '--review', 'both').json.failure, 'no-ticket-folder');
  f.ticketFolder();
  assert.equal(f.run('init', 'acme-shop', 'ACME-1', '--review', 'all').status, 2);
  assert.equal(f.run('init', 'acme-shop', 'ACME-1', '--review').json.detail, '--review needs a value');
  assert.equal(f.run('init', 'acme-shop', 'ACME-1', '--review', 'both', '--critic', 'cousin').status, 2);
  const r = f.run('init', 'acme-shop', 'acme-1', '--review', 'both', '--critic', 'same');
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.record.ticket, 'ACME-1');
  assert.equal(r.json.record.critic, 'same');
  assert.deepEqual([r.json.record.stages.plan.selected, r.json.record.stages.code.selected], [true, true]);
  const again = f.run('init', 'acme-shop', 'ACME-1', '--review', 'none');
  assert.match(again.json.note, /resume/);
  assert.equal(again.json.record.review, 'both');
});

test('stages, gates, reopen, plan, log and show keep the record', (t) => {
  const f = setup(t);
  f.ticketFolder();
  f.run('init', 'acme-shop', 'ACME-1', '--review', 'plan');
  let r = f.run('gate', 'acme-shop', 'ACME-1', 'plan');
  assert.equal(r.status, 1);
  assert.equal(r.json.failure, 'stage-incomplete');
  r = f.run('gate', 'acme-shop', 'ACME-1', 'code');
  assert.equal(r.status, 0);
  assert.equal(r.json.selected, false);
  assert.equal(f.run('stage', 'acme-shop', 'ACME-1', 'code', '--revision', 'v1', '--verdict', 'Approve').json.failure, 'not-selected');
  assert.equal(f.run('stage', 'acme-shop', 'ACME-1', 'plan', '--revision', 'v1', '--verdict', 'Maybe').status, 2);
  r = f.run('stage', 'acme-shop', 'ACME-1', 'plan', '--revision', 'v1', '--verdict', 'Revise', '--points', '3');
  assert.equal(r.json.complete, false);
  r = f.run('stage', 'acme-shop', 'ACME-1', 'plan', '--revision', 'v2', '--verdict', 'Revise', '--complete');
  assert.equal(r.json.complete, true);
  assert.equal(f.run('gate', 'acme-shop', 'ACME-1', 'plan').status, 0);
  f.run('reopen', 'acme-shop', 'ACME-1', 'plan', '--reason', 'covered behaviour changed');
  assert.equal(f.run('gate', 'acme-shop', 'ACME-1', 'plan').status, 1);
  assert.equal(f.run('plan', 'acme-shop', 'ACME-1', '--commit', 'abc1234', '--path', 'docs/plans/ACME-1.md').json.plan.commit, 'abc1234');
  assert.equal(f.run('log', 'acme-shop', 'ACME-1').status, 2);
  assert.equal(f.run('log', 'acme-shop', 'ACME-1', '--event', 'synthetic stop').status, 0);
  f.run('deploy', 'acme-shop', 'ACME-1', 'acme-api', '--kind', 'github-actions', '--ref', 'deploy', '--commit', 'abc1234', '--status', 'running');
  f.run('deploy', 'acme-shop', 'ACME-1', 'acme-api', '--kind', 'github-actions', '--ref', 'deploy', '--commit', 'abc1234', '--status', 'succeeded');
  const rec = f.run('show', 'acme-shop', 'ACME-1').json.record;
  assert.equal(rec.stages.plan.rounds.length, 2);
  assert.equal(rec.stages.plan.rounds[0].points, 3);
  assert.equal(rec.deploys.length, 1);
  assert.equal(rec.deploys[0].status, 'succeeded');
  assert.ok(rec.log.some((e) => e.event === 'synthetic stop'));
  assert.deepEqual(rec, f.record());
});

test('a code round with one revision names the head of the one changed repo, and check-shipped needs it merged and deployed', (t) => {
  const f = setup(t);
  mkdirSync(f.folder, { recursive: true });
  writeFileSync(join(f.folder, '.ticket.json'), JSON.stringify({ project: 'acme-shop', ticket: 'ACME-1', branch: 'acme-1-x', repos: { 'acme-api': { kind: 'change' } } }));
  f.run('init', 'acme-shop', 'ACME-1', '--review', 'both');
  assert.equal(f.run('stage', 'acme-shop', 'ACME-1', 'code', '--revision', 'abc1234', '--verdict', 'Approve').status, 0);
  assert.deepEqual(f.record().stages.code.rounds[0].revisions, { 'acme-api': 'abc1234' });
  assert.match(f.run('stage', 'acme-shop', 'ACME-1', 'plan', '--revisions', 'acme-api=abc1234', '--verdict', 'Approve').json.detail, /--revisions is for a code round/);
  let r = f.run('check-shipped', 'acme-shop', 'ACME-1');
  assert.equal(r.status, 1);
  assert.equal(r.json.failure, 'not-shipped');
  assert.equal(r.json.detail, 'acme-api is not merged.');
  writeFileSync(join(f.folder, '.run.json'), JSON.stringify({ ...f.record(), repos: { 'acme-api': { merged: true, pr: 7, mergeCommit: 'd'.repeat(40) } } }));
  f.run('deploy', 'acme-shop', 'ACME-1', 'acme-api', '--kind', 'github-actions', '--ref', '41', '--commit', 'd'.repeat(40), '--status', 'failed');
  assert.match(f.run('check-shipped', 'acme-shop', 'ACME-1').json.detail, /last deploy of d{12} is failed/);
  f.run('deploy', 'acme-shop', 'ACME-1', 'acme-api', '--kind', 'github-actions', '--ref', '42', '--commit', 'D'.repeat(12), '--status', 'succeeded');
  r = f.run('check-shipped', 'acme-shop', 'ACME-1');
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.repos['acme-api'].deploy.ref, '42');
});

test('run refuses unknown commands, bad ticket ids and a missing record', (t) => {
  const f = setup(t);
  assert.equal(f.run('show', 'acme-shop', 'ACME-1').json.failure, 'no-run');
  assert.equal(f.run('fly', 'acme-shop', 'ACME-1').status, 2);
  assert.equal(f.run('show', 'acme-shop', '../ACME-1').status, 2);
  assert.equal(f.run('show', 'nope', 'ACME-1').status, 2);
  assert.equal(f.run('show', 'acme-shop', 'ACME-1', '--bogus', 'x').status, 2);
});

test('run deploy accepts only the known kinds and the statuses deploy-wait reports', (t) => {
  const f = setup(t);
  f.ticketFolder();
  f.run('init', 'acme-shop', 'ACME-1', '--review', 'none');
  for (const kind of ['none', 'command', 'amplify', 'github-actions', 'merge', 'release']) {
    for (const status of ['succeeded', 'failed', 'timeout', 'running']) {
      const r = f.run('deploy', 'acme-shop', 'ACME-1', 'acme-api', '--kind', kind, '--status', status);
      assert.equal(r.status, 0, `${kind} ${status}: ${r.stdout}`);
    }
  }
  const kind = f.run('deploy', 'acme-shop', 'ACME-1', 'acme-api', '--kind', 'ftp', '--status', 'succeeded');
  assert.equal(kind.status, 2);
  assert.match(kind.json.detail, /--kind must be one of none, command, amplify, github-actions, merge, release/);
  const status = f.run('deploy', 'acme-shop', 'ACME-1', 'acme-api', '--kind', 'amplify', '--status', 'SUCCEED');
  assert.equal(status.status, 2);
  assert.match(status.json.detail, /--status must be one of succeeded, failed, timeout, running/);
  assert.equal(f.record().deploys.length, 6);
});

test('a run record that is not valid JSON is a corrupt failure, and saves leave no temporary file', (t) => {
  const f = setup(t);
  f.ticketFolder();
  f.run('init', 'acme-shop', 'ACME-1', '--review', 'none');
  f.run('log', 'acme-shop', 'ACME-1', '--event', 'one');
  assert.deepEqual(readdirSync(f.folder).sort(), ['.run.json', '.ticket.json']);
  writeFileSync(join(f.folder, '.run.json'), '{"stages":');
  const r = f.run('show', 'acme-shop', 'ACME-1');
  assert.equal(r.status, 1);
  assert.equal(r.json.failure, 'corrupt');
  assert.equal(r.json.file, join(f.folder, '.run.json'));
  assert.doesNotMatch(r.stdout, /SyntaxError: .*\n\s+at /);
});
