// bollplank init and the Linear probe, against fake claude, codex and gh programs on a PATH that
// holds nothing else. No test runs a real client, adds a real MCP server or makes a model call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sandbox, fakesSkip, gitRepo, kit } from './helpers.mjs';
import * as claude from '../lib/providers/claude.mjs';
import * as codex from '../lib/providers/codex.mjs';
import { CODEX_LINEAR_READ_TOOLS, isLinearRead, isReadTool, judge, jsonIn, LINEAR_MCP_URL, LINEAR_PROBE_PROMPT, readOnlyLinearTools, serverPart } from '../lib/setup/probe.mjs';
import { githubSlug } from '../lib/commands/init.mjs';

// What a Linear tool returns for the synthetic workspace. FAKE_STATUSES replaces the status list.
// FAKE_GLOBEX_STATUSES adds the team GLOBEX with those statuses and the project Portal.
// FAKE_LATE_PROJECT is a project of ACME from each client's second model call on, as if the person
// created it in between.
const TEAMS = `
const statuses = (process.env.FAKE_STATUSES || 'Backlog,Draft,Ready,In Progress,Acceptance,Done').split(',');
const globex = process.env.FAKE_GLOBEX_STATUSES ? process.env.FAKE_GLOBEX_STATUSES.split(',') : null;
let turns = 0;
if (process.env.FAKE_LATE_PROJECT && ['-p', 'exec'].includes(args[0])) {
  const f = path.join(state, 'turns-' + args[0]);
  turns = (fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0) + 1;
  fs.writeFileSync(f, String(turns));
}
const acmeProjects = ['Shop', 'Widgets', ...(turns >= 2 ? [process.env.FAKE_LATE_PROJECT] : [])];
const TEAMS_TEXT = JSON.stringify({ teams: [{ id: 't1', key: 'ACME', name: 'Acme', states: statuses.map((name) => ({ name })), projects: acmeProjects.map((name) => ({ name })) }, ...(globex ? [{ id: 't2', key: 'GLOBEX', name: 'Globex', states: globex.map((name) => ({ name })), projects: [{ name: 'Portal' }] }] : [])] });
const REPLY = JSON.stringify({ teams: [{ key: 'ACME', name: 'Acme', statuses, projects: acmeProjects }, { key: 'GLOBEX', name: 'Globex', statuses: globex ?? ['Todo'], projects: globex ? ['Portal'] : [] }] });
`;

// FAKE_LINEAR: none (no Linear tool), real (a real tool call), claimed (a reply with no call),
// error (the call fails), write (a read, then a call to the write tool FAKE_WRITE_TOOL, save_issue by
// default). After `mcp add` the fake has a server named linear that works. Tool calls are permitted
// the way Claude Code permits them: a deny rule from --disallowedTools or a settings file wins, then
// an allow rule from --allowedTools or a settings file, with * wildcards, and in dontAsk anything not
// allowed is refused. A tool that runs is logged as ran.
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
    const files = [path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.local.json'), path.join(process.cwd(), '.claude', 'settings.json'), path.join(process.cwd(), '.claude', 'settings.local.json'), process.env.BOLLPLANK_CLAUDE_MANAGED_SETTINGS];
    const saved = (kind) => files.flatMap((f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')).permissions?.[kind] ?? []; } catch { return []; } });
    const glob = (p, s) => {
      const parts = p.split('*');
      if (parts.length === 1) return p === s;
      if (!s.startsWith(parts[0])) return false;
      let i = parts[0].length;
      for (const mid of parts.slice(1, -1)) { const j = s.indexOf(mid, i); if (j < 0) return false; i = j + mid.length; }
      const last = parts.at(-1);
      return s.length - last.length >= i && s.endsWith(last);
    };
    const matches = (rule, tool) => { const r = String(rule).split('(')[0].trim(); return r !== '' && (glob(r, tool) || (!r.includes('*') && tool.startsWith(r + '__'))); };
    const rules = (flag, kind) => [...(at(flag) || '').split(',').filter(Boolean), ...saved(kind)];
    const permitted = (tool) => {
      if (rules('--disallowedTools', 'deny').some((r) => matches(r, tool))) return false;
      if (rules('--allowedTools', 'allow').some((r) => matches(r, tool))) return true;
      // dontAsk refuses anything not allowed. The fake answers no prompt in any other mode either.
      return false;
    };
    emit({ type: 'system', subtype: 'init' });
    if (['real', 'added', 'error', 'write'].includes(linear)) {
      const names = ['list_teams', ...(linear === 'write' ? [process.env.FAKE_WRITE_TOOL || 'save_issue'] : [])];
      names.forEach((name, i) => {
        const tool = 'mcp__' + server + '__' + name;
        const id = 'toolu_' + (i + 1);
        emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: tool, input: {} }] } });
        const ok = permitted(tool);
        if (ok) log({ ran: tool });
        const failed = linear === 'error' || !ok;
        emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: failed, content: failed ? (ok ? 'Linear answered 401' : 'Permission denied') : [{ type: 'text', text: name === 'list_teams' ? TEAMS_TEXT : '{"saved":true}' }] }] } });
      });
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
  if (args[1] === 'list') { console.log(JSON.stringify(servers.map((name) => ({ name, enabled: !off(name), ...(name === "linear" && process.env.FAKE_LINEAR_AUTH ? { auth_status: process.env.FAKE_LINEAR_AUTH } : {}) })))); process.exit(0); }
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

// gh reports one pull request with two checks, and one workflow.
const FAKE_GH = `
const args = process.argv.slice(2);
const out = (v) => { console.log(JSON.stringify(v)); process.exit(0); };
if (args[0] === 'pr' && args[1] === 'list') out([{ number: 7 }]);
if (args[0] === 'pr' && args[1] === 'checks') out([{ name: 'checks' }, { name: 'lint' }, { name: 'checks' }]);
if (args[0] === 'workflow' && args[1] === 'list') out([{ name: 'Deploy' }]);
process.exit(1);
`;

function box(t, { clients = ['claude', 'codex'], linear = 'real' } = {}) {
  const s = sandbox();
  t.after(s.clean);
  const state = join(s.root, 'state');
  mkdirSync(state);
  if (clients.includes('claude')) s.fake('claude', FAKE_CLAUDE);
  if (clients.includes('codex')) s.fake('codex', FAKE_CODEX);
  s.fake('gh', FAKE_GH);
  // A source folder with one repo whose origin is on GitHub and whose default branch is trunk.
  const src = join(s.root, 'code', 'acme');
  const repo = join(src, 'acme-api');
  mkdirSync(repo, { recursive: true });
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...a], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'trunk');
  writeFileSync(join(repo, 'README.md'), 'Acme API\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'start');
  git('remote', 'add', 'origin', 'git@github.com:acme/acme-api.git');
  git('update-ref', 'refs/remotes/origin/trunk', 'HEAD');
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
  mkdirSync(join(src, 'notes'));
  const env = { FAKE_STATE: state, FAKE_LINEAR: linear };
  let n = 0;
  const init = (answers, args = ['--json'], extra = {}) => {
    const file = join(s.root, `answers-${++n}.json`);
    writeFileSync(file, JSON.stringify(answers));
    return s.run(['init', '--answers', file, ...args], { ...env, ...extra });
  };
  const calls = () => (existsSync(join(state, 'calls.jsonl')) ? readFileSync(join(state, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const config = () => JSON.parse(readFileSync(join(s.bollplank, 'config.json'), 'utf8'));
  return { s, state, src, repo, env, init, calls, config };
}

const ANSWERS = { approver: 'Ada', addProject: true, projectName: 'acme-shop', repos: ['acme-api'] };
const withSource = (b, extra = {}) => ({ ...ANSWERS, source: b.src, tickets: join(b.s.root, 'code', 'acme', 'Tickets'), ...extra });
const text = (r) => (r.json?.messages ?? []).join('\n');

test('the probe prompt asks for a Linear tool and JSON, and the URL is Linear\'s remote MCP', () => {
  assert.match(LINEAR_PROBE_PROMPT, /Linear tool/);
  assert.match(LINEAR_PROBE_PROMPT, /JSON/);
  assert.equal(LINEAR_MCP_URL, 'https://mcp.linear.app/mcp');
  assert.deepEqual(jsonIn('```json\n{"teams":[]}\n```'), { teams: [] });
  assert.equal(jsonIn('no json here'), null);
  assert.equal(githubSlug('git@github.com:acme/acme-api.git'), 'acme/acme-api');
  assert.equal(githubSlug('https://github.com/acme/acme-web'), 'acme/acme-web');
  assert.equal(githubSlug('https://example.com/acme/acme-web.git'), null);
});

test('judge passes only on a real Linear tool call and keeps only what the tool returned', () => {
  const reply = JSON.stringify({ teams: [{ key: 'ACME', name: 'Acme', statuses: ['Done', 'Invented'], projects: ['Shop'] }, { key: 'GLOBEX', name: 'Globex' }] });
  const tool = { name: 'mcp__acme_linear__list_teams', ok: true, text: '{"teams":[{"key":"ACME","name":"Acme","states":[{"name":"Done"}],"projects":[{"name":"Shop"}]}]}' };
  const ok = judge('Acme client', [tool], reply);
  assert.equal(ok.ok, true, ok.detail);
  assert.deepEqual(ok.teams, [{ key: 'ACME', name: 'Acme', statuses: ['Done'], projects: ['Shop'] }]);
  assert.equal(judge('Acme client', [], reply).ok, false);
  assert.match(judge('Acme client', [], reply).detail, /no Linear tool call/);
  assert.equal(judge('Acme client', [{ name: 'mcp__acme_files__read', ok: true, text: 'ACME Acme' }], reply).ok, false);
  assert.equal(judge('Acme client', [{ ...tool, ok: false, text: 'Linear answered 401' }], reply).ok, false);
  assert.equal(judge('Acme client', [{ ...tool, text: '{"teams":[]}' }], reply).ok, false);
  assert.match(judge('Acme client', [tool], 'I listed the teams.').detail, /did not reply with the JSON/);
});

test('judge spells every name as the tool returned it, whatever case the model wrote', () => {
  const tool = { name: 'mcp__acme_linear__list_teams', ok: true, text: '{"teams":[{"key":"ACME","name":"Acme","states":[{"name":"Acceptance"},{"name":"In Progress"}],"projects":[{"name":"Shop"}]}]}' };
  const reply = JSON.stringify({ teams: [{ key: 'acme', name: 'ACME', statuses: ['acceptance', 'in progress', 'Acceptance'], projects: ['shop'] }] });
  const r = judge('Acme client', [tool], reply);
  assert.equal(r.ok, true, r.detail);
  assert.deepEqual(r.teams, [{ key: 'ACME', name: 'Acme', statuses: ['Acceptance', 'In Progress'], projects: ['Shop'] }]);
});

test('the probe allows only Linear tools that list, get, search or read, and fails on a write', () => {
  const tools = [
    'mcp__claude_ai_Linear__list_teams',
    'mcp__claude_ai_Linear__get_issue',
    'mcp__claude_ai_Linear__search_documentation',
    'mcp__claude_ai_Linear__save_issue',
    'mcp__claude_ai_Linear__create_comment',
    'mcp__claude_ai_Linear__delete_comment',
    'mcp__linear__listIssueStatuses',
    'mcp__acme_files__read_file',
    'Bash',
  ];
  assert.deepEqual(readOnlyLinearTools(tools), ['mcp__claude_ai_Linear__list_teams', 'mcp__claude_ai_Linear__get_issue', 'mcp__claude_ai_Linear__search_documentation', 'mcp__linear__listIssueStatuses']);
  assert.equal(isReadTool('codex_apps/linear_list_teams'), true);
  assert.equal(isReadTool('codex_apps/linear_save_issue'), false);
  assert.equal(isReadTool('linear/update_issue'), false);
  const reply = JSON.stringify({ teams: [{ key: 'ACME', name: 'Acme' }] });
  const read = { name: 'mcp__linear__list_teams', ok: true, text: '{"teams":[{"key":"ACME","name":"Acme"}]}' };
  assert.equal(judge('Acme client', [read], reply).ok, true);
  const wrote = judge('Acme client', [read, { name: 'mcp__linear__save_issue', ok: true, text: '{}' }], reply);
  assert.equal(wrote.ok, false);
  assert.match(wrote.detail, /called mcp__linear__save_issue, which is not a Linear read\. The probe allows only Linear tools that list, get, search or read\./);
});

test('the probe fails on any call that is not a Linear read, whatever its service', () => {
  const reply = JSON.stringify({ teams: [{ key: 'ACME', name: 'Acme' }] });
  const read = { name: 'mcp__linear__list_teams', ok: true, text: '{"teams":[{"key":"ACME","name":"Acme"}]}' };
  // A valid Linear read and a Slack write in one transcript fail, for both clients' names.
  for (const slack of ['mcp__acme_slack__send_message', 'acme_slack/send_message']) {
    const r = judge('Acme client', [read, { name: slack, ok: true, text: '{}' }], reply);
    assert.equal(r.ok, false);
    assert.deepEqual(r.tools, [slack]);
    assert.match(r.detail, /not a Linear read/);
  }
  // A read verb on a server that is not Linear, a built in tool and a Codex shell command fail too.
  for (const name of ['mcp__acme_files__read_file', 'mcp__acme_slack__linear_list', 'Bash', 'command_execution']) assert.equal(judge('Acme client', [read, { name, ok: true, text: '' }], reply).ok, false, name);
  assert.equal(serverPart('mcp__claude_ai_Linear__list_teams'), 'claude_ai_Linear');
  assert.equal(serverPart('linear/list_teams'), 'linear');
  assert.equal(isLinearRead('linear/list_teams'), true);
  assert.equal(isLinearRead('acme_slack/linear_list'), false);
  assert.ok(CODEX_LINEAR_READ_TOOLS.every((t) => isReadTool(t)));
});

test('the Claude probe passes on a real tool call through a connector and fails on a claimed one', { skip: fakesSkip }, (t) => {
  const b = box(t, { clients: ['claude'] });
  const bin = join(b.s.fakes, 'claude');
  const env = (linear) => ({ ...b.s.env, ...b.env, FAKE_LINEAR: linear });
  const cwd = join(b.s.root, 'neutral');
  const real = claude.probeLinear({ bin, env: env('real'), cwd });
  assert.equal(real.ok, true, real.detail);
  assert.deepEqual(real.tools, ['mcp__claude_ai_Linear__list_teams']);
  assert.deepEqual(real.teams.map((x) => x.key), ['ACME']);
  assert.deepEqual(real.teams[0].statuses, ['Backlog', 'Draft', 'Ready', 'In Progress', 'Acceptance', 'Done']);
  const probe = b.calls().find((c) => c.args[0] === '-p' && c.prompt);
  assert.equal(probe.args[probe.args.indexOf('--allowedTools') + 1], 'mcp__claude_ai_Linear__list*,mcp__claude_ai_Linear__linear_list*,mcp__claude_ai_Linear__get*,mcp__claude_ai_Linear__linear_get*,mcp__claude_ai_Linear__search*,mcp__claude_ai_Linear__linear_search*,mcp__claude_ai_Linear__read*,mcp__claude_ai_Linear__linear_read*');
  assert.equal(probe.args[probe.args.indexOf('--tools') + 1], '');
  assert.ok(probe.args.includes('--no-session-persistence'));
  // Nothing outside the allowed reads can run: no prompt is answered, dontAsk denies the rest, and
  // every other MCP server is denied by name, which wins over an allow rule in the settings.
  assert.equal(probe.args[probe.args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(probe.args[probe.args.indexOf('--permission-prompts') + 1], 'none');
  assert.equal(probe.args.includes('--setting-sources'), false);
  // The other server is denied by name, and every common write verb on the Linear server, with and
  // without a linear prefix, as a second layer.
  const denied = probe.args[probe.args.indexOf('--disallowedTools') + 1].split(',');
  assert.equal(denied[0], 'mcp__acme-files');
  for (const v of claude.WRITE_VERBS) for (const p of ['', 'linear_']) assert.ok(denied.includes(`mcp__claude_ai_Linear__${p}${v}*`), `${p}${v}`);
  assert.equal(denied.some((d) => /__(linear_)?(list|get|search|read)/.test(d)), false);
  assert.equal(probe.args.filter((a) => a === '--disallowedTools').length, 1);
  assert.match(probe.prompt, /Bollplank setup check/);
  const claimed = claude.probeLinear({ bin, env: env('claimed'), cwd });
  assert.equal(claimed.ok, false);
  assert.match(claimed.detail, /no Linear tool call/);
  assert.equal(claude.probeLinear({ bin, env: env('error'), cwd }).ok, false);
  const none = claude.probeLinear({ bin, env: env('none'), cwd });
  assert.equal(none.ok, false);
  assert.match(none.detail, /claude mcp list/);
});

// A settings file with only permissions.allow, at a path relative to the sandbox.
const allowIn = (file, allow) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ permissions: { allow } }));
};

test('a saved allow rule for one Linear write tool is denied by name, and the fake Claude refuses it before it runs', { skip: fakesSkip }, (t) => {
  const b = box(t, { clients: ['claude'] });
  const bin = join(b.s.fakes, 'claude');
  const cwd = join(b.s.root, 'neutral');
  // import_issues starts with no write verb, so only the deny by name stops it. A read rule and a
  // rule for another tool are left alone.
  allowIn(join(b.s.claude, 'settings.json'), ['mcp__claude_ai_Linear__import_issues', 'mcp__claude_ai_Linear__list_teams', 'Bash(npm test)']);
  allowIn(join(cwd, '.claude', 'settings.local.json'), ['mcp__claude_ai_Linear__save_issue']);
  const r = claude.probeLinear({ bin, env: { ...b.s.env, ...b.env, FAKE_LINEAR: 'write', FAKE_WRITE_TOOL: 'import_issues' }, cwd });
  const probe = b.calls().find((c) => c.args[0] === '-p' && c.prompt);
  const denied = probe.args[probe.args.indexOf('--disallowedTools') + 1].split(',');
  assert.ok(denied.includes('mcp__claude_ai_Linear__import_issues'));
  assert.ok(denied.includes('mcp__claude_ai_Linear__save_issue'));
  assert.equal(denied.includes('mcp__claude_ai_Linear__list_teams'), false);
  // The read ran, the write was refused before it ran, and judge fails the probe on the call.
  assert.deepEqual(b.calls().filter((c) => c.ran).map((c) => c.ran), ['mcp__claude_ai_Linear__list_teams']);
  assert.equal(r.ok, false);
  assert.match(r.detail, /called mcp__claude_ai_Linear__import_issues, which is not a Linear read/);
  assert.deepEqual(claude.savedLinearAllows(claude.settingsFiles(b.s.env, cwd), ['claude_ai_Linear']).deny.sort(), ['mcp__claude_ai_Linear__import_issues', 'mcp__claude_ai_Linear__save_issue']);
  // Without the deny by name, the saved rule lets it run, as it would in Claude Code.
  spawnSync(bin, ['-p', '--permission-mode', 'dontAsk', '--allowedTools', 'mcp__claude_ai_Linear__list*'], { env: { ...b.s.env, ...b.env, FAKE_LINEAR: 'write', FAKE_WRITE_TOOL: 'import_issues' }, cwd, input: 'probe' });
  assert.deepEqual(b.calls().filter((c) => c.ran).map((c) => c.ran), ['mcp__claude_ai_Linear__list_teams', 'mcp__claude_ai_Linear__list_teams', 'mcp__claude_ai_Linear__import_issues']);
});

test('a saved whole server or wildcard Linear allow rule stops the Claude probe before any model turn', { skip: fakesSkip }, (t) => {
  const b = box(t, { clients: ['claude'] });
  const bin = join(b.s.fakes, 'claude');
  const cwd = join(b.s.root, 'neutral');
  const managed = b.s.env.BOLLPLANK_CLAUDE_MANAGED_SETTINGS;
  const cases = [
    [join(b.s.claude, 'settings.json'), 'mcp__claude_ai_Linear'],
    [join(b.s.claude, 'settings.local.json'), 'mcp__claude_ai_Linear__*'],
    [join(cwd, '.claude', 'settings.json'), 'mcp__*'],
    [managed, 'mcp__claude_ai_Linear__linear_*(acme-note)'],
    [join(cwd, '.claude', 'settings.local.json'), '*'],
  ];
  for (const [file, rule] of cases) {
    allowIn(file, [rule]);
    const r = claude.probeLinear({ bin, env: { ...b.s.env, ...b.env, FAKE_LINEAR: 'write' }, cwd });
    assert.equal(r.ok, false, rule);
    assert.equal(r.blocked, true, rule);
    assert.match(r.detail, /Your Claude Code settings allow Linear tools broadly \(.+\), so a read only probe cannot be guaranteed\. The Linear probe did not run\. Replace that allow rule with rules that each name one Linear tool, such as mcp__claude_ai_Linear__list_teams, or with read verbs only, such as mcp__claude_ai_Linear__list\*\. Or remove it\./, rule);
    assert.ok(r.detail.includes(`${rule.split('(')[0]} in ${file}`), r.detail);
    assert.equal(r.detail.includes('acme-note'), false);
    assert.match(r.fix, /Narrow the Linear allow rule in .+, then run `bollplank doctor` again\./);
    rmSync(file);
  }
  assert.equal(b.calls().some((c) => c.args[0] === '-p'), false);
  // A file that is not valid JSON fails closed too.
  writeFileSync(managed, '{"permissions":');
  const broken = claude.probeLinear({ bin, env: { ...b.s.env, ...b.env, FAKE_LINEAR: 'real' }, cwd });
  assert.equal(broken.ok, false);
  assert.match(broken.detail, /could not read .*managed-settings\.json/);
  assert.equal(b.calls().some((c) => c.args[0] === '-p'), false);
});

test('saved Linear allow rules limited to reads, or no rules, leave the Claude probe as it was', { skip: fakesSkip }, (t) => {
  const b = box(t, { clients: ['claude'] });
  const bin = join(b.s.fakes, 'claude');
  const cwd = join(b.s.root, 'neutral');
  const env = { ...b.s.env, ...b.env, FAKE_LINEAR: 'real' };
  const plain = claude.probeLinear({ bin, env, cwd });
  assert.equal(plain.ok, true, plain.detail);
  allowIn(join(b.s.claude, 'settings.json'), ['mcp__claude_ai_Linear__list_teams', 'mcp__claude_ai_Linear__get*', 'mcp__*__search*', 'mcp__acme-files', 'Read(~/notes/**)']);
  writeFileSync(b.s.env.BOLLPLANK_CLAUDE_MANAGED_SETTINGS, JSON.stringify({ permissions: { deny: ['WebFetch'] } }));
  const read = claude.probeLinear({ bin, env, cwd });
  assert.equal(read.ok, true, read.detail);
  const [first, second] = b.calls().filter((c) => c.args[0] === '-p' && c.prompt).map((c) => c.args);
  assert.deepEqual(second, first);
  // The reach of single rules on the kept server.
  const reach = (tool) => claude.linearReach(tool, 'claude_ai_Linear');
  assert.equal(reach('mcp__claude_ai_Linear__save_issue'), 'one');
  assert.equal(reach('mcp__claude_ai_Linear__listTeams'), null);
  assert.equal(reach('mcp__claude_ai_Linear__linear_get*'), null);
  for (const broad of ['mcp__claude_ai_Linear', 'mcp__claude_ai_Linear__*', 'mcp__claude*', 'mcp__*', '*', 'mcp__claude_ai_Linear__*_issue', 'mcp__claude_ai_Linear__l*', 'mcp__claude_ai_Linear__s*']) assert.equal(reach(broad), 'broad', broad);
  for (const other of ['mcp__acme-files', 'mcp__acme-files__*', 'mcp__acme*', 'Bash', 'Read']) assert.equal(reach(other), null, other);
});

test('the Codex probe passes on a real MCP tool call event and fails on a claimed one', { skip: fakesSkip }, (t) => {
  const b = box(t, { clients: ['codex'] });
  const bin = join(b.s.fakes, 'codex');
  const env = (linear) => ({ ...b.s.env, ...b.env, FAKE_LINEAR: linear });
  const cwd = join(b.s.root, 'neutral');
  const real = codex.probeLinear({ bin, env: env('real'), cwd });
  assert.equal(real.ok, true, real.detail);
  assert.deepEqual(real.teams.map((x) => x.key), ['ACME']);
  assert.deepEqual(real.tools, ['linear/list_teams']);
  const probe = b.calls().find((c) => c.args[0] === 'exec');
  for (const flag of ['--json', '--ephemeral', '--skip-git-repo-check']) assert.ok(probe.args.includes(flag), flag);
  assert.equal(probe.args[probe.args.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(probe.args.includes('forced_login_method="chatgpt"'));
  // The critic's isolation: connectors and the other tool features off, every other MCP server
  // off, and the Linear server offering only its read tools, confirmed before the turn starts.
  for (const feature of ['apps', 'plugins', 'multi_agent', 'hooks']) assert.ok(probe.args.some((a, i) => a === feature && probe.args[i - 1] === '--disable'), feature);
  assert.ok(probe.args.includes('mcp_servers.acme_files.enabled=false'));
  assert.ok(!probe.args.includes('mcp_servers.linear.enabled=false'));
  assert.ok(probe.args.includes(`mcp_servers.linear.enabled_tools=${JSON.stringify(CODEX_LINEAR_READ_TOOLS)}`));
  const before = b.calls().filter((c) => c.tool === 'codex' && c.args[0] === 'mcp').map((c) => c.args.slice(0, 3).join(' '));
  assert.deepEqual(before, ['mcp list --json', 'mcp list --json', 'mcp get linear', 'mcp list --json']);
  assert.equal(codex.probeLinear({ bin, env: env('claimed'), cwd }).ok, false);
  const failed = codex.probeLinear({ bin, env: env('error'), cwd });
  assert.equal(failed.ok, false);
  assert.match(failed.detail, /401/);
  // A Slack write next to a good Linear read fails the probe.
  const slack = codex.probeLinear({ bin, env: env('slack'), cwd });
  assert.equal(slack.ok, false);
  assert.match(slack.detail, /called acme_slack\/send_message, which is not a Linear read/);
});

test('the Codex probe never reads Linear through a ChatGPT connector and asks for the Linear MCP server', { skip: fakesSkip }, (t) => {
  const b = box(t, { clients: ['codex'] });
  const bin = join(b.s.fakes, 'codex');
  const cwd = join(b.s.root, 'neutral');
  for (const linear of ['connector', 'none']) {
    const r = codex.probeLinear({ bin, env: { ...b.s.env, ...b.env, FAKE_LINEAR: linear }, cwd });
    assert.equal(r.ok, false);
    assert.equal(r.needsServer, true);
    assert.match(r.detail, /Codex has no Linear MCP server switched on\. Linear through a ChatGPT connector cannot be narrowed to read tools/);
  }
  // No model turn ran.
  assert.equal(b.calls().some((c) => c.tool === 'codex' && c.args[0] === 'exec'), false);
});

test('the Codex probe says how to sign in to a Linear server that is signed out, without a model turn', { skip: fakesSkip }, (t) => {
  const b = box(t, { clients: ['codex'] });
  const bin = join(b.s.fakes, 'codex');
  const r = codex.probeLinear({ bin, env: { ...b.s.env, ...b.env, FAKE_LINEAR_AUTH: 'not_logged_in' }, cwd: join(b.s.root, 'neutral') });
  assert.equal(r.ok, false);
  assert.equal(r.needsLogin, true);
  assert.match(r.detail, /not signed in to it\. Run `codex mcp login linear`/);
  assert.equal(b.calls().some((c) => c.tool === 'codex' && c.args[0] === 'exec'), false);
});

test('judge takes names only as whole values from their own fields', () => {
  const text = JSON.stringify({ teams: [{ key: 'ACME', name: 'Acme', states: [{ name: 'Acceptance' }, { name: 'Awaiting Review' }], projects: [{ name: 'Shop' }, { name: 'User acceptance' }] }] });
  const tool = { name: 'mcp__acme_linear__list_teams', ok: true, text };
  // The model writes "acceptance": the status pool has "Acceptance", the project "User acceptance" is no status.
  const lower = judge('Acme client', [tool], JSON.stringify({ teams: [{ key: 'ACME', name: 'Acme', statuses: ['acceptance', 'Review'], projects: ['user acceptance'] }] }));
  assert.equal(lower.ok, true, lower.detail);
  assert.deepEqual(lower.teams[0].statuses, ['Acceptance']);
  assert.deepEqual(lower.teams[0].projects, ['User acceptance']);
  // A status that only appears inside a longer one is dropped.
  const longer = { ...tool, text: JSON.stringify({ teams: [{ key: 'ACME', name: 'Acme', states: [{ name: 'Awaiting Acceptance' }], projects: [] }] }) };
  assert.deepEqual(judge('Acme client', [longer], JSON.stringify({ teams: [{ key: 'ACME', name: 'Acme', statuses: ['Acceptance'] }] })).teams[0].statuses, []);
  // Statuses from a status tool and projects from a project tool, wrapped in a client envelope.
  const states = { name: 'codex_linear/list_issue_statuses', ok: true, text: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify([{ name: 'Acceptance', team: { key: 'ACME' } }, { name: 'Todo', team: { key: 'GLOBEX' } }]) }] }) };
  const teamsOnly = { ...tool, text: JSON.stringify({ teams: [{ key: 'ACME', name: 'Acme' }, { key: 'GLOBEX', name: 'Globex' }] }) };
  const r = judge('Acme client', [teamsOnly, states], JSON.stringify({ teams: [{ key: 'ACME', name: 'Acme', statuses: ['Acceptance', 'Todo'] }] }));
  assert.deepEqual(r.teams[0].statuses, ['Acceptance']);
});

test('judge keeps every name with its own team: by the call\'s arguments, never offered to every team', () => {
  const teamsTool = { name: 'mcp__acme_linear__list_teams', ok: true, text: JSON.stringify({ teams: [{ id: 't1', key: 'ACME', name: 'Acme' }, { id: 't2', key: 'GLOBEX', name: 'Globex' }] }) };
  // A status list with no team field, asked for GLOBEX by its id, belongs to GLOBEX only.
  const globexStates = { name: 'mcp__acme_linear__list_issue_statuses', ok: true, args: { team: 't2' }, text: JSON.stringify([{ name: 'Acceptance' }, { name: 'Todo' }]) };
  const reply = JSON.stringify({ teams: [{ key: 'ACME', name: 'Acme', statuses: ['Acceptance'] }, { key: 'GLOBEX', name: 'Globex', statuses: ['Acceptance', 'Todo'] }] });
  const r = judge('Acme client', [teamsTool, globexStates], reply);
  assert.equal(r.ok, true, r.detail);
  assert.deepEqual(r.teams.find((x) => x.key === 'ACME').statuses, []);
  assert.deepEqual(r.teams.find((x) => x.key === 'GLOBEX').statuses, ['Acceptance', 'Todo']);
  // Codex passes arguments as a JSON string.
  const asString = judge('Acme client', [teamsTool, { ...globexStates, args: JSON.stringify({ teamId: 't2' }) }], reply);
  assert.deepEqual(asString.teams.find((x) => x.key === 'GLOBEX').statuses, ['Acceptance', 'Todo']);
  // With no owner at all, the statuses are dropped for every team.
  const unowned = judge('Acme client', [teamsTool, { ...globexStates, args: null }], reply);
  assert.deepEqual(unowned.teams.map((x) => x.statuses), [[], []]);
  // A key from one team and a name from another lead to no team at all.
  const withProjects = { ...teamsTool, text: JSON.stringify({ teams: [{ key: 'ACME', name: 'Acme', projects: [{ name: 'Shop' }] }, { key: 'GLOBEX', name: 'Globex', projects: [{ name: 'Widgets' }] }] }) };
  const mixed = judge('Acme client', [withProjects], JSON.stringify({ teams: [{ key: 'ACME', name: 'Globex', projects: ['Shop'] }] }));
  assert.equal(mixed.ok, false);
  assert.match(mixed.detail, /no team in its reply came from the tool/);
});

test('addLinearMcp runs the documented add and login commands for each client', { skip: fakesSkip }, (t) => {
  const b = box(t, { linear: 'none' });
  const env = { ...b.s.env, ...b.env };
  const c = claude.addLinearMcp({ bin: join(b.s.fakes, 'claude'), env, url: LINEAR_MCP_URL, stdio: 'ignore' });
  const x = codex.addLinearMcp({ bin: join(b.s.fakes, 'codex'), env, url: LINEAR_MCP_URL, stdio: 'ignore' });
  assert.equal(c.ok, true, c.detail);
  assert.equal(x.ok, true, x.detail);
  const mcp = b.calls().filter((k) => k.args[0] === 'mcp').map((k) => `${k.tool} ${k.args.join(' ')}`);
  assert.deepEqual(mcp, [
    'claude mcp get linear',
    `claude mcp add --transport http --scope user linear ${LINEAR_MCP_URL}`,
    'claude mcp login linear',
    'codex mcp get linear --json',
    `codex mcp add linear --url ${LINEAR_MCP_URL}`,
    'codex mcp login linear',
  ]);
  // A second time the server is there, so it is only signed in to.
  assert.equal(claude.addLinearMcp({ bin: join(b.s.fakes, 'claude'), env, url: LINEAR_MCP_URL, stdio: 'ignore' }).added, false);
});

test('init with answers writes a valid config and links every skill for each client', { skip: fakesSkip }, (t) => {
  const b = box(t);
  const r = b.init(withSource(b));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.written, true);
  const c = b.config();
  assert.equal(c.approver.name, 'Ada');
  assert.equal(c.critic.default, 'other');
  assert.deepEqual(c.board.statuses, { draft: 'Draft', ready: 'Ready', inProgress: 'In Progress', acceptance: 'Acceptance', done: 'Done' });
  const p = c.projects['acme-shop'];
  assert.deepEqual(p.board, { team: 'ACME', project: 'Shop' });
  assert.equal(p.runs, false);
  assert.deepEqual(p.shipOrder, ['acme-api']);
  assert.deepEqual(p.repos['acme-api'], { github: 'acme/acme-api', checks: ['checks', 'lint'], baseBranch: 'trunk', deploy: { kind: 'none' } });
  const skills = readdirSync(join(kit, 'skills')).filter((n) => n.startsWith('bollplank-'));
  assert.ok(skills.length >= 8);
  for (const dir of [b.s.claude, b.s.codex]) {
    for (const n of skills) {
      const link = join(dir, 'skills', n);
      assert.equal(lstatSync(link).isSymbolicLink(), true, link);
      assert.equal(readlinkSync(link), join(kit, 'skills', n));
    }
  }
  const install = JSON.parse(readFileSync(join(b.s.bollplank, 'install.json'), 'utf8'));
  assert.equal(install.links.length, skills.length * 2);
  assert.ok(install.links.every((l) => l.kind === 'skill' && ['claude', 'codex'].includes(l.client)));
  assert.match(text(r), /Claude Code read 1 Linear team/);
  assert.equal(r.json.doctor.checks.some((c) => c.id === 'links' && c.ok), true);
  // Run again with the same answers: nothing to save, and the links are kept.
  const again = b.init(withSource(b, { addProject: false }));
  assert.equal(again.json.written, false);
  assert.match(text(again), /is unchanged/);
  assert.equal(again.json.links.made.length, 0);
  assert.equal(again.json.links.kept.length, skills.length * 2);
});

test('init leaves a file and a foreign link in the skills folders alone and reports them', { skip: fakesSkip }, (t) => {
  const b = box(t);
  const own = join(b.s.claude, 'skills', 'bollplank-brief');
  mkdirSync(own, { recursive: true });
  writeFileSync(join(own, 'SKILL.md'), 'my own skill\n');
  const elsewhere = join(b.s.root, 'elsewhere');
  mkdirSync(elsewhere);
  mkdirSync(join(b.s.codex, 'skills'), { recursive: true });
  symlinkSync(elsewhere, join(b.s.codex, 'skills', 'bollplank-run'));
  const r = b.init(withSource(b));
  assert.equal(r.status, 0, r.stdout);
  assert.equal(readFileSync(join(own, 'SKILL.md'), 'utf8'), 'my own skill\n');
  assert.equal(lstatSync(own).isSymbolicLink(), false);
  assert.equal(readlinkSync(join(b.s.codex, 'skills', 'bollplank-run')), elsewhere);
  assert.deepEqual(r.json.links.skipped.map((s) => s.path).sort(), [own, join(b.s.codex, 'skills', 'bollplank-run')].sort());
  assert.match(text(r), /Left .*bollplank-brief alone\. It is a file or folder that is not a link/);
  assert.match(text(r), /Left .*bollplank-run alone\. It is a link to .*elsewhere, which is not this kit/);
  const install = JSON.parse(readFileSync(join(b.s.bollplank, 'install.json'), 'utf8'));
  assert.equal(install.links.some((l) => l.path === own), false);
});

test('init with a source folder that is itself a repo saves its parent and the repo name, and ticket create works', { skip: fakesSkip }, (t) => {
  const b = box(t);
  const solo = gitRepo(join(b.s.root, 'code', 'solo'), 'acme-solo', 'main');
  solo.commit('README.md', 'Acme solo\n');
  solo.git('push', '-q', '-u', 'origin', 'main');
  const tickets = join(b.s.root, 'code', 'solo', 'Tickets');
  const r = b.init({ approver: 'Ada', addProject: true, source: solo.work, projectName: 'acme-solo', tickets, github: { 'acme-solo': 'acme/acme-solo' }, baseBranch: { 'acme-solo': 'main' } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const p = b.config().projects['acme-solo'];
  assert.equal(p.source, join(b.s.root, 'code', 'solo'));
  assert.deepEqual(Object.keys(p.repos), ['acme-solo']);
  assert.match(text(r), /acme-solo is a git repo, so the project's source folder is .*solo and its repo is acme-solo/);
  const created = b.s.run(['ticket', 'create', 'acme-solo', 'ACME-1', '--slug', 'first', '--change', 'acme-solo']);
  assert.equal(created.status, 0, created.stdout);
  assert.equal(created.json.repos['acme-solo'].baseBranch, 'main');
  assert.ok(existsSync(join(tickets, 'ACME-1', 'acme-solo', 'README.md')));
});

test('init keeps a backup and rewrites nothing without a yes', { skip: fakesSkip }, (t) => {
  const b = box(t);
  assert.equal(b.init(withSource(b)).status, 0);
  const first = readFileSync(join(b.s.bollplank, 'config.json'), 'utf8');
  const no = b.init({ approver: 'Grace', addProject: false, writeConfig: false });
  assert.equal(no.json.written, false);
  assert.equal(readFileSync(join(b.s.bollplank, 'config.json'), 'utf8'), first);
  assert.equal(existsSync(join(b.s.bollplank, 'config.json.bak')), false);
  const yes = b.init({ approver: 'Grace', addProject: false, writeConfig: true });
  assert.equal(yes.json.written, true);
  assert.equal(readFileSync(join(b.s.bollplank, 'config.json.bak'), 'utf8'), first);
  assert.equal(b.config().approver.name, 'Grace');
  // The earlier answers are the defaults: the project and its board stay.
  assert.deepEqual(b.config().projects['acme-shop'].board, { team: 'ACME', project: 'Shop' });
});

test('init never writes a config that does not validate', { skip: fakesSkip }, (t) => {
  const b = box(t);
  const r = b.init(withSource(b, { checks: { 'acme-api': [] }, github: { 'acme-api': 'not a slug' } }));
  assert.equal(r.status, 1);
  assert.equal(r.json.failure, 'config');
  assert.match(r.json.detail, /github: owner\/name/);
  assert.equal(existsSync(join(b.s.bollplank, 'config.json')), false);
});

test('with one client init offers same and explains it', { skip: fakesSkip }, (t) => {
  const b = box(t, { clients: ['claude'] });
  const r = b.init(withSource(b));
  assert.equal(r.status, 0, r.stdout);
  assert.equal(b.config().critic.default, 'same');
  assert.match(text(r), /Only Claude Code works with a subscription here/);
  assert.match(text(r), /separate fresh session of the same model/);
  assert.match(text(r), /weaker than a review by another vendor/);
  assert.equal(r.json.links.made.every((p) => p.startsWith(b.s.claude)), true);
});

test('init never rewrites an existing other without asking', { skip: fakesSkip }, (t) => {
  const b = box(t, { clients: ['claude'] });
  b.s.config({ approver: { name: 'Ada' }, board: { kind: 'linear' }, critic: { default: 'other' }, projects: {} });
  const kept = b.init({ addProject: false, writeConfig: true });
  assert.equal(kept.status, 0, kept.stdout);
  assert.equal(b.config().critic.default, 'other');
  assert.match(text(kept), /Your config says "other"\. It stays that way unless you choose another one now/);
  const changed = b.init({ addProject: false, writeConfig: true, critic: 'same' });
  assert.equal(changed.status, 0);
  assert.equal(b.config().critic.default, 'same');
});

test('init reports a key sign in, does not use it, and warns about key variables', { skip: fakesSkip }, (t) => {
  const b = box(t);
  const r = b.init(withSource(b), ['--json'], { FAKE_CODEX_AUTH: 'key', ANTHROPIC_API_KEY: 'sk-acme-test', OPENAI_API_KEY: 'sk-acme-test' });
  assert.equal(r.status, 0, r.stdout);
  assert.match(text(r), /Codex is signed in with an API key, not a ChatGPT subscription\. Bollplank will not use it this way/);
  assert.match(text(r), /ANTHROPIC_API_KEY, OPENAI_API_KEY\. Bollplank removes them for critic calls/);
  assert.equal(r.stdout.includes('sk-acme'), false);
  assert.deepEqual(r.json.keyVariables, ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
  // Codex was not probed, and every probe ran without the keys.
  assert.equal(b.calls().some((c) => c.tool === 'codex' && c.args[0] === 'exec'), false);
  assert.equal(b.config().critic.default, 'same');
});

test('a failed probe offers the Linear MCP, adds it on a yes, and checks again', { skip: fakesSkip }, (t) => {
  const b = box(t, { linear: 'none' });
  const r = b.init(withSource(b, { addLinear: { claude: true, codex: false } }));
  assert.equal(r.status, 0, r.stdout);
  const mcp = b.calls().filter((c) => c.args[0] === 'mcp' && c.args[1] !== 'list').map((c) => `${c.tool} ${c.args.slice(1, 3).join(' ')}`);
  assert.deepEqual(mcp, ['claude get linear', 'claude add --transport', 'claude login linear']);
  assert.match(text(r), /A browser window opens for the Linear sign in/);
  assert.match(text(r), /Checked again: Claude Code read 1 Linear team/);
  assert.match(text(r), /Left Codex as it is/);
  assert.deepEqual(r.json.linear.claude.ok, true);
  assert.deepEqual(r.json.linear.codex.ok, false);
});

test('init shows a probe stopped by a broad Linear allow rule, and offers no Linear MCP for it', { skip: fakesSkip }, (t) => {
  const b = box(t, { clients: ['claude'] });
  allowIn(join(b.s.claude, 'settings.json'), ['mcp__claude_ai_Linear']);
  const r = b.init(withSource(b, { addLinear: { claude: true } }));
  assert.equal(r.status, 0, r.stdout);
  assert.match(text(r), /Your Claude Code settings allow Linear tools broadly \(mcp__claude_ai_Linear in .*settings\.json\), so a read only probe cannot be guaranteed/);
  assert.match(text(r), /Narrow the Linear allow rule in .*settings\.json, then run `bollplank doctor` again\./);
  assert.equal(r.json.linear.claude.ok, false);
  assert.equal(b.calls().some((c) => c.args[0] === 'mcp' && c.args[1] !== 'list'), false);
  assert.equal(b.calls().some((c) => c.args[0] === '-p' && c.prompt?.includes('Bollplank setup check')), false);
  const check = r.json.doctor.checks.find((c) => c.id === 'linear.claude');
  assert.equal(check.ok, false);
  assert.match(check.detail, /allow Linear tools broadly/);
  assert.match(check.fix, /Narrow the Linear allow rule/);
});

test('init saves the team, project and status names exactly as Linear returned them', { skip: fakesSkip }, (t) => {
  const b = box(t);
  const r = b.init(withSource(b, { team: 'acme', project: 'shop', statuses: { acceptance: 'acceptance', done: 'DONE' } }));
  assert.equal(r.status, 0, r.stdout);
  const c = b.config();
  assert.deepEqual(c.projects['acme-shop'].board, { team: 'ACME', project: 'Shop' });
  assert.equal(c.board.statuses.acceptance, 'Acceptance');
  assert.equal(c.board.statuses.done, 'Done');
  assert.match(text(r), /Saved the team as ACME, the way Linear spells it\./);
  assert.match(text(r), /Saved the project as Shop, the way Linear spells it\./);
  for (const id of ['board.team.ACME', 'board.project.ACME.Shop', 'board.status.ACME.acceptance']) assert.equal(r.json.doctor.checks.find((x) => x.id === id).ok, true, id);
});

test('a missing status is never created: init shows the steps and checks again on a yes', { skip: fakesSkip }, (t) => {
  const b = box(t);
  const r = b.init(withSource(b, { recheck: { acceptance: true } }), ['--json'], { FAKE_STATUSES: 'Draft,Ready,In Progress,Done' });
  assert.equal(r.status, 0, r.stdout);
  assert.match(text(r), /"Acceptance" is not a status of ACME in Linear\. Bollplank never creates one on its own/);
  assert.match(text(r), /Settings, then Teams, then ACME, then Workflow\. Under Started, add a status named "Acceptance"/);
  assert.match(text(r), /Still no status named "Acceptance"/);
  assert.match(text(r), /Kept "Acceptance"\. `bollplank doctor` fails until a status named "Acceptance" exists in ACME/);
  assert.equal(r.json.doctor.checks.find((c) => c.id === 'board.status.ACME.acceptance').ok, false);
  const probes = b.calls().filter((c) => c.args[0] === '-p' && c.prompt).length;
  assert.ok(probes >= 2, `probes ${probes}`);
  assert.equal(b.config().board.statuses.acceptance, 'Acceptance');
});

test('init --offline skips the probe and says so, and init without a terminal or answers refuses', { skip: fakesSkip }, (t) => {
  const b = box(t);
  const r = b.init(withSource(b, { team: 'ACME', project: 'Shop' }), ['--json', '--offline']);
  assert.equal(r.status, 0, r.stdout);
  assert.match(text(r), /Skipped the Linear check, since --offline was given/);
  assert.equal(r.json.linear, 'skipped');
  assert.equal(b.calls().some((c) => c.args[0] === '-p' || c.args[0] === 'exec'), false);
  assert.equal(r.json.doctor.checks.find((c) => c.id === 'critic.claude').skipped, true);
  const tty = b.s.run(['init']);
  assert.equal(tty.status, 2);
  assert.match(tty.json.detail, /needs a terminal/);
});

test('a project in another team maps its own statuses, which init explains, and context and doctor use', { skip: fakesSkip }, (t) => {
  const b = box(t);
  const own = { draft: 'Backlog', ready: 'Todo', acceptance: 'In Review' };
  const r = b.init(withSource(b, { team: 'ACME', project: 'Shop', projects: { 'acme-shop': { team: 'GLOBEX', project: 'Portal', statuses: own } } }), ['--json'], { FAKE_GLOBEX_STATUSES: 'Backlog,Todo,In Progress,In Review,Done,Canceled' });
  assert.equal(r.status, 0, r.stdout);
  const c = b.config();
  assert.deepEqual(c.board.statuses, { draft: 'Draft', ready: 'Ready', inProgress: 'In Progress', acceptance: 'Acceptance', done: 'Done' });
  // The project's own mapping, with the board's names for the states it leaves alone.
  assert.deepEqual(c.projects['acme-shop'].board, { team: 'GLOBEX', project: 'Portal', statuses: { draft: 'Backlog', ready: 'Todo', inProgress: 'In Progress', acceptance: 'In Review', done: 'Done' } });
  const said = text(r);
  assert.match(said, /The statuses of GLOBEX in Linear: Backlog, Todo, In Progress, In Review, Done, Canceled\./);
  assert.match(said, /acceptance: a shipped ticket waiting for your acceptance test\./);
  assert.match(said, /A new Linear team has Backlog, Todo, In Progress, Done, Canceled\. It lacks Draft, Ready, Acceptance/);
  // The answers name no mapping, so own is the default, since the team differs from step 3's.
  assert.match(said, /Linear team GLOBEX, project Portal, with its own statuses\./);
  // Doctor checks each against its own team.
  const check = (id) => r.json.doctor.checks.find((x) => x.id === id);
  for (const id of ['board.team.GLOBEX', 'board.project.GLOBEX.Portal', 'board.status.GLOBEX.acceptance', 'board.status.GLOBEX.ready', 'board.status.ACME.acceptance']) assert.equal(check(id)?.ok, true, id);
  const ctx = b.s.run(['context', 'acme-shop']).json;
  assert.equal(ctx.board.statuses.acceptance, 'In Review');
  assert.equal(ctx.boards['acme-shop'].statuses.ready, 'Todo');
  assert.equal(b.s.run(['context']).json.board.statuses.acceptance, 'Acceptance');
  // The same team keeps the board's statuses by default, and the project saves none of its own.
  const same = b.init(withSource(b, { team: 'ACME', project: 'Shop', addProject: true, replaceProject: true, writeConfig: true, projects: { 'acme-shop': { team: 'ACME', mapping: 'board' } } }));
  assert.equal(same.status, 0, same.stdout);
  assert.deepEqual(b.config().projects['acme-shop'].board, { team: 'ACME', project: 'Shop' });
});

test('a missing Linear project is never created by init: it offers the session sentence, rereads three times, then stops', { skip: fakesSkip }, (t) => {
  const b = box(t);
  const r = b.init(withSource(b, { team: 'ACME', project: 'Gadgets', missingProject: { ACME: { Gadgets: 'session' } } }));
  assert.equal(r.status, 1, r.stdout);
  assert.equal(r.json.failure, 'missing-project');
  assert.match(r.json.detail, /Linear still has no project named Gadgets in ACME after three reads, so init stopped and saved nothing/);
  assert.equal(existsSync(join(b.s.bollplank, 'config.json')), false);
  // One probe per client in step 2, then three reads with the read only probe.
  const probes = b.calls().filter((c) => c.prompt?.includes('Bollplank setup check'));
  assert.equal(probes.filter((c) => c.tool === 'claude').length, 4);
  const said = b.s.run(['init', '--answers', join(b.s.root, 'answers-1.json')], b.env).stdout;
  assert.match(said, /Gadgets is not a project of ACME in Linear\. Bollplank never creates one on its own/);
  assert.match(said, /In your Claude Code or Codex session, type this:\n {2}Create the Linear project Gadgets in team ACME\n/);
  assert.equal(said.match(/Still no project named Gadgets in ACME\./g).length, 3);
});

test('a missing Linear project created in Linear is found on a fresh read, and other picks another', { skip: fakesSkip }, (t) => {
  const b = box(t);
  const r = b.init(withSource(b, { team: 'ACME', project: 'Gadgets', missingProject: { ACME: { Gadgets: 'linear' } } }), ['--json'], { FAKE_LATE_PROJECT: 'Gadgets' });
  assert.equal(r.status, 0, r.stdout);
  assert.match(text(r), /Open Linear, go to Projects, and create a project named "Gadgets" exactly, with ACME as its team\./);
  assert.match(text(r), /Found the project Gadgets in ACME now\./);
  assert.equal(b.config().board.project, 'Gadgets');
  assert.equal(r.json.doctor.checks.find((c) => c.id === 'board.project.ACME.Gadgets').ok, true);
  // Offline, Linear was not read, so the name is kept as typed.
  const other = b.init(withSource(b, { team: 'ACME', project: 'Gizmos', addProject: false, writeConfig: true, missingProject: { ACME: { Gizmos: 'other' } }, otherProject: { ACME: { Gizmos: 'Widgets' } } }), ['--json', '--offline']);
  assert.equal(other.status, 0, other.stdout);
  assert.equal(b.config().board.project, 'Gizmos');
  // Online, other asks for another project.
  const online = b.init(withSource(b, { team: 'ACME', project: 'Gizmos', addProject: false, writeConfig: true, missingProject: { ACME: { Gizmos: 'other' } }, otherProject: { ACME: { Gizmos: 'Widgets' } } }));
  assert.equal(online.status, 0, online.stdout);
  assert.match(text(online), /Gizmos is not a project of ACME in Linear/);
  assert.equal(b.config().board.project, 'Widgets');
});

test('every client call init and doctor make is the read only probe or a critic dry run that allows no write', { skip: fakesSkip }, (t) => {
  const b = box(t);
  assert.equal(b.init(withSource(b)).status, 0);
  assert.equal(b.s.run(['doctor', '--json'], b.env).status, 0);
  const calls = b.calls().filter((c) => !('prompt' in c) && !('ran' in c));
  const turns = b.calls().filter((c) => 'prompt' in c);
  // Calls that read the client itself: its version, sign in and MCP servers. Nothing is added.
  const meta = (c) => c.args[0] === '--version' || (c.tool === 'claude' && c.args[0] === 'auth') || (c.tool === 'codex' && c.args[0] === 'login' && c.args[1] === 'status') || (c.args[0] === 'mcp' && ['list', 'get'].includes(c.args[1]));
  const model = calls.filter((c) => !meta(c));
  assert.ok(model.every((c) => (c.tool === 'claude' ? c.args[0] === '-p' : c.args[0] === 'exec')), JSON.stringify(model.map((c) => c.args.slice(0, 2))));
  // Each model turn is the probe or the dry run, by its prompt.
  for (const c of turns) assert.ok(/Bollplank setup check|Bollplank health check/.test(c.prompt), c.prompt);
  for (const kind of ['setup check', 'health check']) for (const tool of ['claude', 'codex']) assert.ok(turns.some((c) => c.tool === tool && c.prompt.includes(`Bollplank ${kind}`)), `${tool} ${kind}`);
  const value = (args, flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
  // An allow rule is a read when it names a read tool, or a wildcard after a read verb. mcp__x__* is not.
  const readRule = (rule) => /^(Read|Grep|Glob)(\(|$)/.test(rule) || (rule.startsWith('mcp__') && rule.replace(/\*$/, '').split('__').at(-1) !== '' && isReadTool(rule.replace(/\*$/, '')));
  for (const c of model) {
    const a = c.args;
    assert.ok(!a.some((x) => /dangerously|bypass|full-auto|danger-full-access|yolo/i.test(x)), a.join(' '));
    if (c.tool === 'claude') {
      assert.ok(!['bypassPermissions', 'acceptEdits', 'auto'].includes(value(a, '--permission-mode')), a.join(' '));
      for (const rule of (value(a, '--allowedTools') ?? '').split(',').filter(Boolean)) assert.ok(readRule(rule), `claude allows ${rule}`);
      // No built in tool but the read ones.
      for (const tool of (value(a, '--tools') ?? '').split(',').filter(Boolean)) assert.ok(['Read', 'Grep', 'Glob'].includes(tool), `claude offers ${tool}`);
    } else {
      assert.equal(value(a, '--sandbox'), 'read-only', a.join(' '));
      // Every MCP server the fake lists is off, or offers only read tools.
      for (const server of ['linear', 'acme_files']) {
        const tools = a.find((x) => x.startsWith(`mcp_servers.${server}.enabled_tools=`));
        assert.ok(a.includes(`mcp_servers.${server}.enabled=false`) || tools, `codex leaves ${server} on: ${a.join(' ')}`);
        if (tools) for (const tool of JSON.parse(tools.slice(tools.indexOf('=') + 1))) assert.ok(isReadTool(tool), `codex allows ${tool}`);
      }
    }
  }
});
