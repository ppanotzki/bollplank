// bollplank ledger mark <TICKET>
// bollplank ledger collect <TICKET> --created <iso> --approved <iso> --done <iso> [--shipped <iso>]
//   [--run <ticket folder>] [--raised ACME-1,ACME-2] [--title <text>] [--write] [--markdown]
// bollplank ledger rollup [--json]
//
// The ticket ledger: tokens per model for a ticket's brief and implementation, and its timeline.
// `mark` says "now working on <TICKET>" for the session that runs it, and its tool call in the session
// file is the marker. Markers of agent-workflow's `aw-ledger mark` count too. The critic binds each of
// its sessions to its ticket in bindings.jsonl, and its state files (critics/<TICKET>.<provider>.json)
// bind the sessions it ran before bindings existed. Bindings win over markers. The board stays with
// the agent: dates and the Raised list come in as options, and the agent posts the comment. --write
// replaces the ticket's rollup entry. `rollup` prints one line per ledgered ticket, for trends.
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, statSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse } from '../args.mjs';
import { emit, fail, say } from '../out.mjs';
import { paths, claudeDir, codexDir } from '../paths.mjs';
import { workflowLine } from '../version.mjs';
import { readClaude, readCodex, claudeFiles, walk, lines } from '../ledger/sessions.mjs';

export const usage = 'bollplank ledger mark <TICKET> | collect <TICKET> --created <iso> --approved <iso> --done <iso> [--shipped <iso>] [--run <folder>] [--raised <list>] [--title <text>] [--write] [--markdown] | rollup [--json]';

const TICKET = /^[A-Z][A-Z0-9]*-\d+$/;
const spec = { created: 'value', approved: 'value', done: 'value', shipped: 'value', run: 'value', raised: 'list', title: 'value', write: 'bool', markdown: 'bool', json: 'bool' };

export function run(argv) {
  const { opts, positional, error } = parse(argv, spec);
  if (error) fail('usage', error);
  const [cmd, ticketArg, ...extra] = positional;
  if (cmd === 'rollup' && !ticketArg) return rollup(opts);
  const ticket = (ticketArg ?? '').toUpperCase();
  if (!['mark', 'collect'].includes(cmd) || !TICKET.test(ticket) || extra.length) fail('usage', usage);
  if (cmd === 'mark') return mark(ticket);
  return collect(ticket, opts);
}

function mark(ticket) {
  // The tool call is the marker. The audit line is a convenience, so a store that cannot be written
  // (a sandbox, say) never fails the command.
  try {
    const store = paths().ledger;
    mkdirSync(store, { recursive: true });
    appendFileSync(join(store, 'marks.jsonl'), JSON.stringify({ ticket, at: new Date().toISOString(), cwd: process.cwd() }) + '\n');
  } catch {}
  say(`now working on ${ticket}`);
}

function collect(ticket, opts) {
  const store = paths().ledger;
  const claudeRoot = join(claudeDir(), 'projects');
  const codexRoot = join(codexDir(), 'sessions');
  const created = time(opts, 'created');
  const approved = time(opts, 'approved');
  const done = time(opts, 'done');
  const shipped = opts.shipped ? time(opts, 'shipped') : shippedFromRun(opts.run);
  const raised = (opts.raised ?? []).map((s) => s.toUpperCase());

  const bindings = [...criticStates(paths().critics), ...jsonl(join(store, 'bindings.jsonl'))].filter((b) => b.ticket && b.tool && b.session);
  const boundTo = new Map(bindings.map((b) => [`${b.tool}:${b.session}`, String(b.ticket).toUpperCase()]));
  const mine = new Set(bindings.filter((b) => String(b.ticket).toUpperCase() === ticket).map((b) => b.session));

  // Only files written since the ticket existed, and only those that name it or are its critics. A
  // subagent's ticket comes from its lead, so a lead and its subagents are read together.
  const named = new RegExp(`\\b${ticket}\\b`, 'i');
  const relevant = (file, text) => named.test(text) || [...mine].some((s) => basename(file).includes(s));
  const fresh = (file) => statSync(file).mtimeMs >= created;
  // A file too large for one string is listed as not read, never dropped silently.
  const unread = [];
  const read = (file) => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      unread.push(file);
      return '';
    }
  };
  const streams = [];
  const groups = new Map();
  for (const f of claudeFiles(claudeRoot)) groups.set(f.group, [...(groups.get(f.group) ?? []), f]);
  for (const group of groups.values()) {
    if (!group.some((f) => fresh(f.file))) continue;
    const texts = group.map((f) => read(f.file));
    if (group.some((f, i) => relevant(f.file, texts[i]))) group.forEach((f, i) => streams.push(readClaude(f.file, texts[i], f.lead)));
  }
  const codexAll = [...walk(codexRoot)];
  const loaded = new Set();
  const loadCodex = (file, text = read(file)) => {
    if (loaded.has(file)) return;
    loaded.add(file);
    const s = readCodex(file, text);
    streams.push(s);
    const parent = s.lead && codexAll.find((f) => basename(f).includes(s.lead));
    if (parent) loadCodex(parent);
  };
  for (const file of codexAll.filter(fresh)) {
    const text = read(file);
    if (relevant(file, text) || text.includes('"parent_thread_id"')) loadCodex(file, text);
  }

  // Each response counts once, across every file it appears in. The earliest file keeps it.
  streams.sort((a, b) => a.start - b.start);
  const seen = new Set();
  for (const s of streams) s.responses = s.responses.filter((r) => !seen.has(r.id) && seen.add(r.id));

  const byKey = new Map(streams.map((s) => [`${s.tool}:${s.session}`, s]));
  const marked = (s, t) => s.marks.filter((m) => m.at <= t).at(-1)?.ticket ?? null;
  const owner = (s, t) => {
    if (boundTo.has(`${s.tool}:${s.session}`)) return boundTo.get(`${s.tool}:${s.session}`);
    if (!s.lead) return marked(s, t);
    // A subagent keeps the ticket its lead was on when it started, whatever the lead marks later.
    const lead = byKey.get(`${s.tool}:${s.lead}`);
    return (lead && owner(lead, s.start)) ?? marked(s, t);
  };
  const touched = (s) => s.marks.some((m) => m.ticket === ticket) || (s.lead && byKey.get(`${s.tool}:${s.lead}`)?.marks.some((m) => m.ticket === ticket));

  const parts = { brief: {}, implementation: {}, unattributed: {} };
  let files = 0;
  for (const s of streams) {
    let used = false;
    for (const r of s.responses) {
      const who = owner(s, r.start);
      let part = null;
      if (who === ticket) part = r.start < approved ? 'brief' : r.start <= done ? 'implementation' : null;
      else if (who === null && touched(s) && r.start >= created && r.start <= done) part = 'unattributed';
      if (!part) continue;
      add(parts[part], `${s.tool === 'claude' ? 'Claude Code' : 'Codex'}, ${r.model ?? 'unknown model'}`, r.usage);
      used = true;
    }
    if (used) files++;
  }
  // One session should use one kit. A session marked by both is listed, since agent-workflow's
  // ledger reads only its own markers and would place that session's tokens differently.
  const mixedSessions = streams
    .filter((s) => new Set(s.marks.map((m) => m.kit)).size > 1)
    .map((s) => ({ tool: s.tool, session: s.session, file: s.file }));

  const collected = Date.now();
  const ledger = {
    ticket,
    title: opts.title ?? null,
    collected: new Date(collected).toISOString(),
    created: iso(created),
    approved: iso(approved),
    shipped: shipped ? iso(shipped) : null,
    done: iso(done),
    briefMinutes: minutes(approved - created),
    workMinutes: minutes(done - approved),
    brief: parts.brief,
    implementation: parts.implementation,
    unattributed: parts.unattributed,
    raised,
    files,
    unread,
    mixedSessions,
  };
  const markdown = render(ledger, collected);
  if (opts.write) {
    const path = join(store, 'rollup.json');
    const all = existsSync(path) ? readStore(path) : { tickets: {} };
    all.tickets[ticket] = ledger;
    mkdirSync(store, { recursive: true });
    writeFileSync(path + '.tmp', JSON.stringify(all, null, 2) + '\n');
    renameSync(path + '.tmp', path);
  }
  if (opts.markdown) return say(markdown);
  emit({ ok: true, written: Boolean(opts.write), ledger, markdown });
}

// A critic state file holds the session of its ticket and provider, so it binds that session even
// when the calls predate bindings.jsonl. A session bound both ways is still one session.
function criticStates(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const m = name.match(/^([A-Za-z][A-Za-z0-9]*-\d+)\.(codex|claude)(\.same)?\.json$/);
    if (!m) return [];
    try {
      const { sessionId } = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      return sessionId ? [{ ticket: m[1].toUpperCase(), tool: m[2], session: sessionId }] : [];
    } catch {
      return [];
    }
  });
}

function jsonl(path) {
  return existsSync(path) ? lines(readFileSync(path, 'utf8')) : [];
}

function add(group, key, u) {
  const g = (group[key] ??= { newInput: 0, cachedInput: 0, output: 0, total: 0 });
  for (const k of Object.keys(g)) g[k] += u[k];
}

// Options, times and the comment.

function time(opts, name) {
  const v = Date.parse(opts[name]);
  if (!v) fail('usage', `--${name} needs an ISO time`);
  return v;
}

// A deploy counts as shipped when its status is succeeded, which run deploy records now. The other
// values are what records written before that rule hold, and they keep counting.
const SHIPPED = /^(succeeded|SUCCEED|SUCCESS|merged|(CREATE|UPDATE)_COMPLETE)$/i;

function shippedFromRun(folder) {
  if (typeof folder !== 'string' || !existsSync(join(folder, '.run.json'))) return null;
  const file = join(folder, '.run.json');
  const run = readJson(file);
  const ok = (Array.isArray(run?.deploys) ? run.deploys : []).filter((d) => SHIPPED.test(d?.status ?? '')).map((d) => Date.parse(d.at));
  return ok.length ? Math.max(...ok) : null;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    fail('corrupt', `${file} is not valid JSON: ${e.message}`, { file });
  }
}

// The rollup store, which must hold a tickets object.
function readStore(file) {
  const all = readJson(file);
  if (!all || typeof all !== 'object' || typeof all.tickets !== 'object' || all.tickets === null) fail('corrupt', `${file} does not hold a tickets object`, { file });
  return all;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function minutes(ms) {
  return Math.max(0, Math.round(ms / 60000));
}

function local(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function span(min) {
  if (min < 60) return `${min} min`;
  if (min < 48 * 60) return `${Math.floor(min / 60)} h ${min % 60} min`;
  return `${Math.floor(min / 1440)} d ${Math.floor((min % 1440) / 60)} h`;
}

function table(group) {
  const rows = Object.entries(group).sort(([a], [b]) => a.localeCompare(b));
  if (!rows.length) return 'None recorded.';
  const n = (v) => v.toLocaleString('en-US');
  const all = { newInput: 0, cachedInput: 0, output: 0, total: 0 };
  for (const [, u] of rows) for (const k of Object.keys(all)) all[k] += u[k];
  const line = (name, u) => `| ${name} | ${n(u.newInput)} | ${n(u.cachedInput)} | ${n(u.output)} | ${n(u.total)} |`;
  return [
    '| Model | New input | Cached input | Output | Total |',
    '| -- | --: | --: | --: | --: |',
    ...rows.map(([k, u]) => line(k, u)),
    ...(rows.length > 1 ? [line('**All models**', all)] : []),
  ].join('\n');
}

function render(l, collected) {
  const at = (s) => local(Date.parse(s));
  const tool = (t) => (t === 'claude' ? 'Claude Code' : 'Codex');
  return [
    'Ticket ledger',
    `Collected: ${local(collected)} by bollplank ledger, from ${l.files} session files`,
    `Workflow: ${workflowLine()}`,
    '',
    '**Brief**, from the first draft to approval',
    '',
    table(l.brief),
    '',
    '**Implementation**, from approval to Done',
    '',
    table(l.implementation),
    '',
    '**Timeline**',
    '',
    `* Created ${at(l.created)}`,
    `* Approved ${at(l.approved)}, the brief took ${span(l.briefMinutes)}`,
    l.shipped ? `* Shipped ${at(l.shipped)}, ${span(minutes(Date.parse(l.shipped) - Date.parse(l.approved)))} after approval` : '* Shipped: not recorded',
    `* Done ${at(l.done)}, the work took ${span(l.workMinutes)}`,
    '',
    `**Raised:** ${l.raised.length ? l.raised.join(', ') : 'None.'}`,
    '',
    '**Unattributed:** tokens in the sessions that worked on this ticket that no marker places, from creation to Done.',
    '',
    table(l.unattributed),
    ...(l.mixedSessions.length
      ? [
          '',
          '**Sessions that used both kits**',
          '',
          "These sessions carry markers of both `aw-ledger mark` and `bollplank ledger mark`. One session should use one kit, since agent-workflow's ledger reads only its own markers and places these tokens differently.",
          '',
          ...l.mixedSessions.map((m) => `* ${tool(m.tool)} session ${m.session}, in ${basename(m.file)}`),
        ]
      : []),
    ...(l.unread.length ? ['', `**Not read:** ${l.unread.length} session files too large to read, so their tokens are missing: ${l.unread.map((f) => basename(f)).join(', ')}`] : []),
  ].join('\n');
}

function rollup(opts) {
  const path = join(paths().ledger, 'rollup.json');
  const all = existsSync(path) ? readStore(path).tickets : {};
  if (opts.json) emit({ ok: true, tickets: all });
  const sum = (g) => Object.values(g ?? {}).reduce((t, u) => t + u.total, 0).toLocaleString('en-US');
  const rows = Object.values(all).sort((a, b) => a.done.localeCompare(b.done));
  say(
    [
      '| Ticket | Done | Brief tokens | Implementation tokens | Brief took | Work took | Raised |',
      '| -- | -- | --: | --: | -- | -- | --: |',
      ...rows.map((l) => `| ${l.ticket}${l.title ? ` ${l.title}` : ''} | ${l.done.slice(0, 10)} | ${sum(l.brief)} | ${sum(l.implementation)} | ${span(l.briefMinutes)} | ${span(l.workMinutes)} | ${l.raised.length} |`),
    ].join('\n'),
  );
}
