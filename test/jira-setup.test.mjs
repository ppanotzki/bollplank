// The Jira probe, init and doctor for a Jira board, against fake claude and codex programs on a PATH
// that holds nothing else. The fakes serve a synthetic Linear workspace and a synthetic Atlassian site,
// acme.atlassian.net. No test runs a real client, adds a real MCP server or makes a model call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, fakesSkip } from './helpers.mjs';
import * as claude from '../lib/providers/claude.mjs';
import * as codex from '../lib/providers/codex.mjs';
import { CONFLICTING_INNER, innerCall, isJiraRead, isOfficialUrl, JIRA_PROBE_TOOLS, judgeJira, jiraAddStatusSteps } from '../lib/setup/probe.mjs';

// The synthetic data both fakes serve. FAKE_JIRA_STATUSES replaces the statuses of every Jira
// project, FAKE_JIRA_SPACES the Confluence spaces that can be read, comma separated.
const DATA = `
const statuses = (process.env.FAKE_STATUSES || 'Backlog,Draft,Ready,In Progress,Acceptance,Done').split(',');
const TEAMS_TEXT = JSON.stringify({ teams: [{ id: 't1', key: 'ACME', name: 'Acme', states: statuses.map((name) => ({ name })), projects: [{ name: 'Shop' }, { name: 'Widgets' }] }] });
const REPLY = JSON.stringify({ teams: [{ key: 'ACME', name: 'Acme', statuses, projects: ['Shop', 'Widgets'] }] });
const jiraStatuses = (process.env.FAKE_JIRA_STATUSES || 'Draft,Ready,In Progress,Acceptance,Done').split(',');
const spaces = (process.env.FAKE_JIRA_SPACES ?? 'ACME').split(',').filter(Boolean);
const SITES = [{ id: 'cloud-acme', url: 'https://acme.atlassian.net', name: 'acme', scopes: ['read:jira-work'] }];
const PROJECTS = { values: [{ id: '10001', key: 'ACME', name: 'Acme' }, { id: '10002', key: 'ACM', name: 'Acme Mobile' }], isLast: true };
const listed = (prompt, label) => { const m = prompt.match(new RegExp('^' + label + ': (.*)\\\\.$', 'm')); return m ? m[1].split(', ') : []; };
// The calls a Jira probe makes for its prompt, as [tool, args, result or null for an error].
// FAKE_JIRA_CALLS: good, confluence (an executeRead of a Confluence page as well), write (an
// executeWrite as well) or claimed (no call at all).
const jiraCalls = (prompt) => {
  const mode = process.env.FAKE_JIRA_CALLS || 'good';
  if (mode === 'claimed') return [];
  const calls = [['getAccessibleAtlassianResources', {}, JSON.stringify(SITES)], ['executeRead', { tool: 'listJiraProjects', arguments: { cloudId: 'cloud-acme' } }, JSON.stringify(PROJECTS)]];
  // The second shape of executeRead arguments, toolName and input, for the statuses.
  for (const key of listed(prompt, 'Projects')) calls.push(['executeRead', { toolName: 'listJiraStatuses', input: { cloudId: 'cloud-acme', projectIdOrKey: key } }, JSON.stringify([{ id: '1', name: 'Task', statuses: jiraStatuses.map((name, i) => ({ id: 's' + i, name, statusCategory: { key: 'indeterminate' } })) }])]);
  for (const key of listed(prompt, 'Spaces')) calls.push(['executeRead', { tool: 'getConfluenceSpace', arguments: { cloudId: 'cloud-acme', spaceKey: key } }, spaces.includes(key) ? JSON.stringify({ id: '77', key, name: 'Acme space' }) : null]);
  if (mode === 'confluence') calls.push(['executeRead', { tool: 'getConfluencePage', arguments: { cloudId: 'cloud-acme', pageId: '1' } }, '{"title":"Release notes"}']);
  if (mode === 'write') calls.push(['executeWrite', { tool: 'createJiraIssue', arguments: { cloudId: 'cloud-acme' } }, '{"key":"ACME-9"}']);
  return calls;
};
const jiraReply = (prompt) => JSON.stringify({ sites: [{ site: 'acme.atlassian.net', cloudId: 'cloud-acme', projects: [{ key: 'ACME', id: '10001', statuses: [...jiraStatuses, 'Invented'] }, { key: 'ACM', id: '10002', statuses: jiraStatuses }, { key: 'GLOBEX', id: '999' }] }, { site: 'globex.atlassian.net', cloudId: 'cloud-globex' }], spaces: listed(prompt, 'Spaces').map((key) => ({ key, cloudId: 'cloud-acme' })) });
// The URL the Atlassian server has, by FAKE_JIRA: real (v2), v1, connector (a claude.ai connector
// at v1), impostor (a server named atlassian at another URL) or none.
const jiraUrl = (mode) => ({ real: 'https://mcp.atlassian.com/v2/mcp', v1: 'https://mcp.atlassian.com/v1/mcp', connector: 'https://mcp.atlassian.com/v1/mcp', impostor: 'https://mcp.acme.example/mcp' })[mode] ?? null;
`;

// FAKE_LINEAR: real or none. FAKE_JIRA as above. After `mcp add` the fake has that server and it
// works. Tool calls are permitted the way Claude Code permits them: a deny rule wins, then an allow
// rule, with * wildcards, and in dontAsk anything not allowed is refused.
const FAKE_CLAUDE = `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const state = process.env.FAKE_STATE;
const log = (x) => fs.appendFileSync(path.join(state, 'calls.jsonl'), JSON.stringify({ tool: 'claude', args, ...x }) + '\\n');
log({});
${DATA}
const linearAdded = fs.existsSync(path.join(state, 'claude-linear-added'));
const jiraAdded = fs.existsSync(path.join(state, 'claude-atlassian-added'));
const linear = linearAdded ? 'added' : process.env.FAKE_LINEAR || 'none';
const jira = jiraAdded ? 'real' : process.env.FAKE_JIRA || 'none';
if (args[0] === '--version') { console.log('2.1.312 (Claude Code)'); process.exit(0); }
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'pro' })); process.exit(0); }
if (args[0] === 'mcp') {
  if (args[1] === 'list') {
    console.log('Checking MCP server health...\\n');
    if (linear === 'added') console.log('linear: https://mcp.linear.app/mcp (HTTP) - ✓ Connected');
    else if (linear !== 'none') console.log('claude.ai Linear: https://mcp.linear.app/mcp - ✓ Connected');
    if (jira === 'connector') console.log('claude.ai Atlassian: ' + jiraUrl(jira) + ' - ✓ Connected');
    else if (jiraUrl(jira)) console.log('atlassian: ' + jiraUrl(jira) + ' (HTTP) - ✓ Connected');
    console.log('acme-files: npx acme-files - ✓ Connected');
    process.exit(0);
  }
  if (args[1] === 'get') {
    if (args[2] === 'atlassian' && (jiraAdded || ['real', 'v1', 'impostor'].includes(jira))) { console.log('atlassian:\\n  Type: http\\n  URL: ' + jiraUrl(jira)); process.exit(0); }
    process.exit(args[2] === 'linear' && linearAdded ? 0 : 1);
  }
  if (args[1] === 'add') { fs.writeFileSync(path.join(state, 'claude-' + args[args.length - 2] + '-added'), ''); process.exit(0); }
  if (args[1] === 'login') process.exit(0);
  process.exit(2);
}
const at = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const emit = (e) => process.stdout.write(JSON.stringify(e) + '\\n');
if (args.includes('--input-format')) {
  const rl = require('node:readline').createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    log({ prompt: JSON.parse(line).message.content });
    emit({ type: 'result', subtype: 'success', is_error: false, result: 'Critique of ACME-0 health check v1\\nVerdict: Approve\\nNo material points.', session_id: at('--session-id'), modelUsage: { 'claude-acme': {} } });
  });
} else {
  let input = '';
  process.stdin.on('data', (d) => (input += d));
  process.stdin.on('end', () => {
    log({ prompt: input });
    const glob = (p, s) => new RegExp('^' + p.split('*').map((x) => x.replace(/[.+?^\${}()|[\\]\\\\]/g, '\\\\$&')).join('.*') + '$').test(s);
    const matches = (rule, tool) => rule !== '' && (glob(rule, tool) || (!rule.includes('*') && tool.startsWith(rule + '__')));
    const permitted = (tool) => !(at('--disallowedTools') || '').split(',').some((r) => matches(r, tool)) && (at('--allowedTools') || '').split(',').some((r) => matches(r, tool));
    emit({ type: 'system', subtype: 'init' });
    const isJira = input.includes('Atlassian tools');
    const server = isJira ? (jira === 'connector' ? 'claude_ai_Atlassian' : 'atlassian') : linear === 'added' ? 'linear' : 'claude_ai_Linear';
    const calls = isJira ? (jira === 'none' ? [] : jiraCalls(input)) : linear === 'none' ? [] : [['list_teams', {}, TEAMS_TEXT]];
    calls.forEach(([name, input, text], i) => {
      const tool = 'mcp__' + server + '__' + name;
      const id = 'toolu_' + (i + 1);
      emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: tool, input }] } });
      const ok = permitted(tool);
      if (ok) log({ ran: tool, input });
      const failed = !ok || text === null;
      emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: failed, content: failed ? (ok ? 'Not found' : 'Permission denied') : [{ type: 'text', text }] }] } });
    });
    const none = isJira ? jira === 'none' : linear === 'none';
    emit({ type: 'result', subtype: 'success', is_error: false, result: none ? '{"error":"no tool"}' : isJira ? jiraReply(input) : REPLY });
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
${DATA}
const linearAdded = fs.existsSync(path.join(state, 'codex-linear-added'));
const jiraAdded = fs.existsSync(path.join(state, 'codex-atlassian-added'));
const linear = linearAdded ? 'added' : process.env.FAKE_LINEAR || 'none';
const jira = jiraAdded ? 'real' : process.env.FAKE_JIRA || 'none';
const servers = [...(linear === 'none' ? [] : [{ name: 'linear', transport: { type: 'streamable_http', url: 'https://mcp.linear.app/mcp' } }]), ...(jiraUrl(jira) && jira !== 'connector' ? [{ name: 'atlassian', transport: { type: 'streamable_http', url: jiraUrl(jira) } }] : []), { name: 'acme_files', transport: { type: 'stdio', command: 'npx' } }];
const off = (n) => args.includes('mcp_servers.' + n + '.enabled=false');
const allowed = (n) => { const a = args.find((x) => x.startsWith('mcp_servers.' + n + '.enabled_tools=')); return a ? JSON.parse(a.slice(a.indexOf('=') + 1)) : null; };
if (args[0] === '--version') { console.log('codex-cli 0.166.0-alpha.5.1'); process.exit(0); }
if (args[0] === 'login' && args[1] === 'status') { process.stderr.write('Logged in using ChatGPT\\n'); process.exit(0); }
if (args[0] === 'mcp') {
  if (args[1] === 'list') { console.log(JSON.stringify(servers.map((s) => ({ ...s, enabled: !off(s.name) })))); process.exit(0); }
  if (args[1] === 'get') {
    const s = servers.find((x) => x.name === args[2]);
    if (!s) process.exit(1);
    console.log(JSON.stringify({ ...s, enabled: !off(s.name), enabled_tools: allowed(s.name), disabled_tools: null }));
    process.exit(0);
  }
  if (args[1] === 'add') { fs.writeFileSync(path.join(state, 'codex-' + args[2] + '-added'), ''); process.exit(0); }
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
  if (!input.includes('Bollplank setup check')) {
    emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'Critique of ACME-0 health check v1\\nVerdict: Approve\\nNo material points.' } });
    emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
    return;
  }
  const isJira = input.includes('Atlassian tools');
  const server = isJira ? 'atlassian' : 'linear';
  const live = servers.some((s) => s.name === server);
  const calls = !live ? [] : isJira ? jiraCalls(input) : [['list_teams', {}, TEAMS_TEXT]];
  calls.forEach(([tool, a, text], i) => {
    const offered = !off(server) && (allowed(server) ?? [tool]).includes(tool);
    const failed = !offered || text === null;
    // Codex reports the arguments as a JSON string.
    const item = { id: 'item_' + (i + 1), type: 'mcp_tool_call', server, tool, arguments: JSON.stringify(a) };
    if (offered) log({ ran: server + '/' + tool, input: a });
    emit({ type: 'item.started', item: { ...item, status: 'in_progress' } });
    emit({ type: 'item.completed', item: { ...item, result: failed ? null : { content: [{ type: 'text', text }] }, error: failed ? { message: offered ? 'Not found' : 'unknown tool' } : null, status: failed ? 'failed' : 'completed' } });
  });
  emit({ type: 'item.completed', item: { id: 'item_r', type: 'agent_message', text: !live ? '{"error":"no tool"}' : isJira ? jiraReply(input) : REPLY } });
  emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
});
`;

function box(t, { linear = 'real', jira = 'real' } = {}) {
  const s = sandbox();
  t.after(s.clean);
  const state = join(s.root, 'state');
  mkdirSync(state);
  s.fake('claude', FAKE_CLAUDE);
  s.fake('codex', FAKE_CODEX);
  s.fake('gh', 'process.exit(1);');
  const src = join(s.root, 'code', 'acme');
  const repo = join(src, 'acme-api');
  mkdirSync(repo, { recursive: true });
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...a], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), 'Acme API\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'start');
  git('remote', 'add', 'origin', 'git@github.com:acme/acme-api.git');
  const env = { FAKE_STATE: state, FAKE_LINEAR: linear, FAKE_JIRA: jira };
  let n = 0;
  const init = (answers, args = ['--json'], extra = {}) => {
    const file = join(s.root, `answers-${++n}.json`);
    writeFileSync(file, JSON.stringify(answers));
    return s.run(['init', '--answers', file, ...args], { ...env, ...extra });
  };
  const calls = () => (existsSync(join(state, 'calls.jsonl')) ? readFileSync(join(state, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const config = () => JSON.parse(readFileSync(join(s.bollplank, 'config.json'), 'utf8'));
  const probeEnv = (extra = {}) => ({ ...s.env, ...env, ...extra });
  return { s, state, src, env, init, calls, config, probeEnv, cwd: join(s.root, 'neutral') };
}

const withSource = (b, extra = {}) => ({ approver: 'Ada', addProject: true, projectName: 'acme-shop', source: b.src, tickets: join(b.s.root, 'code', 'acme', 'Tickets'), ...extra });
const text = (r) => (r.json?.messages ?? []).join('\n');
const byId = (r) => Object.fromEntries(r.json.checks.map((c) => [c.id, c]));
const SITE = 'acme.atlassian.net';
const FIVE = { draft: 'Draft', ready: 'Ready', inProgress: 'In Progress', acceptance: 'Acceptance', done: 'Done' };

test('a Jira read is only one of the named reads, through executeRead in either argument shape, on an official server', () => {
  const ctx = { servers: ['atlassian'] };
  assert.equal(isOfficialUrl('jira', 'https://mcp.atlassian.com/v2/mcp'), true);
  assert.equal(isOfficialUrl('jira', 'https://MCP.atlassian.com/v1/mcp/'), true);
  for (const url of ['https://mcp.atlassian.com/v3/mcp', 'http://mcp.atlassian.com/v2/mcp', 'https://acme@mcp.atlassian.com/v2/mcp', 'https://mcp.atlassian.com.acme.example/v2/mcp', 'https://mcp.linear.app/mcp', null]) assert.equal(isOfficialUrl('jira', url), false, url);
  assert.deepEqual(innerCall({ tool: 'listJiraStatuses', arguments: { cloudId: 'c' } }), { tool: 'listJiraStatuses', args: { cloudId: 'c' } });
  assert.deepEqual(innerCall(JSON.stringify({ toolName: 'listJiraProjects', input: { cloudId: 'c' } })), { tool: 'listJiraProjects', args: { cloudId: 'c' } });
  const call = (name, args) => isJiraRead({ name, args }, ctx);
  for (const t of ['getAccessibleAtlassianResources', 'atlassianUserInfo', 'getJiraIssue']) assert.equal(call(`mcp__atlassian__${t}`, {}), true, t);
  for (const t of ['listJiraProjects', 'listJiraStatuses', 'getJiraIssue']) assert.equal(call('atlassian/executeRead', { tool: t, arguments: {} }), true, t);
  // A Confluence read through executeRead fails, unless a space is configured and it is the space.
  assert.equal(call('mcp__atlassian__executeRead', { tool: 'getConfluenceSpace', arguments: {} }), false);
  assert.equal(isJiraRead({ name: 'mcp__atlassian__executeRead', args: { tool: 'getConfluenceSpace' } }, { ...ctx, space: true }), true);
  assert.equal(isJiraRead({ name: 'mcp__atlassian__executeRead', args: { tool: 'getConfluencePage' } }, { ...ctx, space: true }), false);
  // Writes, discover, an executeRead with no inner tool, and the same tool on another server fail.
  for (const [name, args] of [['mcp__atlassian__executeWrite', { tool: 'createJiraIssue' }], ['mcp__atlassian__executeDestructive', { tool: 'deleteJiraIssue' }], ['mcp__atlassian__discover', {}], ['mcp__atlassian__createJiraIssue', {}], ['mcp__atlassian__addOrEditJiraIssueComment', {}], ['mcp__atlassian__updateConfluenceContent', {}], ['mcp__atlassian__executeRead', {}], ['mcp__atlassian__searchJiraIssuesUsingJql', {}], ['mcp__acme_jira__getJiraIssue', {}], ['atlassian/getJiraIssue/acme_connector', {}]]) assert.equal(call(name, args), false, name);
});

test('judgeJira keeps only the sites, projects, ids, statuses and spaces the tools returned', () => {
  const ctx = { servers: ['atlassian'], space: true };
  const calls = [
    { name: 'mcp__atlassian__getAccessibleAtlassianResources', ok: true, args: {}, text: JSON.stringify([{ id: 'cloud-acme', url: 'https://acme.atlassian.net', name: 'acme' }]) },
    { name: 'mcp__atlassian__executeRead', ok: true, args: { tool: 'listJiraProjects', arguments: { cloudId: 'cloud-acme' } }, text: JSON.stringify({ values: [{ id: '10001', key: 'ACME', name: 'Acme' }] }) },
    { name: 'mcp__atlassian__executeRead', ok: true, args: { tool: 'listJiraStatuses', arguments: { cloudId: 'cloud-acme', projectIdOrKey: 'ACME' } }, text: JSON.stringify([{ name: 'Task', statuses: [{ name: 'Acceptance', statusCategory: { key: 'indeterminate' } }] }]) },
    { name: 'mcp__atlassian__executeRead', ok: true, args: { tool: 'getConfluenceSpace', arguments: { cloudId: 'cloud-acme', spaceKey: 'ACME' } }, text: JSON.stringify({ id: '77', key: 'ACME', name: 'Acme space' }) },
  ];
  const reply = JSON.stringify({ sites: [{ site: 'https://ACME.atlassian.net/', cloudId: 'cloud-acme', projects: [{ key: 'acme', statuses: ['acceptance', 'Task', 'Invented'] }, { key: 'GLOBEX' }] }, { site: 'globex.atlassian.net' }], spaces: [{ key: 'ACME' }, { key: 'OTHER' }] });
  const r = judgeJira('Acme client', calls, reply, ctx);
  assert.equal(r.ok, true, r.detail);
  // The issue type Task is not a status, and the model's own names are dropped.
  assert.deepEqual(r.sites, [{ site: 'acme.atlassian.net', cloudId: 'cloud-acme', projects: [{ key: 'ACME', id: '10001', name: 'Acme', statuses: ['Acceptance'] }], spaces: ['ACME'] }]);
  assert.match(judgeJira('Acme client', [], reply, ctx).detail, /made no Jira tool call/);
  // A project list whose call named no cloudId belongs to no site.
  const unowned = judgeJira('Acme client', [calls[0], { ...calls[1], args: { tool: 'listJiraProjects', arguments: {} } }], reply, ctx);
  assert.deepEqual(unowned.sites[0].projects, []);
  const wrote = judgeJira('Acme client', [...calls, { name: 'mcp__atlassian__executeWrite', ok: true, args: { tool: 'createJiraIssue' }, text: '{}' }], reply, ctx);
  assert.equal(wrote.ok, false);
  assert.match(wrote.detail, /called mcp__atlassian__executeWrite of createJiraIssue, which is not a Jira read of the official Atlassian server/);
});

test('the Claude Jira probe allows the named reads only, denies the writes by name and passes on real calls', { skip: fakesSkip }, (t) => {
  const b = box(t, { linear: 'none' });
  const bin = join(b.s.fakes, 'claude');
  const r = claude.probeBoard('jira', { bin, env: b.probeEnv(), cwd: b.cwd, target: { projects: ['ACME'], spaces: ['ACME'] } });
  assert.equal(r.ok, true, r.detail);
  assert.deepEqual(r.sites, [{ site: SITE, cloudId: 'cloud-acme', projects: [{ key: 'ACME', id: '10001', name: 'Acme', statuses: ['Draft', 'Ready', 'In Progress', 'Acceptance', 'Done'] }, { key: 'ACM', id: '10002', name: 'Acme Mobile', statuses: [] }], spaces: ['ACME'] }]);
  const probe = b.calls().find((c) => c.args[0] === '-p' && c.prompt);
  assert.match(probe.prompt, /^Projects: ACME\.$/m);
  assert.equal(probe.args[probe.args.indexOf('--allowedTools') + 1], JIRA_PROBE_TOOLS.map((x) => `mcp__atlassian__${x}`).join(','));
  const denied = probe.args[probe.args.indexOf('--disallowedTools') + 1].split(',');
  for (const d of ['mcp__acme-files', 'mcp__atlassian__executeWrite', 'mcp__atlassian__executeDestructive', 'mcp__atlassian__discover', 'mcp__atlassian__create*', 'mcp__atlassian__edit*', 'mcp__atlassian__transition*', 'mcp__atlassian__add*', 'mcp__atlassian__update*']) assert.ok(denied.includes(d), d);
  assert.equal(denied.some((d) => d === 'mcp__atlassian__execute*' || d.endsWith('executeRead')), false);
  // A Linear probe in the same sandbox never touches the Atlassian server.
  assert.equal(b.calls().some((c) => c.ran && !c.ran.startsWith('mcp__atlassian__')), false);
  // A saved allow rule for an Atlassian write is denied by name, and a broad one stops the probe.
  writeFileSync(join(b.s.claude, 'settings.json'), JSON.stringify({ permissions: { allow: ['mcp__atlassian__createJiraIssue', 'mcp__atlassian__getJiraIssue'] } }));
  claude.probeBoard('jira', { bin, env: b.probeEnv(), cwd: b.cwd });
  const second = b.calls().filter((c) => c.args[0] === '-p' && c.prompt).at(-1);
  const denied2 = second.args[second.args.indexOf('--disallowedTools') + 1].split(',');
  assert.ok(denied2.includes('mcp__atlassian__createJiraIssue'));
  assert.equal(denied2.includes('mcp__atlassian__getJiraIssue'), false);
  for (const broad of ['mcp__atlassian', 'mcp__atlassian__*', 'mcp__atlassian__execute*']) {
    writeFileSync(join(b.s.claude, 'settings.json'), JSON.stringify({ permissions: { allow: [broad] } }));
    const stopped = claude.probeBoard('jira', { bin, env: b.probeEnv(), cwd: b.cwd });
    assert.equal(stopped.blocked, true, broad);
    assert.match(stopped.detail, /allow Jira tools broadly .* The Jira probe did not run/);
  }
  assert.equal(claude.boardReach('mcp__atlassian__get*', 'atlassian', 'jira'), null);
});

test('a Jira probe fails on a Confluence read or an executeWrite in either client', { skip: fakesSkip }, (t) => {
  const b = box(t, { linear: 'none' });
  for (const mode of ['confluence', 'write']) {
    const c = claude.probeBoard('jira', { bin: join(b.s.fakes, 'claude'), env: b.probeEnv({ FAKE_JIRA_CALLS: mode }), cwd: b.cwd });
    const x = codex.probeBoard('jira', { bin: join(b.s.fakes, 'codex'), env: b.probeEnv({ FAKE_JIRA_CALLS: mode }), cwd: b.cwd });
    for (const r of [c, x]) {
      assert.equal(r.ok, false, mode);
      assert.equal(r.retry, undefined, mode);
      assert.match(r.detail, mode === 'confluence' ? /executeRead of getConfluencePage, which is not a Jira read/ : /executeWrite of createJiraIssue, which is not a Jira read/);
    }
  }
  // The Claude deny rule kept the write from running, and Codex never offered it.
  assert.equal(b.calls().some((c) => /executeWrite/.test(c.ran ?? '')), false);
  const claimed = claude.probeBoard('jira', { bin: join(b.s.fakes, 'claude'), env: b.probeEnv({ FAKE_JIRA_CALLS: 'claimed' }), cwd: b.cwd });
  assert.equal(claimed.ok, false);
  assert.match(claimed.detail, /made no Jira tool call/);
});

test('the Codex Jira probe keeps only the official server with the named reads and passes on real calls', { skip: fakesSkip }, (t) => {
  const b = box(t);
  const r = codex.probeBoard('jira', { bin: join(b.s.fakes, 'codex'), env: b.probeEnv(), cwd: b.cwd, target: { projects: ['ACM'] } });
  assert.equal(r.ok, true, r.detail);
  assert.deepEqual(r.sites[0].projects.find((p) => p.key === 'ACM'), { key: 'ACM', id: '10002', name: 'Acme Mobile', statuses: ['Draft', 'Ready', 'In Progress', 'Acceptance', 'Done'] });
  const probe = b.calls().find((c) => c.tool === 'codex' && c.args[0] === 'exec');
  assert.ok(probe.args.includes(`mcp_servers.atlassian.enabled_tools=${JSON.stringify(JIRA_PROBE_TOOLS)}`));
  for (const other of ['linear', 'acme_files']) assert.ok(probe.args.includes(`mcp_servers.${other}.enabled=false`), other);
  assert.equal(probe.args.some((a) => a.includes('default_tools_approval_mode')), false);
});

test('a server named atlassian at another URL is never used, by either client', { skip: fakesSkip }, (t) => {
  const b = box(t, { jira: 'impostor' });
  const c = claude.probeBoard('jira', { bin: join(b.s.fakes, 'claude'), env: b.probeEnv(), cwd: b.cwd });
  assert.equal(c.ok, false);
  assert.match(c.detail, /lists no Atlassian MCP server or connector at https:\/\/mcp\.atlassian\.com\/v2\/mcp or https:\/\/mcp\.atlassian\.com\/v1\/mcp/);
  const x = codex.probeBoard('jira', { bin: join(b.s.fakes, 'codex'), env: b.probeEnv(), cwd: b.cwd });
  assert.equal(x.ok, false);
  assert.equal(x.needsServer, true);
  assert.equal(b.calls().some((k) => k.args[0] === '-p' || k.args[0] === 'exec'), false);
  // addBoardMcp leaves such a server alone in both clients.
  for (const p of [claude, codex]) {
    const added = p.addBoardMcp('jira', { bin: join(b.s.fakes, p.name), env: b.probeEnv(), stdio: 'ignore' });
    assert.equal(added.ok, false);
    assert.match(added.detail, /already has a server named atlassian that does not point at https:\/\/mcp\.atlassian\.com\/v2\/mcp/);
  }
  assert.equal(b.calls().some((k) => k.args[0] === 'mcp' && ['add', 'login'].includes(k.args[1])), false);
  // A claude.ai connector counts when Claude Code reports the official URL for it.
  const b2 = box(t, { linear: 'none', jira: 'connector' });
  const conn = claude.probeBoard('jira', { bin: join(b2.s.fakes, 'claude'), env: b2.probeEnv(), cwd: b2.cwd });
  assert.equal(conn.ok, true, conn.detail);
  assert.ok(conn.tools.every((n) => n.startsWith('mcp__claude_ai_Atlassian__')));
});

test('addBoardMcp runs the documented Atlassian add and login commands for each client', { skip: fakesSkip }, (t) => {
  const b = box(t, { jira: 'none' });
  for (const p of [claude, codex]) assert.equal(p.addBoardMcp('jira', { bin: join(b.s.fakes, p.name), env: b.probeEnv(), stdio: 'ignore' }).ok, true);
  const mcp = b.calls().filter((k) => k.args[0] === 'mcp').map((k) => `${k.tool} ${k.args.join(' ')}`);
  assert.deepEqual(mcp, [
    'claude mcp get atlassian',
    'claude mcp add --transport http --scope user atlassian https://mcp.atlassian.com/v2/mcp',
    'claude mcp login atlassian',
    'codex mcp get atlassian --json',
    'codex mcp add atlassian --url https://mcp.atlassian.com/v2/mcp',
    'codex mcp login atlassian',
  ]);
  assert.equal(claude.LINEAR_FIX, 'Run `bollplank init` to add the Linear MCP, or run `claude mcp add --transport http --scope user linear https://mcp.linear.app/mcp` and then `claude mcp login linear`.');
  assert.equal(typeof claude.probeLinear, 'function');
  assert.equal(typeof codex.addLinearMcp, 'function');
});

test('init sets up a Jira board from scratch, saves the ids from the tools and never reads Linear', { skip: fakesSkip }, (t) => {
  const b = box(t);
  const r = b.init(withSource(b, { kind: 'jira', team: SITE, project: 'ACME', space: 'ACME' }));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const c = b.config();
  assert.deepEqual(c.board, { kind: 'jira', statuses: FIVE, team: SITE, project: 'ACME', teamId: 'cloud-acme', projectId: '10001', space: 'ACME' });
  // The project of the same site and project uses the board's statuses and space.
  assert.deepEqual(c.projects['acme-shop'].board, { team: SITE, project: 'ACME', teamId: 'cloud-acme', projectId: '10001' });
  const said = text(r);
  assert.match(said, /Claude Code read 1 Jira site/);
  assert.match(said, /The statuses of ACME in Jira: Draft, Ready, In Progress, Acceptance, Done\./);
  assert.match(said, /Found the space ACME on acme\.atlassian\.net\./);
  assert.match(said, /Jira site acme\.atlassian\.net, project ACME, with the board's statuses\./);
  // No Linear probe ran: every setup check named the Atlassian tools.
  const probes = b.calls().filter((k) => k.prompt?.includes('Bollplank setup check'));
  assert.ok(probes.length >= 4);
  assert.ok(probes.every((k) => k.prompt.includes('Atlassian tools')));
  assert.equal(b.calls().some((k) => k.ran && /linear/i.test(k.ran)), false);
  assert.equal(r.json.kind, 'jira');
  assert.deepEqual(r.json.linear, {});
  // Doctor reads Jira only, and every Jira check passes.
  const d = byId({ json: r.json.doctor });
  for (const id of ['jira.claude', 'jira.codex', 'jira', `board.jira.site.${SITE}`, `board.jira.cloudId.${SITE}`, `board.jira.project.${SITE}.ACME`, `board.jira.projectId.${SITE}.ACME`, `board.jira.status.${SITE}.ACME.acceptance`, `board.jira.space.${SITE}.ACME`]) assert.equal(d[id]?.ok, true, id);
  assert.equal(Object.keys(d).some((id) => id.startsWith('linear')), false);
  const ctx = b.s.run(['context', 'acme-shop']).json;
  assert.equal(ctx.board.kind, 'jira');
  assert.equal(ctx.board.space, 'ACME');
});

test('a missing Jira status shows the Jira steps, and an unreadable space is kept and named', { skip: fakesSkip }, (t) => {
  const b = box(t, { linear: 'none' });
  const r = b.init(withSource(b, { kind: 'jira', team: SITE, project: 'ACME', space: 'GONE', addProject: false }), ['--json'], { FAKE_JIRA_STATUSES: 'To Do,Draft,Ready,In Progress,Done' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const said = text(r);
  assert.match(said, /ACME lacks Acceptance\. Add it now, or map its state to a status the project has\./);
  assert.match(said, /To add it: Open the Jira project ACME, go to Project settings, then Workflows\. Add "Acceptance" in In Progress\. Then answer y when init asks to check Jira again\./);
  assert.match(said, /The Atlassian tools did not return the space GONE on acme\.atlassian\.net\. Kept it as typed\./);
  assert.equal(b.config().board.space, 'GONE');
  assert.equal(jiraAddStatusSteps('ACME', 'draft', 'Draft'), 'Open the Jira project ACME, go to Project settings, then Workflows. Add a status named "Draft" in the To Do category.');
});

test('a Jira project added to a Linear config reads Jira at that point and maps its own statuses', { skip: fakesSkip }, (t) => {
  const b = box(t);
  assert.equal(b.init(withSource(b, { addProject: false })).status, 0);
  const before = b.calls().length;
  // The first run never read Jira.
  assert.equal(b.calls().some((k) => k.prompt?.includes('Atlassian tools')), false);
  const mobile = join(b.s.root, 'code', 'mobile');
  mkdirSync(mobile, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', join(mobile, 'acme-mobile')]);
  const r = b.init({ approver: 'Ada', addProject: true, writeConfig: true, source: mobile, projectName: 'acme-mobile', tickets: join(mobile, 'Tickets'), github: { 'acme-mobile': 'acme/acme-mobile' }, projects: { 'acme-mobile': { kind: 'jira', team: SITE, project: 'ACM' } } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const said = text(r);
  assert.match(said, /acme-mobile uses a Jira board, so init reads Jira now\./);
  // Step 2 read Linear, then the project read Jira, in that order.
  const later = b.calls().slice(before).filter((k) => k.prompt?.includes('Bollplank setup check'));
  const firstJira = later.findIndex((k) => k.prompt.includes('Atlassian tools'));
  assert.ok(firstJira > 0 && later.slice(0, firstJira).every((k) => k.prompt.includes('Linear tool')));
  const c = b.config();
  assert.equal(c.board.kind, 'linear');
  assert.deepEqual(c.projects['acme-mobile'].board, { kind: 'jira', team: SITE, project: 'ACM', teamId: 'cloud-acme', projectId: '10002', statuses: FIVE });
  const d = byId({ json: r.json.doctor });
  for (const id of ['linear.claude', 'linear', 'jira.claude', 'jira.codex', 'jira', `board.jira.project.${SITE}.ACM`, `board.jira.projectId.${SITE}.ACM`, `board.jira.status.${SITE}.ACM.done`, 'board.team.ACME']) assert.equal(d[id]?.ok, true, id);
  assert.equal(r.json.doctor.ok, true);
});

test('an old Linear answers file without kind makes the same calls and config as one that says linear', { skip: fakesSkip }, (t) => {
  const b = box(t);
  const answers = withSource(b, { addLinear: { codex: true } });
  const run = (extra) => {
    rmSync(join(b.s.bollplank, 'config.json'), { force: true });
    rmSync(join(b.state, 'calls.jsonl'), { force: true });
    const r = b.init({ ...answers, ...extra }, ['--json'], { FAKE_LINEAR: 'real' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    // A critic dry run gets a fresh session id each time.
    const args = (k) => k.args.map((x, i) => (k.args[i - 1] === '--session-id' ? 'session' : x));
    return { calls: b.calls().map((k) => ({ tool: k.tool, args: args(k), prompt: k.prompt ?? null, ran: k.ran ?? null })), config: b.config() };
  };
  const old = run({});
  const said = run({ kind: 'linear' });
  assert.deepEqual(old.calls, said.calls);
  assert.deepEqual(old.config, said.config);
  assert.equal(old.calls.some((k) => k.prompt?.includes('Atlassian tools') || k.args.includes('atlassian')), false);
  assert.deepEqual(Object.keys(old.config.board).sort(), ['kind', 'project', 'statuses', 'team']);
  assert.deepEqual(old.config.projects['acme-shop'].board, { team: 'ACME', project: 'Shop' });
});

test('doctor passes a Linear and a Jira project together, and fails a missing status, a wrong id and an unreadable space', { skip: fakesSkip }, (t) => {
  const b = box(t);
  assert.equal(b.init({ approver: 'Ada', addProject: false, team: 'ACME', project: 'Shop' }, ['--json', '--offline']).status, 0);
  const project = (board) => ({ source: b.s.root, tickets: join(b.s.root, 'tickets'), repos: { 'acme-api': { github: 'acme/acme-api' } }, ...(board ? { board } : {}) });
  const mobile = { kind: 'jira', team: SITE, project: 'ACM', teamId: 'cloud-acme', projectId: '10002', space: 'ACME', statuses: FIVE };
  const write = (m) => b.s.config({ ...b.config(), projects: { 'acme-shop': project(null), 'acme-mobile': project(m) } });
  write(mobile);
  const doctor = (extra) => b.s.run(['doctor', '--json'], { ...b.env, ...extra });
  let r = doctor();
  assert.equal(r.status, 0, r.stdout);
  let c = byId(r);
  for (const id of ['linear.claude', 'linear.codex', 'linear', 'jira.claude', 'jira.codex', 'jira', 'board.team.ACME', 'board.status.ACME.acceptance', `board.jira.site.${SITE}`, `board.jira.cloudId.${SITE}`, `board.jira.project.${SITE}.ACM`, `board.jira.projectId.${SITE}.ACM`, `board.jira.status.${SITE}.ACM.acceptance`, `board.jira.space.${SITE}.ACME`]) assert.equal(c[id]?.ok, true, id);
  // The Jira probe asked for the configured project and space.
  const jiraProbe = b.calls().filter((k) => k.prompt?.includes('Atlassian tools')).at(-1);
  assert.match(jiraProbe.prompt, /^Projects: ACM\.$/m);
  assert.match(jiraProbe.prompt, /^Spaces: ACME\.$/m);
  // A missing status gives the Jira steps and the project's own key.
  r = doctor({ FAKE_JIRA_STATUSES: 'Draft,Ready,In Progress,Done' });
  assert.equal(r.status, 1);
  c = byId(r);
  const missing = c[`board.jira.status.${SITE}.ACM.acceptance`];
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /ACM has no status named "Acceptance" that Claude Code or Codex can read/);
  assert.match(missing.fix, /^Open the Jira project ACM, go to Project settings, then Workflows\. Add a status named "Acceptance" in the In Progress category\. Or set projects\.acme-mobile\.board\.statuses\.acceptance in the config to a status that exists\. A new Jira project has only To Do, In Progress, Done/);
  assert.equal(c['board.status.ACME.acceptance'].ok, true);
  // An unreadable space fails.
  r = doctor({ FAKE_JIRA_SPACES: '' });
  assert.equal(r.status, 1);
  c = byId(r);
  assert.equal(c[`board.jira.space.${SITE}.ACME`].ok, false);
  assert.match(c[`board.jira.space.${SITE}.ACME`].fix, /projects\.acme-mobile\.board\.space/);
  // A cloud id or project id that differs from the tools fails, and a missing one only warns.
  write({ ...mobile, teamId: 'cloud-globex', projectId: undefined });
  r = doctor();
  c = byId(r);
  assert.equal(c[`board.jira.cloudId.${SITE}`].ok, false);
  assert.match(c[`board.jira.cloudId.${SITE}`].detail, /teamId is cloud-globex, but Claude Code and Codex read the cloud id cloud-acme/);
  assert.equal(c[`board.jira.projectId.${SITE}.ACM`].ok, false);
  assert.equal(c[`board.jira.projectId.${SITE}.ACM`].required, false);
  // The Jira server missing in one client fails jira.<client> with the Atlassian fix.
  write(mobile);
  r = doctor({ FAKE_JIRA: 'impostor' });
  c = byId(r);
  assert.equal(c['jira.codex'].ok, false);
  assert.match(c['jira.codex'].fix, /codex mcp add atlassian --url https:\/\/mcp\.atlassian\.com\/v2\/mcp/);
  assert.equal(c.jira.ok, false);
  assert.equal(c.linear.ok, true);
});

test('an inner call whose fields name different tools is refused by the probe judge', () => {
  const ctx = { servers: ['atlassian'] };
  assert.deepEqual(innerCall({ tool: 'listJiraProjects', toolName: 'listJiraProjects', arguments: { cloudId: 'c' } }), { tool: 'listJiraProjects', args: { cloudId: 'c' } });
  for (const args of [{ tool: 'listJiraProjects', toolName: 'createJiraIssue' }, { tool: 'listJiraStatuses', name: 'getConfluencePage' }, { tool_name: 'listJiraProjects', toolName: 'searchJiraIssuesUsingJql' }, { tool: 'listJiraProjects', name: 7 }]) {
    assert.equal(innerCall(args).tool, CONFLICTING_INNER, JSON.stringify(args));
    assert.equal(isJiraRead({ name: 'mcp__atlassian__executeRead', args }, ctx), false, JSON.stringify(args));
  }
  const site = { name: 'mcp__atlassian__getAccessibleAtlassianResources', ok: true, args: {}, text: JSON.stringify([{ id: 'cloud-acme', url: 'https://acme.atlassian.net' }]) };
  const mixed = { name: 'mcp__atlassian__executeRead', ok: true, args: { tool: 'listJiraProjects', toolName: 'createJiraIssue', arguments: { cloudId: 'cloud-acme' } }, text: '{}' };
  const r = judgeJira('Acme client', [site, mixed], JSON.stringify({ sites: [] }), ctx);
  assert.equal(r.ok, false);
  assert.match(r.detail, /executeRead of conflicting inner tool names/);
});
