import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sandbox, acmeConfig, bin } from './helpers.mjs';

// What agent-workflow's aw-turn does with the same folder: mkdir the lock, then write holder.json
// with { ticket, session, since, pid }. A take that finds the folder reads the holder instead.
function awTurnTake(lock, ticket) {
  mkdirSync(dirname(lock), { recursive: true });
  try {
    mkdirSync(lock);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const h = existsSync(join(lock, 'holder.json')) ? JSON.parse(readFileSync(join(lock, 'holder.json'), 'utf8')) : null;
    return h?.ticket === ticket ? { ok: true, holder: h } : { ok: false, holder: h };
  }
  const h = { ticket, session: 'aw-session', since: new Date(Date.now() - 5 * 60000).toISOString(), pid: 4242 };
  writeFileSync(join(lock, 'holder.json'), JSON.stringify(h, null, 2) + '\n');
  return { ok: true, holder: h };
}

function setup(t) {
  const s = sandbox();
  t.after(s.clean);
  const shared = join(s.root, 'shared');
  const lock = join(shared, 'ship.lock');
  s.config({ ...acmeConfig(join(s.root, 'src'), join(s.root, 'tickets')), shipLock: lock });
  return { s, lock, turn: (...a) => s.run(['turn', ...a]) };
}

test('a holder written by aw-turn in the shared folder blocks bollplank turn take', (t) => {
  const { lock, turn } = setup(t);
  assert.equal(awTurnTake(lock, 'ACME-7').ok, true);
  const r = turn('take', 'ACME-1');
  assert.equal(r.status, 1);
  assert.equal(r.json.failure, 'held');
  assert.equal(r.json.holder.ticket, 'ACME-7');
  assert.equal(r.json.minutes, 5);
  assert.equal(turn('release', 'ACME-1').json.failure, 'not-holder');
  const st = turn('status').json;
  assert.equal(st.held, true);
  assert.equal(st.holder.session, 'aw-session');
});

test('a Bollplank holder blocks a second taker of either kit, and the same ticket takes it again', (t) => {
  const { lock, turn } = setup(t);
  const r = turn('take', 'acme-1', '--session', 'synthetic-session');
  assert.equal(r.status, 0, r.stdout);
  const h = JSON.parse(readFileSync(join(lock, 'holder.json'), 'utf8'));
  assert.deepEqual(Object.keys(h).sort(), ['pid', 'session', 'since', 'ticket']);
  assert.equal(h.ticket, 'ACME-1');
  assert.equal(h.session, 'synthetic-session');
  assert.equal(typeof h.pid, 'number');
  assert.equal(turn('take', 'ACME-2').json.failure, 'held');
  const aw = awTurnTake(lock, 'ACME-2');
  assert.equal(aw.ok, false);
  assert.equal(aw.holder.ticket, 'ACME-1');
  assert.match(turn('take', 'ACME-1').json.note, /already held/);
  const rel = turn('release', 'ACME-1');
  assert.equal(rel.status, 0);
  assert.equal(rel.json.released, 'ACME-1');
  assert.equal(existsSync(lock), false);
  assert.match(turn('release', 'ACME-1').json.note, /no turn/);
  assert.equal(turn('status').json.held, false);
});

test('a lock folder without a holder record is refused, never crashed on or removed', (t) => {
  const { lock, turn } = setup(t);
  mkdirSync(lock, { recursive: true });
  let r = turn('release', 'ACME-1');
  assert.equal(r.status, 1);
  assert.equal(r.json.failure, 'no-holder');
  assert.equal(turn('take', 'ACME-1').json.failure, 'no-holder');
  writeFileSync(join(lock, 'holder.json'), 'not json');
  r = turn('release', 'ACME-1');
  assert.equal(r.json.failure, 'no-holder');
  assert.ok(existsSync(lock));
  assert.equal(turn('status').json.holder.unreadable, true);
});

test('turn without a config uses the default lock in the Bollplank home, and checks its arguments', (t) => {
  const s = sandbox();
  t.after(s.clean);
  const r = s.run(['turn', 'take', 'ACME-3']);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.lock, join(s.bollplank, 'ship.lock'));
  assert.ok(existsSync(join(s.bollplank, 'ship.lock', 'holder.json')));
  assert.equal(s.run(['turn', 'take']).status, 2);
  assert.equal(s.run(['turn', 'take', 'not a ticket']).status, 2);
  assert.equal(s.run(['turn', 'grab', 'ACME-3']).status, 2);
  assert.equal(s.run(['turn', 'take', 'ACME-3', '--session']).status, 2);
});

test('relative paths in the config resolve against its folder, and a relative BOLLPLANK_HOME against the current folder', (t) => {
  const s = sandbox();
  t.after(s.clean);
  s.config({ ...acmeConfig('code', 'Tickets'), shipLock: 'locks/ship.lock' });
  const from = (cwd, extra = {}) => {
    mkdirSync(cwd, { recursive: true });
    const r = spawnSync(process.execPath, [bin, ...extra.args], { cwd, env: { ...s.env, ...extra.env }, encoding: 'utf8' });
    return JSON.parse(r.stdout);
  };
  for (const cwd of [s.root, join(s.root, 'elsewhere', 'deeper')]) {
    assert.equal(from(cwd, { args: ['turn', 'status'] }).lock, join(s.bollplank, 'locks', 'ship.lock'));
    assert.equal(from(cwd, { args: ['run', 'show', 'acme-shop', 'ACME-1'] }).detail, `no run record at ${join(s.bollplank, 'Tickets', 'ACME-1', '.run.json')}`);
  }
  const relative = from(s.root, { args: ['turn', 'status'], env: { BOLLPLANK_HOME: join('home', '.bollplank') } });
  // The current folder comes back as its real path, /private/var rather than /var on a Mac.
  assert.equal(relative.lock, join(realpathSync(s.bollplank), 'locks', 'ship.lock'));
  // An empty BOLLPLANK_HOME counts as not set.
  assert.equal(from(s.root, { args: ['turn', 'status'], env: { BOLLPLANK_HOME: '' } }).lock, join(s.home, '.bollplank', 'locks', 'ship.lock'));
});
