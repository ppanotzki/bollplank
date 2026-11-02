// bollplank turn take|release|status [<TICKET>] [--session <id>]
// The shipping turn: one lock on this machine, shared by every tool and session, so only one
// ticket ships at a time.
//
//   take <TICKET> [--session <id>]   exits 0 when this ticket holds the turn
//   release <TICKET>                 only the holder can release
//   status
//
// The lock is a folder created with mkdir, which is atomic, holding holder.json with
// { ticket, session, since, pid }. agent-workflow's aw-turn writes the same record, so with
// shipLock pointed at its lock folder a turn held by either kit blocks the other. Taking it again
// for the same ticket is allowed, so a resumed run gets its turn back. A lock is never broken
// automatically. An old one is reported, and the approver decides.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse } from '../args.mjs';
import { readConfig } from '../config.mjs';
import { emit, fail } from '../out.mjs';
import { paths } from '../paths.mjs';
import { ticketId } from '../git.mjs';

export const usage = 'bollplank turn take|release|status [<TICKET>] [--session <id>]';

// The lock needs no project, so a missing config falls back to the default lock path.
function lockPath() {
  const r = readConfig();
  if (r.missing) return paths().shipLock;
  if (r.problems.length) fail('config', r.problems.join('. '));
  return r.config.shipLock;
}

export function run(argv) {
  const { opts, positional, error } = parse(argv, { session: 'value' });
  const [cmd, ticketArg, ...extra] = positional ?? [];
  if (error || !cmd || extra.length) fail('usage', error ?? usage);
  const lock = lockPath();
  const holderFile = join(lock, 'holder.json');
  const holder = () => {
    if (!existsSync(holderFile)) return null;
    try {
      return JSON.parse(readFileSync(holderFile, 'utf8'));
    } catch {
      return { unreadable: true };
    }
  };
  const age = (h) => (h?.since ? Math.round((Date.now() - Date.parse(h.since)) / 60000) : null);
  const noHolder = `the lock folder ${lock} exists without a readable holder record. Another take may be in progress. Check that nothing is shipping, then remove the folder by hand.`;

  if (cmd === 'status') {
    if (ticketArg) fail('usage', usage);
    if (!existsSync(lock)) emit({ ok: true, lock, held: false });
    const h = holder();
    emit({ ok: true, lock, held: true, holder: h, minutes: age(h) });
  }
  if (cmd !== 'take' && cmd !== 'release') fail('usage', usage);
  const ticket = ticketId(ticketArg);
  if (!ticket) fail('usage', `${cmd} needs a ticket id like ACME-1. ${usage}`);

  if (cmd === 'take') {
    mkdirSync(dirname(lock), { recursive: true });
    try {
      mkdirSync(lock);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const h = holder();
      if (h?.ticket === ticket) emit({ ok: true, lock, holder: h, note: 'already held by this ticket' });
      if (!h || h.unreadable) fail('no-holder', noHolder, { lock });
      fail('held', `held by ${h.ticket} for ${age(h)} minutes`, { lock, holder: h, minutes: age(h) });
    }
    const h = { ticket, session: opts.session ?? null, since: new Date().toISOString(), pid: process.ppid };
    writeFileSync(holderFile, JSON.stringify(h, null, 2) + '\n');
    emit({ ok: true, lock, holder: h });
  }

  // release
  if (!existsSync(lock)) emit({ ok: true, lock, note: 'no turn was held' });
  const h = holder();
  // aw-turn crashed here when the folder had no holder record. Bollplank refuses instead, since
  // the folder may belong to a take that has not written its record yet.
  if (!h || h.unreadable) fail('no-holder', noHolder, { lock });
  if (h.ticket !== ticket) fail('not-holder', `held by ${h.ticket ?? 'unknown'}, not ${ticket}`, { lock, holder: h });
  rmSync(lock, { recursive: true, force: true });
  emit({ ok: true, lock, released: ticket, heldMinutes: age(h) });
}
