// bollplank doctor, against fake claude and codex programs on a PATH that holds nothing else.
// No test runs a real client or makes a model call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, fakesSkip, bin } from './helpers.mjs';

// The same fakes as test/init.test.mjs.
// What a Linear tool returns for the synthetic workspace. FAKE_STATUSES replaces the status list.
const TEAMS = `
const statuses = (process.env.FAKE_STATUSES || 'Backlog,Draft,Ready,In Progress,Acceptance,Done').split(',');
const TEAMS_TEXT = JSON.stringify({ teams: [{ id: 't1', key: 'ACME', name: 'Acme', states: statuses.map((name) => ({ name })), projects: [{ name: 'Shop' }, { name: 'Widgets' }] }] });
const REPLY = JSON.stringify({ teams: [{ key: 'ACME', name: 'Acme', statuses, projects: ['Shop', 'Widgets'] }, { key: 'GLOBEX', name: 'Globex', statuses: ['Todo'], projects: [] }] });
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
const linear = added ? 'added' : process.env.FAKE_LINEAR || 'none';
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
      const permitted = (at('--allowedTools') || '').split(',').includes('mcp__' + server);
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
const linear = added ? 'added' : process.env.FAKE_LINEAR || 'none';
${TEAMS}
if (args[0] === '--version') { console.log('codex-cli 0.166.0-alpha.5.1'); process.exit(0); }
if (args[0] === 'login' && args[1] === 'status') {
  const auth = process.env.FAKE_CODEX_AUTH || 'chatgpt';
  process.stderr.write(auth === 'chatgpt' ? 'Logged in using ChatGPT\\n' : auth === 'key' ? 'Logged in using an API key - sk-acme***\\n' : 'Not logged in\\n');
  process.exit(auth === 'out' ? 1 : 0);
}
if (args[0] === 'mcp') {
  if (args[1] === 'get') process.exit(added ? 0 : 1);
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
  if (linear === 'real' || linear === 'added' || linear === 'error') {
    const failed = linear === 'error';
    const server = linear === 'added' ? 'linear' : 'codex_apps';
    emit({ type: 'item.started', item: { id: 'item_1', type: 'mcp_tool_call', server, tool: 'linear_list_teams', arguments: {}, status: 'in_progress' } });
    emit({ type: 'item.completed', item: { id: 'item_1', type: 'mcp_tool_call', server, tool: 'linear_list_teams', arguments: {}, result: failed ? null : { content: [{ type: 'text', text: TEAMS_TEXT }] }, error: failed ? { message: 'Linear answered 401' } : null, status: failed ? 'failed' : 'completed' } });
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
  return { s, run, install, doctor };
}

const byId = (r) => Object.fromEntries(r.json.checks.map((c) => [c.id, c]));

test('doctor passes on a healthy sandbox with --offline and skips the model calls', { skip: fakesSkip }, (t) => {
  const b = box(t);
  b.install();
  const r = b.doctor(['--json', '--offline']);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.ok, true);
  const c = byId(r);
  for (const id of ['node', 'path', 'config', 'links', 'client.claude', 'client.codex', 'signin.claude', 'signin.codex', 'version.claude', 'version.codex', 'lock']) assert.equal(c[id]?.ok, true, id);
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

test('doctor reports each failure with a fix and exits 1', { skip: fakesSkip }, (t) => {
  const b = box(t, { clients: [], onPath: false });
  const r = b.doctor(['--json', '--offline']);
  assert.equal(r.status, 1);
  assert.equal(r.json.ok, false);
  const c = byId(r);
  for (const id of ['path', 'config', 'links', 'client.claude', 'client.codex']) {
    assert.equal(c[id].ok, false, id);
    assert.equal(c[id].required, true, id);
    assert.ok(c[id].fix, `${id} has a fix`);
  }
  assert.match(c.config.fix, /bollplank init/);
  assert.match(c.path.fix, /export PATH/);
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
  assert.match(c.lock.detail, /held by ACME-7, session acme-session, for 3 minutes/);
});
