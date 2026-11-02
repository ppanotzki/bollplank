import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

test('run refuses unknown commands, bad ticket ids and a missing record', (t) => {
  const f = setup(t);
  assert.equal(f.run('show', 'acme-shop', 'ACME-1').json.failure, 'no-run');
  assert.equal(f.run('fly', 'acme-shop', 'ACME-1').status, 2);
  assert.equal(f.run('show', 'acme-shop', '../ACME-1').status, 2);
  assert.equal(f.run('show', 'nope', 'ACME-1').status, 2);
  assert.equal(f.run('show', 'acme-shop', 'ACME-1', '--bogus', 'x').status, 2);
});
