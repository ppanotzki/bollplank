// Tests for `bollplank ledger` on synthetic Claude Code and Codex session files in a sandbox.
// Nothing here reads real session files or the real ledger store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { sandbox } from './helpers.mjs';

const at = (h, m = 0, s = 0) => new Date(Date.UTC(2026, 0, 1, h, m, s)).toISOString();
const write = (path, records) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
};
const sum = (...units) => units.reduce((a, b) => a + b, 0);

// Claude: n units are 11n new input (n input plus 10n cache writes), 100n cached and 2n output.
const cu = (n) => ({ input_tokens: n, cache_creation_input_tokens: 10 * n, cache_read_input_tokens: 100 * n, output_tokens: 2 * n });
const claudeTotal = (n) => ({ newInput: 11 * n, cachedInput: 100 * n, output: 2 * n, total: 113 * n });
const user = (t) => ({ type: 'user', timestamp: t, message: { role: 'user', content: 'go' } });
const reply = (t, id, n, content = [{ type: 'text', text: 'ok' }]) => ({
  type: 'assistant',
  timestamp: t,
  message: { id, model: 'claude-test', role: 'assistant', content, usage: cu(n) },
});
const bash = (command) => [{ type: 'tool_use', name: 'Bash', input: { command } }];

// Codex: n units are input 10n of which 6n cached, and output n, so 4n new, 6n cached, n output.
const xu = (n) => ({ input_tokens: 10 * n, cached_input_tokens: 6 * n, cache_write_input_tokens: 0, output_tokens: n, reasoning_output_tokens: n, total_tokens: 11 * n });
const codexTotal = (n) => ({ newInput: 4 * n, cachedInput: 6 * n, output: n, total: 11 * n });
const ev = (t, type, payload) => ({ timestamp: t, type, payload });
const meta = (t, id, source = 'exec') => ev(t, 'session_meta', { id, source });
const turn = (t) => [ev(t, 'event_msg', { type: 'task_started' }), ev(t, 'turn_context', { model: 'gpt-test' }), ev(t, 'response_item', { type: 'message', role: 'user' })];
const record = (t, id, n) => ev(t, 'token_usage_record', { response_id: id, usage: xu(n), turn_token_usage: xu(n * 3), thread_token_usage: xu(n * 5) });
const count = (t, total, last) => ev(t, 'event_msg', { type: 'token_count', info: { total_token_usage: xu(total), last_token_usage: last == null ? undefined : xu(last) } });
const shellCall = (t, command) => ev(t, 'response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', command] }) });
const execCall = (t, cmd) => ev(t, 'response_item', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd }) });

const C1 = '01a00000-0000-7000-8000-000000000001';
const C2 = '01a00000-0000-7000-8000-000000000002';
const F = '01a00000-0000-7000-8000-000000000003';
const CHILD = '01a00000-0000-7000-8000-000000000004';
const G = '01a00000-0000-7000-8000-000000000006';
const OLD = '01a00000-0000-7000-8000-000000000009';
const K = '0b000000-0000-4000-8000-00000000000k';
const SAME = '0b000000-0000-4000-8000-00000000000s';

// A sandbox with Claude and Codex session folders, the critics folder and the ledger store, and a
// runner for `bollplank ledger`. Each test gets its own and removes it afterwards.
function base(t) {
  const s = sandbox();
  t.after(s.clean);
  const dirs = {
    claude: join(s.claude, 'projects'),
    codex: join(s.codex, 'sessions', '2026', '01', '01'),
    critics: join(s.bollplank, 'critics'),
    store: join(s.bollplank, 'ledger'),
  };
  const ledger = (...args) => s.run(['ledger', ...args]);
  const collect = (ticket, ...extra) => {
    const r = ledger('collect', ticket, '--created', at(9), '--approved', at(12), '--done', at(20), ...extra);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return r.json.ledger;
  };
  return { s, ...dirs, ledger, collect };
}

// The shared fixture of agent-workflow's ledger tests, with its tickets named ACME.
function fixture(t) {
  const f = base(t);
  const { claude, codex, critics, ledger } = f;

  // A Claude lead session that works on ACME-1, starts a subagent, then switches to ACME-2.
  write(join(claude, 'proj', 'lead.jsonl'), [
    user(at(10, 0, 0)),
    reply(at(10, 0, 5), 'c1', 1, bash('aw-ledger mark ACME-1')),
    user(at(10, 0, 6)),
    reply(at(10, 0, 10), 'c2', 2),
    reply(at(10, 0, 11), 'c2', 2),
    user(at(12, 30, 0)),
    reply(at(12, 30, 5), 'c3', 4, [{ type: 'tool_use', name: 'Agent', input: { prompt: 'help' } }]),
    user(at(13, 0, 0)),
    reply(at(13, 0, 5), 'c4', 8, bash('cd x && aw-ledger mark acme-2')),
    user(at(13, 0, 6)),
    reply(at(13, 0, 10), 'c5', 16),
    user(at(21, 0, 0)),
    reply(at(21, 0, 5), 'c6', 512),
  ]);
  write(join(claude, 'proj', 'lead', 'subagents', 'agent-1.jsonl'), [
    user(at(12, 30, 1)),
    reply(at(12, 30, 5), 's1', 32),
    user(at(13, 30, 0)),
    reply(at(13, 30, 5), 's2', 64, bash('aw-ledger mark ACME-2')),
  ]);
  // A session with work before its first marker, for ACME-3, and mentions that are not markers.
  write(join(claude, 'proj2', 'late.jsonl'), [
    user(at(9, 30, 0)),
    reply(at(9, 30, 5), 'u1', 128, bash('grep "not aw-ledger mark" x; echo xaw-ledger mark ACME-3; echo xbollplank ledger mark ACME-3; bollplank ledgers mark ACME-3')),
    user(at(10, 0, 0)),
    reply(at(10, 0, 5), 'u2', 256, bash('aw-ledger mark ACME-3')),
  ]);
  // A Claude critic session bound to ACME-1, with a repeated record.
  write(join(claude, 'neutral', `${K}.jsonl`), [user(at(10, 10, 0)), reply(at(10, 10, 5), 'k1', 1000), reply(at(10, 10, 6), 'k1', 1000)]);
  // A same mode Claude critic for ACME-12, bound only by its state file.
  write(join(claude, 'neutral', `${SAME}.jsonl`), [user(at(10, 40, 0)), reply(at(10, 40, 5), 'm1', 300)]);

  // Two Codex critic sessions, ACME-1 and ACME-2, interleaved. C1 has a turn with two responses and a resumed turn.
  write(join(codex, `rollout-2026-01-01T10-05-00-${C1}.jsonl`), [
    meta(at(10, 5, 0), C1),
    ...turn(at(10, 5, 0)),
    ev(at(10, 5, 2), 'response_item', { type: 'reasoning' }),
    ev(at(10, 5, 3), 'response_item', { type: 'custom_tool_call', name: 'exec', input: 'ls' }),
    record(at(10, 5, 4), 'r1', 1),
    ev(at(10, 5, 5), 'response_item', { type: 'custom_tool_call_output' }),
    count(at(10, 5, 5), 1, 1),
    ev(at(10, 5, 8), 'response_item', { type: 'message', role: 'assistant' }),
    record(at(10, 5, 9), 'r2', 2),
    count(at(10, 5, 9), 3, 2),
    ...turn(at(10, 20, 0)),
    ev(at(10, 20, 3), 'response_item', { type: 'message', role: 'assistant' }),
    record(at(10, 20, 4), 'r3', 4),
    count(at(10, 20, 4), 7, 4),
  ]);
  write(join(codex, `rollout-2026-01-01T10-06-00-${C2}.jsonl`), [
    meta(at(10, 6, 0), C2),
    ...turn(at(10, 6, 0)),
    ev(at(10, 6, 3), 'response_item', { type: 'message', role: 'assistant' }),
    record(at(10, 6, 4), 'q1', 100),
    count(at(10, 6, 4), 100, 100),
  ]);
  // A Codex lead with only running totals (no per response records), marking ACME-4, and its child thread.
  write(join(codex, `rollout-2026-01-01T10-00-00-${F}.jsonl`), [
    meta(at(10, 0, 0), F, 'cli'),
    ...turn(at(10, 0, 0)),
    shellCall(at(10, 0, 3), 'aw-ledger mark ACME-4'),
    ev(at(10, 0, 4), 'response_item', { type: 'function_call_output' }),
    count(at(10, 0, 4), 5, 5),
    count(at(10, 0, 4), 5, 5),
    ev(at(10, 0, 9), 'response_item', { type: 'message', role: 'assistant' }),
    count(at(10, 0, 9), 12),
  ]);
  write(join(codex, `rollout-2026-01-01T13-00-00-${CHILD}.jsonl`), [
    meta(at(13, 0, 0), CHILD, { subagent: { thread_spawn: { parent_thread_id: F, depth: 1 } } }),
    ...turn(at(13, 0, 0)),
    ev(at(13, 0, 3), 'response_item', { type: 'message', role: 'assistant' }),
    record(at(13, 0, 4), 'h1', 3),
  ]);

  // A copy of the lead's history in another Claude file, as a resume or fork can leave.
  write(join(claude, 'proj3', 'copy.jsonl'), [user(at(22, 0, 0)), reply(at(22, 0, 5), 'c1', 1, bash('aw-ledger mark ACME-1')), reply(at(22, 0, 6), 'c2', 2)]);
  // A Codex session with only running totals, marked on the second line of a command, resumed into a
  // second file that copies the first file's records.
  const gFirst = [
    meta(at(13, 0, 0), G, 'cli'),
    ...turn(at(13, 0, 0)),
    execCall(at(13, 0, 3), 'cd /x\naw-ledger mark ACME-6'),
    ev(at(13, 0, 4), 'response_item', { type: 'function_call_output' }),
    count(at(13, 0, 4), 10, 10),
    ev(at(13, 0, 9), 'response_item', { type: 'message', role: 'assistant' }),
    count(at(13, 0, 9), 30, 20),
  ];
  write(join(codex, `rollout-2026-01-01T13-00-00-${G}.jsonl`), gFirst);
  write(join(codex, 'rollout-2026-01-01T14-00-00-01a00000-0000-7000-8000-000000000007.jsonl'), [
    ...gFirst,
    ...turn(at(14, 0, 0)),
    ev(at(14, 0, 3), 'response_item', { type: 'message', role: 'assistant' }),
    count(at(14, 0, 4), 35, 5),
  ]);
  // A Codex turn that ended without usage, then a new turn after approval.
  write(join(codex, 'rollout-2026-01-01T10-00-00-01a00000-0000-7000-8000-000000000008.jsonl'), [
    meta(at(10, 0, 0), '01a00000-0000-7000-8000-000000000008'),
    ...turn(at(10, 0, 0)),
    shellCall(at(10, 0, 3), 'aw-ledger mark ACME-7'),
    record(at(10, 0, 4), 'a1', 1),
    ev(at(10, 0, 5), 'response_item', { type: 'function_call_output' }),
    ev(at(10, 0, 8), 'response_item', { type: 'reasoning' }),
    ev(at(10, 0, 9), 'event_msg', { type: 'turn_aborted' }),
    ...turn(at(13, 0, 0)),
    ev(at(13, 0, 3), 'response_item', { type: 'message', role: 'assistant' }),
    record(at(13, 0, 4), 'a2', 10),
  ]);
  // A Codex critic for ACME-10 from before bindings existed: only its state file names the ticket.
  write(join(codex, `rollout-2026-01-01T10-30-00-${OLD}.jsonl`), [
    meta(at(10, 30, 0), OLD),
    ...turn(at(10, 30, 0)),
    ev(at(10, 30, 3), 'response_item', { type: 'message', role: 'assistant' }),
    record(at(10, 30, 4), 'o1', 50),
    ...turn(at(13, 0, 0)),
    ev(at(13, 0, 3), 'response_item', { type: 'message', role: 'assistant' }),
    record(at(13, 0, 4), 'o2', 20),
  ]);
  mkdirSync(critics, { recursive: true });
  writeFileSync(join(critics, 'ACME-10.codex.json'), JSON.stringify({ sessionId: OLD, rounds: { brief: 2 } }));
  writeFileSync(join(critics, 'ACME-12.claude.same.json'), JSON.stringify({ sessionId: SAME, rounds: { brief: 1 } }));
  // C1 is bound in bindings.jsonl too, and a broken or foreign file is skipped.
  writeFileSync(join(critics, 'ACME-1.codex.json'), JSON.stringify({ sessionId: C1, rounds: { brief: 2 } }));
  writeFileSync(join(critics, 'ACME-11.claude.json'), '{ not json');
  writeFileSync(join(critics, 'notes.txt'), 'x');

  const runFolder = join(f.s.root, 'run');
  mkdirSync(runFolder, { recursive: true });
  writeFileSync(
    join(runFolder, '.run.json'),
    JSON.stringify({ deploys: [{ at: at(14), status: 'SUCCEED' }, { at: at(15), status: 'UPDATE_ROLLBACK_COMPLETE' }, { at: at(16), status: 'FAILED' }] }),
  );

  write(join(f.store, 'bindings.jsonl'), [
    { ticket: 'ACME-1', tool: 'codex', session: C1 },
    { ticket: 'ACME-2', tool: 'codex', session: C2 },
    { ticket: 'ACME-1', tool: 'claude', session: K },
  ]);
  return { ...f, runFolder, ledger };
}

test('a bound critic counts preflight and review responses across resume, independent of binding usage', (t) => {
  const { claude, store, collect } = base(t);
  const session = 'synthetic-critic';
  write(join(claude, 'neutral', `${session}.jsonl`), [
    user(at(10, 0, 0)),
    reply(at(10, 0, 5), 'preflight1', 1),
    user(at(10, 0, 6)),
    reply(at(10, 0, 10), 'review1', 2),
    reply(at(10, 0, 11), 'review1', 2),
    user(at(13, 0, 0)),
    reply(at(13, 0, 5), 'preflight2', 4),
    user(at(13, 0, 6)),
    reply(at(13, 0, 10), 'review2', 8),
  ]);
  // The new critic's bindings carry the subject of each round. The old shape is covered by the fixture.
  write(join(store, 'bindings.jsonl'), [
    { at: at(10, 0, 11), ticket: 'ACME-1', tool: 'claude', session, subject: 'brief', round: 1, usage: cu(2) },
    { at: at(13, 0, 10), ticket: 'ACME-1', tool: 'claude', session, subject: 'plan', round: 1, usage: cu(8) },
  ]);
  const l = collect('ACME-1');
  assert.deepEqual(l.brief['Claude Code, claude-test'], claudeTotal(3));
  assert.deepEqual(l.implementation['Claude Code, claude-test'], claudeTotal(12));
});

test('a fresh session counts its first response, and a repeated response once', (t) => {
  const { collect } = fixture(t);
  assert.deepEqual(collect('ACME-1').brief['Claude Code, claude-test'], claudeTotal(sum(1, 2, 1000)));
});

test('a two ticket session splits at the switching response, and a subagent keeps its start ticket', (t) => {
  const { collect } = fixture(t);
  assert.deepEqual(collect('ACME-1').implementation['Claude Code, claude-test'], claudeTotal(sum(4, 32, 64)));
  assert.deepEqual(collect('ACME-2').implementation['Claude Code, claude-test'], claudeTotal(sum(8, 16)));
});

test('interleaved critics count for their own tickets, and Codex responses match the thread total', (t) => {
  const { collect } = fixture(t);
  const one = collect('ACME-1');
  assert.deepEqual(one.brief['Codex, gpt-test'], codexTotal(7));
  assert.equal(one.brief['Codex, gpt-test'].total, xu(7).total_tokens);
  assert.deepEqual(collect('ACME-2').brief['Codex, gpt-test'], codexTotal(100));
});

test('a critic state file binds a session that predates bindings, and a session bound twice counts once', (t) => {
  const { collect } = fixture(t);
  const l = collect('ACME-10');
  assert.deepEqual(l.brief['Codex, gpt-test'], codexTotal(50));
  assert.deepEqual(l.implementation['Codex, gpt-test'], codexTotal(20));
  assert.deepEqual(collect('ACME-1').brief['Codex, gpt-test'], codexTotal(7));
  assert.deepEqual(collect('ACME-12').brief['Claude Code, claude-test'], claudeTotal(300));
});

test('responses after Done are left out', (t) => {
  const { collect } = fixture(t);
  assert.equal(collect('ACME-2').implementation['Claude Code, claude-test'].total, claudeTotal(24).total);
});

test('work before the first marker is unattributed, and a mention is not a marker', (t) => {
  const { collect } = fixture(t);
  const l = collect('ACME-3');
  assert.deepEqual(l.unattributed['Claude Code, claude-test'], claudeTotal(128));
  assert.deepEqual(l.brief['Claude Code, claude-test'], claudeTotal(256));
});

test('running totals give each response its step, and a Codex child thread follows its lead', (t) => {
  const { collect } = fixture(t);
  const l = collect('ACME-4');
  assert.deepEqual(l.brief['Codex, gpt-test'], codexTotal(12));
  assert.deepEqual(l.implementation['Codex, gpt-test'], codexTotal(3));
});

test('a rerun replaces the rollup entry, and the comment carries the timeline and Raised list', (t) => {
  const { collect, ledger, s } = fixture(t);
  collect('ACME-1', '--write', '--raised', 'acme-9');
  const l = collect('ACME-1', '--write', '--raised', 'acme-9', '--shipped', at(15));
  collect('ACME-2', '--write');
  const all = JSON.parse(readFileSync(join(s.bollplank, 'ledger', 'rollup.json'), 'utf8')).tickets;
  assert.deepEqual(Object.keys(all).sort(), ['ACME-1', 'ACME-2']);
  assert.equal(all['ACME-1'].shipped, at(15));
  assert.deepEqual(l.raised, ['ACME-9']);
  assert.deepEqual(l.mixedSessions, []);
  const md = ledger('collect', 'ACME-1', '--created', at(9), '--approved', at(12), '--done', at(20), '--raised', 'ACME-9', '--markdown').stdout;
  assert.match(md, /^Ticket ledger\nCollected: \d{4}-\d\d-\d\d \d\d:\d\d by bollplank ledger, from \d+ session files\n/);
  assert.match(md, /^Workflow: Bollplank \S+, build (\d+|unknown)( plus unmerged commits)?(, with uncommitted changes)?$/m);
  assert.match(md, /the brief took 3 h 0 min/);
  assert.match(md, /\*\*Raised:\*\* ACME-9/);
  assert.match(md, /\| \*\*All models\*\* \|/);
  assert.doesNotMatch(md, /Sessions that used both kits/);
  assert.match(ledger('rollup').stdout, /\| ACME-1 \| 2026-01-01 \|/);
  const json = ledger('rollup', '--json').json;
  assert.equal(json.ok, true);
  assert.deepEqual(Object.keys(json.tickets).sort(), ['ACME-1', 'ACME-2']);
});

test('a marker on a later line counts, and copied Codex records count once', (t) => {
  const { collect } = fixture(t);
  assert.deepEqual(collect('ACME-6').implementation['Codex, gpt-test'], codexTotal(35));
});

test('a turn without usage does not pull the next turn back in time', (t) => {
  const { collect } = fixture(t);
  const l = collect('ACME-7');
  assert.deepEqual(l.brief['Codex, gpt-test'], codexTotal(1));
  assert.deepEqual(l.implementation['Codex, gpt-test'], codexTotal(10));
});

test('only a successful deploy counts as shipped', (t) => {
  const { collect, runFolder } = fixture(t);
  assert.equal(collect('ACME-1', '--run', runFolder).shipped, at(14));
  // succeeded is what run deploy records now. It counts, and the older values keep counting.
  writeFileSync(join(runFolder, '.run.json'), JSON.stringify({ deploys: [{ at: at(14), status: 'SUCCEED' }, { at: at(17), status: 'succeeded' }, { at: at(18), status: 'timeout' }, { at: at(19), status: 'running' }] }));
  assert.equal(collect('ACME-1', '--run', runFolder).shipped, at(17));
});

test('a run record or rollup store that is not valid JSON is a corrupt failure naming the file', (t) => {
  const { ledger, runFolder, s } = fixture(t);
  writeFileSync(join(runFolder, '.run.json'), '{"deploys":');
  let r = ledger('collect', 'ACME-1', '--created', at(9), '--approved', at(12), '--done', at(20), '--run', runFolder);
  assert.equal(r.status, 1, r.stdout);
  assert.equal(r.json.failure, 'corrupt');
  assert.equal(r.json.file, join(runFolder, '.run.json'));
  const store = join(s.bollplank, 'ledger');
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, 'rollup.json'), 'not json');
  r = ledger('rollup', '--json');
  assert.equal(r.json.failure, 'corrupt');
  assert.equal(r.json.file, join(store, 'rollup.json'));
});

test('mark never fails, even when the store cannot be written', (t) => {
  const { s } = base(t);
  const blocked = join(s.root, 'blocked');
  writeFileSync(blocked, 'a file, not a folder');
  const r = s.run(['ledger', 'mark', 'ACME-8'], { BOLLPLANK_HOME: join(blocked, 'x') });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'now working on ACME-8');
});

test('mark prints the ticket and keeps an audit line', (t) => {
  const { ledger, s } = base(t);
  assert.equal(ledger('mark', 'acme-5').stdout.trim(), 'now working on ACME-5');
  const marks = readFileSync(join(s.bollplank, 'ledger', 'marks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(marks.at(-1).ticket, 'ACME-5');
});

test('a wrong call is a usage error', (t) => {
  const { ledger } = base(t);
  for (const args of [[], ['mark'], ['mark', 'acme'], ['collect', 'ACME-1'], ['collect', 'ACME-1', '--created', 'soon', '--approved', at(12), '--done', at(20)], ['collect', 'ACME-1', '--created'], ['rollup', 'ACME-1']]) {
    const r = ledger(...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.equal(r.json?.failure, 'usage', args.join(' '));
  }
});

test('a session marked by both kits splits at the switching response and is reported', (t) => {
  const { claude, codex, collect, ledger } = base(t);
  const M = '01a00000-0000-7000-8000-00000000000a';
  // Claude: agent-workflow's marker first, then Bollplank's through a path.
  write(join(claude, 'proj', 'mixed.jsonl'), [
    user(at(10, 0, 0)),
    reply(at(10, 0, 5), 'm1', 1, bash('aw-ledger mark ACME-1')),
    user(at(10, 0, 6)),
    reply(at(10, 0, 10), 'm2', 2),
    user(at(13, 0, 0)),
    reply(at(13, 0, 5), 'm3', 4, bash('~/.local/bin/bollplank ledger mark ACME-2')),
    user(at(13, 0, 6)),
    reply(at(13, 0, 10), 'm4', 8),
  ]);
  // A session with only Bollplank's marker is not reported.
  write(join(claude, 'proj', 'single.jsonl'), [user(at(10, 30, 0)), reply(at(10, 30, 5), 'b1', 16, bash('bollplank ledger mark ACME-1'))]);
  // Codex: both kits in call arguments.
  write(join(codex, `rollout-2026-01-01T10-00-00-${M}.jsonl`), [
    meta(at(10, 0, 0), M, 'cli'),
    ...turn(at(10, 0, 0)),
    shellCall(at(10, 0, 3), 'aw-ledger mark ACME-1'),
    record(at(10, 0, 4), 'x1', 1),
    ...turn(at(13, 0, 0)),
    execCall(at(13, 0, 3), 'cd /x && bollplank ledger mark ACME-2'),
    record(at(13, 0, 4), 'x2', 2),
  ]);

  const one = collect('ACME-1');
  const two = collect('ACME-2');
  assert.deepEqual(one.brief['Claude Code, claude-test'], claudeTotal(sum(1, 2, 16)));
  assert.equal(one.implementation['Claude Code, claude-test'], undefined);
  assert.deepEqual(two.implementation['Claude Code, claude-test'], claudeTotal(sum(4, 8)));
  assert.deepEqual(one.brief['Codex, gpt-test'], codexTotal(1));
  assert.deepEqual(two.implementation['Codex, gpt-test'], codexTotal(2));

  const reported = (l) => l.mixedSessions.map((m) => `${m.tool}:${m.session}`).sort();
  assert.deepEqual(reported(one), ['claude:mixed', `codex:${M}`]);
  assert.deepEqual(reported(two), ['claude:mixed', `codex:${M}`]);
  assert.match(one.mixedSessions.find((m) => m.tool === 'claude').file, /mixed\.jsonl$/);

  const md = ledger('collect', 'ACME-2', '--created', at(9), '--approved', at(12), '--done', at(20), '--markdown').stdout;
  assert.match(md, /\*\*Sessions that used both kits\*\*/);
  assert.match(md, /^\* Claude Code session mixed, in mixed\.jsonl$/m);
  assert.match(md, new RegExp(`^\\* Codex session ${M}, in rollout-.*\\.jsonl$`, 'm'));
  assert.doesNotMatch(md, /single/);
});
