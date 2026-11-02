// bollplank doctor, against fake claude and codex programs on a PATH that holds nothing else.
// No test runs a real client or makes a model call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, fakesSkip, bin } from './helpers.mjs';

// The same fakes as test/init.test.mjs.
// What a Linear tool returns for the synthetic workspace. FAKE_STATUSES replaces the status list,
// FAKE_PROJECTS the project list, and FAKE_REPLY_STATUSES the statuses the model claims in its reply.
// FAKE_GLOBEX_STATUSES adds the team GLOBEX with those statuses and the project Portal.
const TEAMS = `
const statuses = (process.env.FAKE_STATUSES || 'Backlog,Draft,Ready,In Progress,Acceptance,Done').split(',');
const globex = process.env.FAKE_GLOBEX_STATUSES ? process.env.FAKE_GLOBEX_STATUSES.split(',') : null;
const TEAMS_TEXT = JSON.stringify({ teams: [{ id: 't1', key: 'ACME', name: 'Acme', states: statuses.map((name) => ({ name })), projects: (process.env.FAKE_PROJECTS || 'Shop,Widgets').split(',').map((name) => ({ name })) }, ...(globex ? [{ id: 't2', key: 'GLOBEX', name: 'Globex', states: globex.map((name) => ({ name })), projects: [{ name: 'Portal' }] }] : [])] });
const REPLY = JSON.stringify({ teams: [{ key: 'ACME', name: process.env.FAKE_REPLY_NAME || 'Acme', statuses: process.env.FAKE_REPLY_STATUSES ? process.env.FAKE_REPLY_STATUSES.split(',') : process.env.FAKE_REPLY_LOWER ? statuses.map((s) => s.toLowerCase()) : statuses, projects: ['Shop', 'Widgets'] }, { key: 'GLOBEX', name: 'Globex', statuses: globex ?? ['Todo'], projects: globex ? ['Portal'] : [] }] });
`;

// FAKE_LINEAR: none (no Linear tool), real (a real tool call), claimed (a reply with no call),
// error (the call fails). After `mcp add` the fake has a server named linear that works.
const FAKE_CLAUDE = `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const state = process.env.FAKE_STATE;
const log = (x) => fs.appendFileSync(path.join(state, 'calls.jsonl'), JSON.stringify({ tool: 'claude', args, ...x }) + '\\n');
log({});
const added = fs.existsSync(path.join(state, 'claude-linear-added'));
const linear = added ? 'added' : process.env.FAKE_LINEAR_CLAUDE || process.env.FAKE_LINEAR || 'none';
${TEAMS}
if (args[0] === '--version') { console.log('2.1.312 (Claude Code)'); process.exit(0); }
if (args[0] === 'auth') {
  const auth = process.env.FAKE_CLAUDE_AUTH || 'subscription';
  const s = auth === 'subscription' ? { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'pro' } : auth === 'key' ? { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' } : { loggedIn: false };
  console.log(JSON.stringify(s));
  process.exit(0);
}
if (args[0] === 'mcp') {
  if (args[1] === 'list') {
    console.log('Checking MCP server health...\\n');
    if (linear === 'added') console.log('linear: ' + 'https://mcp.linear.app/mcp (HTTP) - ✓ Connected');
    else if (linear !== 'none') console.log('claude.ai Linear: https://mcp.linear.app/mcp - ✓ Connected');
    console.log('acme-files: npx acme-files - ✓ Connected');
    process.exit(0);
  }
  if (args[1] === 'get') process.exit(added ? 0 : 1);
  if (args[1] === 'add') { fs.writeFileSync(path.join(state, 'claude-linear-added'), ''); process.exit(0); }
  if (args[1] === 'login') process.exit(0);
  process.exit(2);
}
const at = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const emit = (e) => process.stdout.write(JSON.stringify(e) + '\\n');
if (args.includes('--input-format')) {
  const rl = require('node:readline').createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    log({ prompt: JSON.parse(line).message.content });
    const text = process.env.FAKE_CRITIC === 'malformed' ? 'Looks fine to me.' : 'Critique of ACME-0 health check v1\\nVerdict: Approve\\nNo material points.';
    emit({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: at('--session-id'), modelUsage: { 'claude-acme': {} } });
  });
} else {
  let input = '';
  process.stdin.on('data', (d) => (input += d));
  process.stdin.on('end', () => {
    log({ prompt: input });
    const server = linear === 'added' ? 'linear' : 'claude_ai_Linear';
    emit({ type: 'system', subtype: 'init' });
    if (linear === 'real' || linear === 'added' || linear === 'error') {
      emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'mcp__' + server + '__list_teams', input: {} }] } });
      const tool = 'mcp__' + server + '__list_teams';
      const permitted = (at('--allowedTools') || '').split(',').some((r) => (r.endsWith('*') ? tool.startsWith(r.slice(0, -1)) : r === tool || r === 'mcp__' + server));
      const failed = linear === 'error' || !permitted;
      emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: failed, content: failed ? (permitted ? 'Linear answered 401' : 'Permission denied') : [{ type: 'text', text: TEAMS_TEXT }] }] } });
    }
    emit({ type: 'result', subtype: 'success', is_error: false, result: linear === 'none' ? '{"error":"no Linear tool"}' : REPLY });
  });
}
`;

const FAKE_CODEX = `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const state = process.env.FAKE_STATE;
const log = (x) => fs.appendFileSync(path.join(state, 'calls.jsonl'), JSON.stringify({ tool: 'codex', args, ...x }) + '\\n');
log({});
const added = fs.existsSync(path.join(state, 'codex-linear-added'));
const linear = added ? 'added' : process.env.FAKE_LINEAR_CODEX || process.env.FAKE_LINEAR || 'none';
// A configured server named linear, unless Linear is missing or reaches Codex only as a connector.
const servers = [...(['none', 'connector'].includes(linear) ? [] : ['linear']), 'acme_files'];
const off = (n) => args.includes('mcp_servers.' + n + '.enabled=false');
const allowed = (n) => { const a = args.find((x) => x.startsWith('mcp_servers.' + n + '.enabled_tools=')); return a ? JSON.parse(a.slice(a.indexOf('=') + 1)) : null; };
${TEAMS}
if (args[0] === '--version') { console.log('codex-cli 0.166.0-alpha.5.1'); process.exit(0); }
if (args[0] === 'login' && args[1] === 'status') {
  const auth = process.env.FAKE_CODEX_AUTH || 'chatgpt';
  process.stderr.write(auth === 'chatgpt' ? 'Logged in using ChatGPT\\n' : auth === 'key' ? 'Logged in using an API key - sk-acme***\\n' : 'Not logged in\\n');
  process.exit(auth === 'out' ? 1 : 0);
}
if (args[0] === 'mcp') {
  // The critic and the probe list the configured servers to switch them off, and read back the
  // tools a kept server offers.
  if (args[1] === 'list') { console.log(JSON.stringify(servers.map((name) => ({ name, enabled: !off(name) })))); process.exit(0); }
  if (args[1] === 'get') {
    if (!servers.includes(args[2])) process.exit(1);
    console.log(JSON.stringify({ name: args[2], enabled: !off(args[2]), enabled_tools: allowed(args[2]), disabled_tools: null }));
    process.exit(0);
  }
  if (args[1] === 'add') { fs.writeFileSync(path.join(state, 'codex-linear-added'), ''); process.exit(0); }
  if (args[1] === 'login') process.exit(0);
  process.exit(2);
}
if (args[0] !== 'exec') process.exit(2);
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  log({ prompt: input });
  const emit = (e) => process.stdout.write(JSON.stringify(e) + '\\n');
  emit({ type: 'thread.started', thread_id: 'thread-acme' });
  emit({ type: 'turn.started' });
  if (!input.includes('Bollplank setup check')) {
    const text = process.env.FAKE_CRITIC === 'malformed' ? 'Looks fine to me.' : 'Critique of ACME-0 health check v1\\nVerdict: Approve\\nNo material points.';
    emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } });
    emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
    return;
  }
  // The connector answers only while apps are on. The server offers a tool only when it is allowed.
  const connector = linear === 'connector' && !args.includes('apps');
  if (['real', 'added', 'error', 'slack'].includes(linear) || connector) {
    const server = connector ? 'codex_apps' : 'linear';
    const tool = connector ? 'linear_list_teams' : 'list_teams';
    const offered = connector || (!off('linear') && (allowed('linear') ?? [tool]).includes(tool));
    const failed = linear === 'error' || !offered;
    emit({ type: 'item.started', item: { id: 'item_1', type: 'mcp_tool_call', server, tool, arguments: {}, status: 'in_progress' } });
    emit({ type: 'item.completed', item: { id: 'item_1', type: 'mcp_tool_call', server, tool, arguments: {}, result: failed ? null : { content: [{ type: 'text', text: TEAMS_TEXT }] }, error: failed ? { message: offered ? 'Linear answered 401' : 'unknown tool' } : null, status: failed ? 'failed' : 'completed' } });
    if (linear === 'slack') emit({ type: 'item.completed', item: { id: 'item_3', type: 'mcp_tool_call', server: 'acme_slack', tool: 'send_message', arguments: {}, result: { content: [] }, status: 'completed' } });
  }
  emit({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: linear === 'none' ? '{"error":"no Linear tool"}' : REPLY } });
  emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
});
`;

function box(t, { clients = ['claude', 'codex'], linear = 'real', onPath = true } = {}) {
  const s = sandbox();
  t.after(s.clean);
  const state = join(s.root, 'state');
  mkdirSync(state);
  if (clients.includes('claude')) s.fake('claude', FAKE_CLAUDE);
  if (clients.includes('codex')) s.fake('codex', FAKE_CODEX);
  if (onPath) symlinkSync(bin, join(s.fakes, 'bollplank'));
  const env = { FAKE_STATE: state, FAKE_LINEAR: linear };
  const run = (args, extra = {}) => s.run(args, { ...env, ...extra });
  // A healthy install: a valid config and links made by init.
  const install = (answers = {}) => {
    const file = join(s.root, 'answers.json');
    writeFileSync(file, JSON.stringify({ approver: 'Ada', addProject: false, team: 'ACME', project: 'Shop', ...answers }));
    const r = run(['init', '--answers', file, '--offline', '--json']);
    assert.equal(r.status, 0, r.stdout);
  };
  const doctor = (args = ['--json'], extra) => run(['doctor', ...args], extra);
  // A project with no board of its own, so it falls back to the top level team and statuses.
  const fallBack = () => {
    const file = join(s.bollplank, 'config.json');
    const config = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...config, projects: { 'acme-shop': { source: s.root, tickets: join(s.root, 'tickets'), repos: { 'acme-api': { github: 'acme/acme-api', checks: ['checks'] } } } } }));
  };
  return { s, run, install, doctor, fallBack };
}

const byId = (r) => Object.fromEntries(r.json.checks.map((c) => [c.id, c]));

test('doctor passes on a healthy sandbox with --offline and skips the model calls', { skip: fakesSkip }, (t) => {
  const b = box(t);
  b.install();
  const r = b.doctor(['--json', '--offline']);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.ok, true);
  const c = byId(r);
  for (const id of ['node', 'path', 'config', 'links', 'skills.claude', 'skills.codex', 'client.claude', 'client.codex', 'signin.claude', 'signin.codex', 'version.claude', 'version.codex', 'lock']) assert.equal(c[id]?.ok, true, id);
  for (const id of ['linear.claude', 'linear.codex', 'critic.claude', 'critic.codex']) assert.equal(c[id].skipped, true, id);
  for (const check of r.json.checks) for (const k of ['ok', 'detail', 'fix']) assert.ok(k in check, `${check.id} has ${k}`);
  assert.match(c.lock.detail, /^free/);
  const human = b.doctor(['--offline']);
  assert.equal(human.status, 0);
  assert.match(human.stdout, /^Bollplank doctor$/m);
  assert.match(human.stdout, /skip  Linear from Claude Code: skipped with --offline/);
});

test('doctor runs a Linear read and a critic dry run per configured critic when online', { skip: fakesSkip }, (t) => {
  const b = box(t);
  b.install();
  const r = b.doctor();
  assert.equal(r.status, 0, r.stdout);
  const c = byId(r);
  for (const id of ['linear.claude', 'linear.codex', 'linear', 'critic.claude', 'critic.codex']) assert.equal(c[id].ok, true, id);
  const bad = b.doctor(['--json'], { FAKE_CRITIC: 'malformed', FAKE_LINEAR: 'claimed' });
  assert.equal(bad.status, 1);
  const d = byId(bad);
  assert.equal(d['critic.claude'].ok, false);
  assert.match(d['critic.claude'].detail, /not in the critique format/);
  assert.equal(d.linear.ok, false);
  assert.match(d['linear.codex'].fix, /codex mcp add linear --url https:\/\/mcp\.linear\.app\/mcp/);
});

test('doctor fails a missing board status and a client that cannot read Linear, each with a fix', { skip: fakesSkip }, (t) => {
  const b = box(t);
  b.install();
  b.fallBack();
  // Both clients read Linear and see every name in the config.
  let c = byId(b.doctor());
  for (const id of ['board.team.ACME', 'board.project.ACME.Shop', 'board.status.ACME.draft', 'board.status.ACME.acceptance', 'board.status.ACME.done']) assert.equal(c[id]?.ok, true, id);
  // The team has no Acceptance status.
  let r = b.doctor(['--json'], { FAKE_STATUSES: 'Draft,Ready,In Progress,Done' });
  assert.equal(r.status, 1, r.stdout);
  c = byId(r);
  assert.equal(c['board.status.ACME.acceptance'].ok, false);
  assert.equal(c['board.status.ACME.acceptance'].required, true);
  assert.match(c['board.status.ACME.acceptance'].detail, /ACME has no status named "Acceptance" that Claude Code or Codex can read/);
  assert.match(c['board.status.ACME.acceptance'].fix, /Settings, then Teams, then ACME, then Workflow\. Under Started, add a status named "Acceptance"\. Or set board\.statuses\.acceptance/);
  assert.doesNotMatch(c['board.status.ACME.acceptance'].detail, /spells it/);
  assert.equal(c['board.status.ACME.done'].ok, true);
  // Codex cannot read Linear while Claude Code can. Either may lead, so it fails.
  r = b.doctor(['--json'], { FAKE_LINEAR_CODEX: 'error' });
  assert.equal(r.status, 1, r.stdout);
  c = byId(r);
  assert.equal(c['linear.claude'].ok, true);
  assert.equal(c['linear.codex'].ok, false);
  assert.equal(c['linear.codex'].required, true);
  assert.match(c['linear.codex'].fix, /codex mcp add linear --url/);
  assert.equal(c.linear.ok, false);
  assert.match(c.linear.detail, /Codex could not read Linear/);
  // The board is still checked against the client that reads it.
  assert.equal(c['board.team.ACME'].ok, true);
  // A configured team or project that Linear does not have fails as well.
  const file = join(b.s.bollplank, 'config.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...config, board: { ...config.board, project: 'Gadgets' } }));
  c = byId(b.doctor());
  assert.equal(c['board.project.ACME.Gadgets'].ok, false);
  assert.match(c['board.project.ACME.Gadgets'].fix, /Create the project Gadgets in ACME in Linear, or set board\.project/);
  writeFileSync(file, JSON.stringify({ ...config, board: { ...config.board, team: 'GLOBEX' } }));
  c = byId(b.doctor());
  assert.equal(c['board.team.GLOBEX'].ok, false);
  assert.equal(c['board.status.GLOBEX.done'], undefined);
});

test('doctor checks each project against its own team and statuses, and names the key to fix', { skip: fakesSkip }, (t) => {
  const b = box(t);
  b.install();
  const file = join(b.s.bollplank, 'config.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  const project = (board) => ({ source: b.s.root, tickets: join(b.s.root, 'tickets'), repos: { 'acme-api': { github: 'acme/acme-api', checks: ['checks'] } }, board });
  // acme-shop uses the board's team and statuses. globex-portal has its own team and mapping, and
  // takes the board's name for done.
  writeFileSync(file, JSON.stringify({ ...config, projects: { 'acme-shop': project({ project: 'Shop' }), 'globex-portal': project({ team: 'GLOBEX', project: 'Portal', statuses: { draft: 'Backlog', ready: 'Todo', acceptance: 'In Review' } }) } }));
  const globex = 'Backlog,Todo,In Progress,In Review,Done,Canceled';
  let r = b.doctor(['--json'], { FAKE_GLOBEX_STATUSES: globex });
  assert.equal(r.status, 0, r.stdout);
  let c = byId(r);
  for (const id of ['board.team.ACME', 'board.project.ACME.Shop', 'board.status.ACME.acceptance', 'board.team.GLOBEX', 'board.project.GLOBEX.Portal', 'board.status.GLOBEX.acceptance', 'board.status.GLOBEX.ready', 'board.status.GLOBEX.done']) assert.equal(c[id]?.ok, true, id);
  assert.equal(c['board.status.GLOBEX.acceptance'].detail, 'GLOBEX has the status "In Review"');
  // GLOBEX loses In Review. The fix names the project's own key.
  r = b.doctor(['--json'], { FAKE_GLOBEX_STATUSES: 'Backlog,Todo,In Progress,Done,Canceled' });
  assert.equal(r.status, 1, r.stdout);
  c = byId(r);
  assert.equal(c['board.status.GLOBEX.acceptance'].ok, false);
  assert.match(c['board.status.GLOBEX.acceptance'].fix, /Under Started, add a status named "In Review"\. Or set projects\.globex-portal\.board\.statuses\.acceptance in the config to a status that exists\.$/);
  assert.equal(c['board.status.ACME.acceptance'].ok, true);
  // GLOBEX has no Done. That name comes from the top level, but the top level board is ACME, whose
  // Done is fine. So the fix names the project's own key, never the shared board.statuses.done.
  r = b.doctor(['--json'], { FAKE_GLOBEX_STATUSES: 'Backlog,Todo,In Progress,In Review,Shipped' });
  c = byId(r);
  assert.equal(c['board.status.GLOBEX.done'].ok, false);
  assert.match(c['board.status.GLOBEX.done'].fix, /Or set projects\.globex-portal\.board\.statuses\.done in the config/);
  assert.doesNotMatch(c['board.status.GLOBEX.done'].fix, /Or set board\.statuses/);
  assert.equal(c['board.status.ACME.done'].ok, true);
  // A suggested name a new Linear team lacks says so.
  r = b.doctor(['--json'], { FAKE_STATUSES: 'Backlog,Todo,In Progress,Done,Canceled', FAKE_GLOBEX_STATUSES: globex });
  c = byId(r);
  assert.match(c['board.status.ACME.acceptance'].fix, /A new Linear team has only Backlog, Todo, In Progress, Done, Canceled, so a status named "Acceptance" is added by hand\.$/);
});

test('the top level statuses are required only when a project falls back to one of them', { skip: fakesSkip }, (t) => {
  const b = box(t);
  b.install();
  const file = join(b.s.bollplank, 'config.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  const own = { draft: 'Draft', ready: 'Ready', inProgress: 'In Progress', acceptance: 'In Review', done: 'Done' };
  const project = (board) => ({ source: b.s.root, tickets: join(b.s.root, 'tickets'), repos: { 'acme-api': { github: 'acme/acme-api', checks: ['checks'] } }, ...(board ? { board } : {}) });
  const statuses = 'Backlog,Draft,Ready,In Progress,In Review,Done';
  // No project at all, and then one that maps all five itself: a missing top level name warns.
  for (const projects of [{}, { 'acme-shop': project({ statuses: own }) }]) {
    writeFileSync(file, JSON.stringify({ ...config, projects }));
    const r = b.doctor(['--json'], { FAKE_STATUSES: statuses });
    assert.equal(r.status, 0, r.stdout);
    const c = byId(r)['board.status.ACME.acceptance.Acceptance'] ?? byId(r)['board.status.ACME.acceptance'];
    assert.equal(c.ok, false);
    assert.equal(c.required, false);
  }
  // A project that falls back to even one top level name makes the whole mapping required.
  writeFileSync(file, JSON.stringify({ ...config, projects: { 'acme-shop': project({ statuses: { ...own, done: undefined } }) } }));
  const r = b.doctor(['--json'], { FAKE_STATUSES: statuses });
  assert.equal(r.status, 1, r.stdout);
  const c = byId(r)['board.status.ACME.acceptance.Acceptance'];
  assert.equal(c.ok, false);
  assert.equal(c.required, true);
});

test('doctor compares the board names exactly and names Linear\'s spelling when only the case differs', { skip: fakesSkip }, (t) => {
  const b = box(t);
  b.install();
  const file = join(b.s.bollplank, 'config.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...config, board: { ...config.board, team: 'acme', project: 'shop', statuses: { ...config.board.statuses, acceptance: 'acceptance', ready: 'Queued' } } }));
  const r = b.doctor();
  assert.equal(r.status, 1, r.stdout);
  const c = byId(r);
  const acceptance = c['board.status.acme.acceptance'];
  assert.equal(acceptance.ok, false);
  assert.equal(acceptance.detail, 'acme has no status named "acceptance" that Claude Code or Codex can read. Linear spells it "Acceptance"');
  assert.equal(acceptance.fix, 'Set board.statuses.acceptance in the config to "Acceptance", exactly as Linear spells it.');
  // A status that Linear does not have in any case gets the steps to add it.
  const ready = c['board.status.acme.ready'];
  assert.equal(ready.ok, false);
  assert.equal(ready.detail, 'acme has no status named "Queued" that Claude Code or Codex can read');
  assert.match(ready.fix, /Settings, then Teams, then acme, then Workflow\. Under Unstarted, add a status named "Queued"\. Or set board\.statuses\.ready in the config to a status that exists\./);
  assert.equal(c['board.status.acme.done'].ok, true);
  // The team and the project too.
  assert.equal(c['board.team.acme'].ok, false);
  assert.match(c['board.team.acme'].detail, /acme is not a team Claude Code or Codex can read in Linear\. Linear spells it ACME$/);
  assert.equal(c['board.team.acme'].fix, 'Set board.team in the config to ACME, exactly as Linear spells it.');
  assert.equal(c['board.project.acme.shop'].ok, false);
  assert.equal(c['board.project.acme.shop'].fix, 'Set board.project in the config to Shop, exactly as Linear spells it.');
});

test('doctor goes by the tool\'s spelling even when the model writes a status in another case', { skip: fakesSkip }, (t) => {
  const b = box(t);
  b.install();
  b.fallBack();
  const file = join(b.s.bollplank, 'config.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...config, board: { ...config.board, statuses: { ...config.board.statuses, acceptance: 'acceptance' } } }));
  // The tool returns "Acceptance", the model writes "acceptance", and the config says "acceptance".
  const r = b.doctor(['--json'], { FAKE_REPLY_LOWER: '1' });
  assert.equal(r.status, 1, r.stdout);
  const acceptance = byId(r)['board.status.ACME.acceptance'];
  assert.equal(acceptance.ok, false);
  assert.equal(acceptance.fix, 'Set board.statuses.acceptance in the config to "Acceptance", exactly as Linear spells it.');
});

test('doctor takes a status only from a whole status name, never from a project or a longer status', { skip: fakesSkip }, (t) => {
  const b = box(t);
  b.install();
  const file = join(b.s.bollplank, 'config.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...config, board: { ...config.board, statuses: { ...config.board.statuses, acceptance: 'acceptance' } } }));
  // A project named "User acceptance" does not make "acceptance" a status. Linear's own spelling wins.
  const project = byId(b.doctor(['--json'], { FAKE_REPLY_LOWER: '1', FAKE_PROJECTS: 'Shop,Widgets,User acceptance' }))['board.status.ACME.acceptance'];
  assert.equal(project.ok, false);
  assert.equal(project.fix, 'Set board.statuses.acceptance in the config to "Acceptance", exactly as Linear spells it.');
  // "Awaiting Acceptance" does not make "Acceptance" a status, even when the model claims it.
  writeFileSync(file, JSON.stringify({ ...config, board: { ...config.board, statuses: { ...config.board.statuses, acceptance: 'Acceptance' } } }));
  const longer = byId(b.doctor(['--json'], { FAKE_STATUSES: 'Backlog,Draft,Ready,In Progress,Awaiting Acceptance,Done', FAKE_REPLY_STATUSES: 'Backlog,Draft,Ready,In Progress,Acceptance,Done' }))['board.status.ACME.acceptance'];
  assert.equal(longer.ok, false);
  assert.match(longer.fix, /add a status named "Acceptance"/);
});

test('doctor never passes a team made of one team\'s key and another\'s name', { skip: fakesSkip }, (t) => {
  const b = box(t);
  b.install();
  const file = join(b.s.bollplank, 'config.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...config, board: { ...config.board, team: 'Globex', project: 'Shop' } }));
  // The model pairs the key ACME with the name Globex. Linear's only team here is ACME, named Acme.
  const c = byId(b.doctor(['--json'], { FAKE_REPLY_NAME: 'Globex' }));
  assert.equal(c['board.team.Globex'].ok, false);
  assert.equal(c['board.project.Globex.Shop']?.ok ?? false, false);
});

test('doctor shows a Claude probe stopped by a broad Linear allow rule, with its own fix', { skip: fakesSkip }, (t) => {
  const b = box(t);
  b.install();
  writeFileSync(join(b.s.claude, 'settings.json'), JSON.stringify({ permissions: { allow: ['mcp__claude_ai_Linear__*'] } }));
  const r = b.doctor();
  assert.equal(r.status, 1, r.stdout);
  const c = byId(r)['linear.claude'];
  assert.equal(c.ok, false);
  assert.match(c.detail, /Your Claude Code settings allow Linear tools broadly \(mcp__claude_ai_Linear__\* in .*settings\.json\), so a read only probe cannot be guaranteed\. The Linear probe did not run\./);
  assert.match(c.fix, /^Narrow the Linear allow rule in .*settings\.json, then run `bollplank doctor` again\.$/);
  assert.equal(byId(r)['linear.codex'].ok, true);
});

test('doctor runs a dry run for each critic default a project sets', { skip: fakesSkip }, (t) => {
  const b = box(t);
  b.install();
  const file = join(b.s.bollplank, 'config.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...config, critic: { default: 'codex' }, projects: { 'acme-shop': { source: b.s.root, tickets: join(b.s.root, 'tickets'), repos: { 'acme-api': { github: 'acme/acme-api', checks: ['checks'] } }, critic: { default: 'claude' } } } }));
  const c = byId(b.doctor(['--json', '--offline']));
  assert.equal(c['critic.codex'].skipped, true);
  assert.equal(c['critic.claude'].skipped, true);
  assert.equal(c['client.claude'].required, true);
  assert.equal(c['client.codex'].required, true);
});

test('doctor reports each failure with a fix and exits 1', { skip: fakesSkip }, (t) => {
  const b = box(t, { clients: [], onPath: false });
  const r = b.doctor(['--json', '--offline']);
  assert.equal(r.status, 1);
  assert.equal(r.json.ok, false);
  const c = byId(r);
  for (const id of ['config', 'links', 'client.claude', 'client.codex']) {
    assert.equal(c[id].ok, false, id);
    assert.equal(c[id].required, true, id);
    assert.ok(c[id].fix, `${id} has a fix`);
  }
  assert.match(c.config.fix, /bollplank init/);
  // The command off PATH only warns, with the exact line to add.
  assert.equal(c.path.ok, false);
  assert.equal(c.path.required, false);
  assert.match(c.path.fix, /export PATH="\$HOME\/\.local\/bin:\$PATH"$/);
  assert.match(c.path.detail, /run it as .*\/bin\/bollplank\./);
  const human = b.doctor(['--offline']);
  assert.equal(human.status, 1);
  assert.match(human.stdout, /FAIL  Config: .*\n {8}Fix: Run `bollplank init`\./);
});

test('doctor names a key sign in, a moved link and a held ship lock', { skip: fakesSkip }, (t) => {
  const b = box(t);
  b.install();
  const link = join(b.s.claude, 'skills', 'bollplank-brief');
  unlinkSync(link);
  mkdirSync(link);
  const lock = join(b.s.bollplank, 'ship.lock');
  mkdirSync(lock);
  writeFileSync(join(lock, 'holder.json'), JSON.stringify({ ticket: 'ACME-7', session: 'acme-session', since: new Date(Date.now() - 3 * 60000).toISOString(), pid: 1 }));
  const r = b.doctor(['--json', '--offline'], { FAKE_CODEX_AUTH: 'key' });
  assert.equal(r.status, 1);
  const c = byId(r);
  assert.equal(c['signin.codex'].ok, false);
  assert.match(c['signin.codex'].fix, /codex login/);
  assert.equal(c.links.ok, false);
  assert.match(c.links.detail, /bollplank-brief: no longer a link/);
  assert.equal(c['skills.claude'].ok, false);
  assert.equal(c['skills.claude'].required, true);
  assert.match(c['skills.claude'].fix, new RegExp(`Move ${link.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} away`));
  assert.equal(c['skills.codex'].ok, true);
  assert.match(c.lock.detail, /held by ACME-7, session acme-session, for 3 minutes/);
});

test('doctor checks every kit skill in each client found, not only the recorded links', { skip: fakesSkip }, (t) => {
  const b = box(t);
  b.install();
  // A skill link removed from the client and the record both, so the recorded links still pass.
  const gone = join(b.s.codex, 'skills', 'bollplank-ship');
  unlinkSync(gone);
  const file = join(b.s.bollplank, 'install.json');
  const record = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...record, links: record.links.filter((l) => l.path !== gone) }));
  // And a link to somewhere outside the kit.
  const foreign = join(b.s.claude, 'skills', 'bollplank-accept');
  unlinkSync(foreign);
  mkdirSync(join(b.s.root, 'elsewhere'));
  symlinkSync(join(b.s.root, 'elsewhere'), foreign);
  record.links = record.links.filter((l) => l.path !== gone && l.path !== foreign);
  writeFileSync(file, JSON.stringify(record));
  const r = b.doctor(['--json', '--offline']);
  assert.equal(r.status, 1, r.stdout);
  const c = byId(r);
  assert.equal(c.links.ok, true, c.links.detail);
  assert.equal(c['skills.codex'].ok, false);
  assert.equal(c['skills.codex'].detail, `${gone} is missing`);
  assert.equal(c['skills.codex'].fix, `Run \`bollplank init\` to link ${gone}.`);
  assert.equal(c['skills.claude'].ok, false);
  assert.match(c['skills.claude'].detail, /bollplank-accept is a link to .*elsewhere, which is not this kit/);
  assert.match(c['skills.claude'].fix, /bollplank-accept away, then run `bollplank init`/);
});

test('a corrupt install record fails the links check with the file named, never a crash', { skip: fakesSkip }, (t) => {
  const b = box(t);
  b.install();
  writeFileSync(join(b.s.bollplank, 'install.json'), '{"links": [');
  const r = b.doctor(['--json', '--offline']);
  assert.equal(r.status, 1, r.stdout);
  const c = byId(r);
  assert.equal(c.links.ok, false);
  assert.match(c.links.detail, /install\.json is not valid JSON/);
  // init refuses to rewrite it, so the links it lists are not forgotten.
  const file = join(b.s.root, 'answers.json');
  const init = b.run(['init', '--answers', file, '--offline', '--json']);
  assert.equal(init.json.failure, 'corrupt');
  assert.equal(readFileSync(join(b.s.bollplank, 'install.json'), 'utf8'), '{"links": [');
});

test('a client found only in its app bundle warns with the PATH line', async () => {
  const { clientPathCheck } = await import('../lib/commands/doctor.mjs');
  const c = { name: 'codex', label: 'Codex', bin: '/Applications/Acme.app/Contents/Resources/codex-cli/bin/codex' };
  const off = clientPathCheck(c, null, '/bin/zsh');
  assert.equal(off.ok, false);
  assert.equal(off.required, false);
  assert.match(off.detail, /`codex` is not on PATH/);
  assert.match(off.fix, /~\/\.zshrc.*export PATH="\/Applications\/Acme\.app\/Contents\/Resources\/codex-cli\/bin:\$PATH"/);
  const on = clientPathCheck(c, '/usr/local/bin/codex');
  assert.equal(on.ok, true);
  assert.equal(on.fix, null);
  // fish has its own command, and bash on macOS reads ~/.bash_profile.
  assert.equal(clientPathCheck(c, null, '/opt/acme/bin/fish', 'darwin').fix, 'Run this once in fish, then open a new terminal: fish_add_path /Applications/Acme.app/Contents/Resources/codex-cli/bin');
  assert.match(clientPathCheck(c, null, '/bin/bash', 'darwin').fix, /^Add this line to ~\/\.bash_profile /);
  assert.match(clientPathCheck(c, null, '/bin/bash', 'linux').fix, /^Add this line to ~\/\.bashrc /);
});

test('PATH holds a command only as an executable file, never a folder or a file that cannot run', { skip: fakesSkip }, async (t) => {
  const { findOnPath } = await import('../lib/commands/doctor.mjs');
  const s = sandbox();
  t.after(s.clean);
  const dirs = ['a', 'b', 'c'].map((n) => join(s.root, n));
  for (const d of dirs) mkdirSync(d);
  mkdirSync(join(dirs[0], 'acme-tool'));
  writeFileSync(join(dirs[1], 'acme-tool'), 'not a program\n', { mode: 0o644 });
  writeFileSync(join(dirs[2], 'acme-tool'), '#!/bin/sh\n', { mode: 0o755 });
  const env = { PATH: dirs.join(':') };
  assert.equal(findOnPath('acme-tool', env, 'darwin'), join(dirs[2], 'acme-tool'));
  assert.equal(findOnPath('acme-tool', { PATH: dirs.slice(0, 2).join(':') }, 'darwin'), null);
});
