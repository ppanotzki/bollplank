// The critic command and both providers, against fake claude and codex programs on a PATH that
// holds nothing else. No test runs a real client, reads a real sign in or makes a model call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { sandbox, acmeConfig, fakesSkip } from './helpers.mjs';
import * as claude from '../lib/providers/claude.mjs';
import * as codex from '../lib/providers/codex.mjs';
import { get, other, childEnv, providers } from '../lib/providers/index.mjs';

const CRITIQUE = 'Critique of ACME-1 brief v1\\nReviewer: fake\\nModel: fake\\nVerdict: Approve\\n\\nNo material points.';

// Both fakes reply with FAKE_TEXT when it is set, else with CRITIQUE. FAKE_MODE picks a failure or
// a tool the critic must not use.
const FAKE_CLAUDE = `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const mode = process.env.FAKE_MODE || 'ok';
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(ANTHROPIC_|OPENAI_|CODEX_|CLAUDE|AWS_|AZURE_|ACME_|ENABLE_)/i.test(k)));
const record = (extra) => fs.appendFileSync(process.env.FAKE_CAPTURE, JSON.stringify({ tool: 'claude', args, cwd: process.cwd(), env, ...extra }) + '\\n');
if (args[0] === '--version') { record({}); console.log('2.1.312 (Claude Code)'); process.exit(0); }
if (args[0] === 'auth') {
  record({});
  const auth = process.env.FAKE_CLAUDE_AUTH || 'subscription';
  const s = auth === 'subscription' ? { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'pro' }
    : auth === 'key' ? { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' }
    : auth === 'bedrock' ? { loggedIn: true, authMethod: 'third_party', apiProvider: 'bedrock' }
    : { loggedIn: false };
  console.log(JSON.stringify(s));
  process.exit(s.loggedIn ? 0 : 1);
}
const at = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const session = at('--resume') ?? at('--session-id');
const model = at('--model') ?? 'claude-acme-default';
const emit = (e) => process.stdout.write(JSON.stringify(e) + '\\n');
if (mode === 'resume-missing' && at('--resume')) { record({ prompt: '' }); process.stderr.write('No conversation found with session ID: ' + session + '\\n'); process.exit(1); }
const tools = (at('--tools') ?? '').split(',').filter(Boolean);
if (mode === 'init-tools') tools.push('Bash', 'mcp__acme__search');
emit({ type: 'system', subtype: 'init', session_id: session, claude_code_version: 'fake', tools, mcp_servers: mode === 'init-mcp' ? [{ name: 'acme', status: 'connected' }] : [] });
const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'acme-neutral');
fs.mkdirSync(dir, { recursive: true });
fs.appendFileSync(path.join(dir, session + '.jsonl'), '{}\\n');
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const prompt = JSON.parse(line).message.content;
  record({ prompt });
  if (mode === 'timeout') return;
  if (mode === 'client-error') return emit({ type: 'result', subtype: 'error', is_error: true, result: 'synthetic usage limit reached', session_id: session });
  if (mode === 'no-result') { process.stderr.write('synthetic crash\\n'); process.exit(4); }
  if (mode === 'tool-use') emit({ type: 'assistant', session_id: session, message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'mcp__acme__search', input: {} }] } });
  const text = process.env.FAKE_TEXT ?? (mode === 'malformed' ? 'Here is my review.\\nVerdict: Approve' : mode === 'empty' ? '' : '${CRITIQUE}');
  emit({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: session, modelUsage: mode === 'no-model' ? {} : { [model + '-20261101']: {} }, usage: { input_tokens: 12, output_tokens: 34 } });
  if (mode === 'exit-after-review') process.exitCode = 9;
});
`;

// The fake Codex lists the servers in FAKE_CODEX_MCP (default acme_files) for `mcp list --json` and
// honours -c mcp_servers.<name>.enabled=false, unless FAKE_MODE is mcp-stays-on or mcp-fails.
const FAKE_CODEX = `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const mode = process.env.FAKE_MODE || 'ok';
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(ANTHROPIC_|OPENAI_|CODEX_|CLAUDE|AWS_|AZURE_|ACME_|ENABLE_)/i.test(k)));
const record = (extra) => fs.appendFileSync(process.env.FAKE_CAPTURE, JSON.stringify({ tool: 'codex', args, cwd: process.cwd(), env, ...extra }) + '\\n');
if (args[0] === '--version') { record({}); console.log('codex-cli 0.166.0-alpha.5.1'); process.exit(0); }
if (args[0] === 'login' && args[1] === 'status') {
  record({});
  const auth = process.env.FAKE_CODEX_AUTH || 'chatgpt';
  if (auth === 'chatgpt') { process.stderr.write('Logged in using ChatGPT\\n'); process.exit(0); }
  if (auth === 'key') { process.stderr.write('Logged in using an API key - sk-acme***\\n'); process.exit(0); }
  process.stderr.write('Not logged in\\n');
  process.exit(1);
}
if (args[0] === 'mcp' && args[1] === 'list') {
  record({});
  if (mode === 'mcp-fails') process.exit(1);
  const names = (process.env.FAKE_CODEX_MCP ?? 'acme_files').split(',').filter(Boolean);
  console.log(JSON.stringify(names.map((name) => ({ name, enabled: mode === 'mcp-stays-on' || !args.includes('mcp_servers.' + name + '.enabled=false') }))));
  process.exit(0);
}
if (args[0] !== 'exec') process.exit(2);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  record({ prompt: input });
  const emit = (e) => process.stdout.write(JSON.stringify(e) + '\\n');
  const resumed = args.includes('resume');
  if (mode === 'resume-missing' && resumed) { process.stderr.write('Error: thread not found\\n'); process.exit(1); }
  const id = resumed ? args[args.length - 2] : require('node:crypto').randomUUID();
  emit({ type: 'thread.started', thread_id: id });
  emit({ type: 'turn.started' });
  if (mode === 'timeout') { setInterval(() => {}, 1000); return; }
  if (mode === 'client-error') { emit({ type: 'turn.failed', error: { message: 'synthetic usage limit reached' } }); process.exit(1); }
  if (mode === 'no-result') { process.stderr.write('synthetic crash\\n'); process.exit(4); }
  if (mode === 'tool-use') emit({ type: 'item.started', item: { id: 'item_1', type: 'mcp_tool_call', server: 'codex_apps', tool: 'acme_search', arguments: {}, status: 'in_progress' } });
  if (mode === 'web-search') emit({ type: 'item.completed', item: { id: 'item_1', type: 'web_search', query: 'acme' } });
  emit({ type: 'item.completed', item: { id: 'item_r', type: 'reasoning', text: 'thinking' } });
  emit({ type: 'item.completed', item: { id: 'item_c', type: 'command_execution', command: 'ls', status: 'completed' } });
  const text = process.env.FAKE_TEXT ?? (mode === 'malformed' ? 'Here is my review.\\nVerdict: Approve' : mode === 'empty' ? '' : '${CRITIQUE}');
  emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } });
  emit({ type: 'turn.completed', usage: { input_tokens: 12, cached_input_tokens: 0, output_tokens: 34 } });
  const m = args.indexOf('-m') >= 0 ? args[args.indexOf('-m') + 1] : 'gpt-acme-default';
  const effort = (args.find((a) => a.startsWith('model_reasoning_effort=')) || '').match(/"(.*)"/)?.[1] ?? null;
  const dir = path.join(process.env.CODEX_HOME, 'sessions', '2026', '11', '02');
  fs.mkdirSync(dir, { recursive: true });
  if (mode !== 'no-model') fs.appendFileSync(path.join(dir, 'rollout-2026-11-02-' + id + '.jsonl'), JSON.stringify({ type: 'turn_context', payload: { model: m, effort } }) + '\\n');
  if (mode === 'exit-after-review') process.exit(3);
});
`;

// A sandbox whose PATH holds only the chosen fakes, node and git, with no app bundle folder,
// so the real clients on this machine can never be found.
function box({ clients = ['claude', 'codex'], critic = undefined } = {}) {
  const s = sandbox();
  const tools = join(s.root, 'tools');
  mkdirSync(tools);
  symlinkSync(process.execPath, join(tools, 'node'));
  const git = which('git');
  if (git) symlinkSync(git, join(tools, 'git'));
  if (clients.includes('claude')) s.fake('claude', FAKE_CLAUDE);
  if (clients.includes('codex')) s.fake('codex', FAKE_CODEX);
  const capture = join(s.root, 'capture.jsonl');
  s.config({ ...acmeConfig(join(s.root, 'src'), join(s.root, 'tickets')), ...(critic ? { critic } : {}) });
  const prompt = join(s.root, 'prompt.md');
  writeFileSync(prompt, 'Critique brief v1 for ticket ACME-1.\nReviewer: {REVIEWER}\nModel: {MODEL}\nWorkflow: {WORKFLOW}\nThe subject follows.\nAcme ships widgets.\n');
  const base = { PATH: [s.fakes, tools].join(delimiter), BOLLPLANK_APPS_DIR: join(s.root, 'apps'), FAKE_CAPTURE: capture };
  const call = (opts = {}, extraEnv = {}) => {
    const { subject = 'brief', round = 1, lead = 'claude', critic: c, readDir, timeout, promptFile = prompt, ticket = 'ACME-1', newSession } = opts;
    const args = ['critic', '--ticket', ticket, '--subject', subject, '--round', String(round), '--prompt-file', promptFile, '--lead', lead];
    if (c) args.push('--critic', c);
    if (readDir) args.push('--read-dir', readDir);
    if (timeout) args.push('--timeout', String(timeout));
    if (newSession) args.push('--new-session');
    return s.run(args, { ...base, ...extraEnv });
  };
  const captures = () => (existsSync(capture) ? readFileSync(capture, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const reviews = () => captures().filter((c) => c.prompt !== undefined);
  const state = (name) => {
    const f = join(s.bollplank, 'critics', name);
    return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
  };
  const bindings = () => {
    const f = join(s.bollplank, 'ledger', 'bindings.jsonl');
    return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  return { s, call, captures, reviews, state, bindings, prompt };
}

function which(cmd) {
  for (const d of (process.env.PATH ?? '').split(delimiter)) {
    const p = join(d, cmd);
    try {
      if (statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}

const after = (t, b) => t.after(b.s.clean);
const argAfter = (args, flag) => args[args.indexOf(flag) + 1];

test('the provider index names both providers and picks the other one', () => {
  assert.deepEqual(Object.keys(providers).sort(), ['claude', 'codex']);
  assert.equal(get('claude').label, 'Claude Code');
  assert.equal(get('codex').label, 'Codex');
  assert.equal(get('acme'), null);
  assert.equal(other('claude').name, 'codex');
  assert.equal(other('codex').name, 'claude');
  for (const p of [claude, codex]) for (const f of ['resolve', 'version', 'signInStatus', 'review', 'sessionRoots']) assert.equal(typeof p[f], 'function', `${p.name}.${f}`);
  assert.match(claude.testedVersion, /^\d+\.\d+\.\d+/);
  assert.match(codex.testedVersion, /^\d+\.\d+\.\d+/);
});

test('the child environment loses every key, provider route and session marker and nothing else', () => {
  const env = childEnv({ ANTHROPIC_API_KEY: 'x', ANTHROPIC_BASE_URL: 'x', OPENAI_API_KEY: 'x', CODEX_API_KEY: 'x', CODEX_ACCESS_TOKEN: 'x', CLAUDE_CODE_USE_BEDROCK: '1', AWS_BEARER_TOKEN_BEDROCK: 'x', AZURE_OPENAI_API_KEY: 'x', CODEX_HOME: '/h', CLAUDE_CONFIG_DIR: '/c', AWS_PROFILE: 'acme', HOME: '/home', PATH: '/bin' });
  assert.deepEqual(Object.keys(env).sort(), ['AWS_PROFILE', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HOME', 'PATH']);
  const markers = { CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_PID: '1', CLAUDE_EFFORT: 'max', CLAUDE_AGENT_SDK_VERSION: '1', CLAUDE_CODE_SIMPLE: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CODE_HOST_SESSION_ID: 'x', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_MESSAGING_SOCKET: 'x', CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1' };
  const lower = { anthropic_api_key: 'x', Openai_Api_Key: 'x', claudecode: '1', Claude_Pid: '1', claude_agent_sdk_version: '1' };
  const kept = childEnv({ ...markers, ...lower, CLAUDE_CODE_OAUTH_TOKEN: 'acme-subscription', CLAUDE_CODECOV: 'acme', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '1000', Path: 'C:\\acme' });
  assert.deepEqual(Object.keys(kept).sort(), ['CLAUDE_CODECOV', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'CLAUDE_CODE_OAUTH_TOKEN', 'Path']);
});

test('session roots follow the client folders', () => {
  assert.deepEqual(claude.sessionRoots({ CLAUDE_CONFIG_DIR: '/acme/claude' }), [join('/acme/claude', 'projects')]);
  assert.deepEqual(codex.sessionRoots({ CODEX_HOME: '/acme/codex' }), [join('/acme/codex', 'sessions')]);
  assert.deepEqual(claude.sessionRoots({ HOME: '/acme' }), [join('/acme', '.claude', 'projects')]);
  assert.deepEqual(codex.sessionRoots({ HOME: '/acme' }), [join('/acme', '.codex', 'sessions')]);
});

test('resolve searches PATH, then the app bundles, and finds nothing when neither has the client', { skip: fakesSkip }, (t) => {
  const b = box({ clients: [] });
  after(t, b);
  const env = { PATH: b.s.fakes, HOME: b.s.home, BOLLPLANK_APPS_DIR: join(b.s.root, 'apps') };
  assert.equal(claude.resolve(env), null);
  assert.equal(codex.resolve(env), null);
  for (const v of ['2.1.9', '2.1.10']) {
    const dir = join(b.s.home, 'Library', 'Application Support', 'Claude', 'claude-code', v, 'h', 'claude.app', 'Contents', 'MacOS');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'claude'), '');
    chmodSync(join(dir, 'claude'), 0o755);
  }
  assert.match(claude.resolve(env), /2\.1\.10/);
  const bundle = join(b.s.root, 'apps', 'ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'bin');
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(bundle, 'codex'), '');
  chmodSync(join(bundle, 'codex'), 0o755);
  assert.equal(codex.resolve(env), join(bundle, 'codex'));
  const onPath = b.s.fake('codex', FAKE_CODEX);
  assert.equal(codex.resolve(env), onPath);
});

test('sign in status tells a subscription from a key or no sign in', { skip: fakesSkip }, (t) => {
  const b = box();
  after(t, b);
  const env = (extra) => ({ PATH: [b.s.fakes, join(b.s.root, 'tools')].join(delimiter), FAKE_CAPTURE: join(b.s.root, 'capture.jsonl'), ...extra });
  const cbin = join(b.s.fakes, 'claude');
  const xbin = join(b.s.fakes, 'codex');
  assert.deepEqual(pick(claude.signInStatus(cbin, env({}))), { signedIn: true, subscription: true, method: 'claude.ai' });
  assert.deepEqual(pick(claude.signInStatus(cbin, env({ FAKE_CLAUDE_AUTH: 'key' }))), { signedIn: true, subscription: false, method: 'api_key' });
  assert.deepEqual(pick(claude.signInStatus(cbin, env({ FAKE_CLAUDE_AUTH: 'bedrock' }))), { signedIn: true, subscription: false, method: 'third_party' });
  assert.equal(claude.signInStatus(cbin, env({ FAKE_CLAUDE_AUTH: 'out' })).signedIn, false);
  assert.deepEqual(pick(codex.signInStatus(xbin, env({}))), { signedIn: true, subscription: true, method: 'chatgpt' });
  const key = codex.signInStatus(xbin, env({ FAKE_CODEX_AUTH: 'key' }));
  assert.deepEqual(pick(key), { signedIn: true, subscription: false, method: 'api-key' });
  assert.equal(key.detail.includes('sk-'), false);
  assert.equal(codex.signInStatus(xbin, env({ FAKE_CODEX_AUTH: 'out' })).signedIn, false);
  assert.equal(claude.version(cbin, env({})), '2.1.312');
  assert.equal(codex.version(xbin, env({})), '0.166.0-alpha.5.1');
});

const pick = ({ signedIn, subscription, method }) => ({ signedIn, subscription, method });

test('other picks the provider that is not leading', { skip: fakesSkip }, (t) => {
  const b = box();
  after(t, b);
  const r1 = b.call({ lead: 'claude' });
  assert.equal(r1.status, 0, r1.stdout);
  assert.equal(r1.json.critic, 'codex');
  assert.equal(r1.json.mode, 'other');
  assert.equal(r1.json.verdict, 'Approve');
  assert.deepEqual(r1.json.usage, { input_tokens: 12, cached_input_tokens: 0, output_tokens: 34 });
  assert.match(b.reviews().at(-1).prompt, /^Reviewer: Codex$/m);
  const r2 = b.call({ lead: 'codex' });
  assert.equal(r2.status, 0, r2.stdout);
  assert.equal(r2.json.critic, 'claude');
  assert.match(b.reviews().at(-1).prompt, /^Reviewer: Claude Code$/m);
  assert.deepEqual(b.reviews().map((c) => c.tool), ['codex', 'claude']);
  assert.ok(b.state('ACME-1.codex.json'));
  assert.ok(b.state('ACME-1.claude.json'));
});

test('same with only one client works, is labelled, and uses the same model setting', { skip: fakesSkip }, (t) => {
  const b = box({ clients: ['claude'], critic: { providers: { claude: { model: 'claude-acme', effort: 'high' } }, same: { claude: { model: 'claude-acme-same', effort: 'max' } } } });
  after(t, b);
  const r = b.call({ lead: 'claude', critic: 'same' });
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.critic, 'claude');
  assert.equal(r.json.mode, 'same');
  assert.equal(r.json.model, 'claude-acme-same, max');
  const call = b.reviews().at(-1);
  assert.match(call.prompt, /^Reviewer: Claude Code, same provider, separate session$/m);
  assert.match(call.prompt, /^Model: claude-acme-same, max$/m);
  assert.equal(argAfter(call.args, '--model'), 'claude-acme-same');
  assert.equal(argAfter(call.args, '--effort'), 'max');
  assert.ok(b.state('ACME-1.claude.same.json'));
  assert.equal(b.state('ACME-1.claude.json'), null);
});

test('the default comes from config and --critic overrides it', { skip: fakesSkip }, (t) => {
  const b = box({ critic: { default: 'same' } });
  after(t, b);
  const r1 = b.call({ lead: 'codex' });
  assert.equal(r1.json.critic, 'codex');
  assert.equal(r1.json.mode, 'same');
  const r2 = b.call({ lead: 'codex', critic: 'claude' });
  assert.equal(r2.json.critic, 'claude');
  assert.equal(r2.json.mode, 'named');
  assert.match(b.reviews().at(-1).prompt, /^Reviewer: Claude Code$/m);
});

test('other with one client fails critic-unavailable and never runs the lead', { skip: fakesSkip }, (t) => {
  const b = box({ clients: ['claude'] });
  after(t, b);
  const r = b.call({ lead: 'claude' });
  assert.equal(r.status, 1);
  assert.equal(r.json.failure, 'critic-unavailable');
  assert.equal(r.json.critic, 'codex');
  assert.match(r.json.detail, /Codex was not found/);
  assert.deepEqual(b.captures(), []);
  assert.equal(b.state('ACME-1.codex.json'), null);
  assert.equal(b.state('ACME-1.claude.same.json'), null);
});

test('a critic signed in without a subscription is unavailable and never reviews', { skip: fakesSkip }, (t) => {
  const b = box();
  after(t, b);
  const r1 = b.call({ lead: 'claude' }, { FAKE_CODEX_AUTH: 'key' });
  assert.equal(r1.json.failure, 'critic-unavailable');
  assert.match(r1.json.detail, /API key, not a ChatGPT subscription/);
  const r2 = b.call({ lead: 'codex' }, { FAKE_CLAUDE_AUTH: 'out' });
  assert.equal(r2.json.failure, 'critic-unavailable');
  assert.match(r2.json.detail, /not signed in/);
  assert.deepEqual(b.reviews(), []);
});

for (const critic of ['claude', 'codex']) {
  test(`${critic}: brief 1 and 2, plan 1 and code 1 reuse one session without a mismatch`, { skip: fakesSkip }, (t) => {
    const b = box();
    after(t, b);
    const lead = critic === 'claude' ? 'codex' : 'claude';
    const steps = [['brief', 1], ['brief', 2], ['plan', 1], ['code', 1]];
    let session;
    for (const [subject, round] of steps) {
      const r = b.call({ lead, subject, round });
      assert.equal(r.status, 0, r.stdout);
      assert.equal(r.json.subject, subject);
      assert.equal(r.json.round, round);
      session ??= r.json.sessionId;
      assert.equal(r.json.sessionId, session);
    }
    assert.deepEqual(b.state(`ACME-1.${critic}.json`), { sessionId: session, rounds: { brief: 2, plan: 1, code: 1 } });
    const calls = b.reviews();
    assert.equal(calls.length, 4);
    if (critic === 'claude') {
      assert.equal(argAfter(calls[0].args, '--session-id'), session);
      assert.equal(calls[0].args.includes('--resume'), false);
      for (const c of calls.slice(1)) {
        assert.equal(argAfter(c.args, '--resume'), session);
        assert.equal(c.args.includes('--session-id'), false);
      }
    } else {
      assert.equal(calls[0].args.includes('resume'), false);
      for (const c of calls.slice(1)) {
        assert.equal(argAfter(c.args, 'resume') !== undefined, true);
        assert.equal(c.args.at(-2), session);
        assert.equal(c.args.at(-1), '-');
      }
    }
    assert.deepEqual(b.bindings().map((e) => [e.subject, e.round, e.session, e.tool]), steps.map(([s, n]) => [s, n, session, critic]));
  });
}

test('a skipped or repeated round is refused before any client runs', { skip: fakesSkip }, (t) => {
  const b = box();
  after(t, b);
  assert.equal(b.call({ round: 1 }).status, 0);
  const before = b.captures().length;
  for (const [subject, round, expected] of [['brief', 1, 2], ['brief', 3, 2], ['plan', 2, 1], ['code', 0, null]]) {
    const r = b.call({ subject, round });
    if (expected === null) {
      assert.equal(r.json.failure, 'usage');
      continue;
    }
    assert.equal(r.status, 1);
    assert.equal(r.json.failure, 'round-mismatch');
    assert.equal(r.json.expected, expected);
  }
  assert.equal(b.captures().length, before);
  assert.deepEqual(b.state('ACME-1.codex.json').rounds, { brief: 1, plan: 0, code: 0 });
});

test('claude: no tools without read-dir, and reads only inside the real folder with it', { skip: fakesSkip }, (t) => {
  const b = box();
  after(t, b);
  const src = join(b.s.root, 'acme source');
  mkdirSync(src);
  const plain = b.call({ lead: 'codex', subject: 'brief' });
  assert.equal(plain.status, 0, plain.stdout);
  const r = b.call({ lead: 'codex', subject: 'code', readDir: src });
  assert.equal(r.status, 0, r.stdout);
  const [first, second] = b.reviews();
  for (const c of [first, second]) {
    assert.ok(c.args.includes('-p'));
    assert.equal(argAfter(c.args, '--input-format'), 'stream-json');
    assert.equal(argAfter(c.args, '--output-format'), 'stream-json');
    assert.equal(argAfter(c.args, '--setting-sources'), 'local');
    assert.ok(c.args.includes('--strict-mcp-config'));
    assert.equal(c.args.includes('--mcp-config'), false);
    assert.equal(argAfter(c.args, '--permission-prompts'), 'none');
    assert.equal(c.args.includes('--dangerously-skip-permissions'), false);
    assert.equal(c.env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
    assert.equal(realpathSync(c.cwd), realpathSync(join(b.s.bollplank, 'neutral')));
  }
  assert.equal(argAfter(first.args, '--tools'), '');
  for (const f of ['--allowedTools', '--add-dir', '--disallowedTools']) assert.equal(first.args.includes(f), false, f);
  assert.equal(argAfter(second.args, '--tools'), 'Read,Grep,Glob');
  assert.equal(argAfter(second.args, '--allowedTools'), `Read(/${realpathSync(src)}/**)`);
  assert.match(argAfter(second.args, '--allowedTools'), /^Read\(\/\/.*acme source\/\*\*\)$/);
  assert.equal(argAfter(second.args, '--add-dir'), realpathSync(src));
  assert.equal(argAfter(second.args, '--disallowedTools'), 'Bash,Edit,Write,NotebookEdit,PowerShell');
});

test('codex: read-dir is the working folder in a read only ChatGPT session, otherwise the neutral folder', { skip: fakesSkip }, (t) => {
  const b = box({ critic: { providers: { codex: { model: 'gpt-acme', effort: 'high' } } } });
  after(t, b);
  const src = join(b.s.root, 'acme source');
  mkdirSync(src);
  const plain = b.call({ lead: 'claude', subject: 'brief' });
  assert.equal(plain.status, 0, plain.stdout);
  assert.equal(plain.json.model, 'gpt-acme, high');
  const r = b.call({ lead: 'claude', subject: 'plan', readDir: src });
  assert.equal(r.status, 0, r.stdout);
  const [first, second] = b.reviews();
  for (const c of [first, second]) {
    assert.equal(c.args[0], 'exec');
    assert.ok(c.args.includes('--json'));
    assert.equal(argAfter(c.args, '--sandbox'), 'read-only');
    assert.ok(c.args.includes('forced_login_method="chatgpt"'));
    assert.ok(c.args.includes('model_provider="openai"'));
    assert.ok(c.args.includes('web_search="disabled"'));
    for (const f of ['apps', 'plugins', 'remote_plugin', 'hooks', 'computer_use', 'browser_use', 'multi_agent']) assert.ok(c.args.some((a, i) => a === f && c.args[i - 1] === '--disable'), f);
    assert.ok(c.args.includes('mcp_servers.acme_files.enabled=false'));
    assert.equal(argAfter(c.args, '-m'), 'gpt-acme');
    assert.ok(c.args.includes('model_reasoning_effort="high"'));
    assert.equal(c.args.includes('--approve-for-me'), false);
    assert.equal(c.args.some((a) => a.startsWith('--dangerously')), false);
  }
  assert.equal(realpathSync(argAfter(first.args, '--cd')), realpathSync(join(b.s.bollplank, 'neutral')));
  assert.equal(realpathSync(first.cwd), realpathSync(join(b.s.bollplank, 'neutral')));
  assert.equal(argAfter(second.args, '--cd'), realpathSync(src));
  assert.equal(realpathSync(second.cwd), realpathSync(src));
  assert.ok(second.args.indexOf('--sandbox') < second.args.indexOf('resume'));
});

test('a missing read-dir is a usage failure', { skip: fakesSkip }, (t) => {
  const b = box();
  after(t, b);
  const r = b.call({ subject: 'code', readDir: join(b.s.root, 'missing') });
  assert.equal(r.status, 2);
  assert.equal(r.json.failure, 'usage');
  assert.deepEqual(b.captures(), []);
});

test('scrubbed keys never reach the child, and other variables do', { skip: fakesSkip }, (t) => {
  const b = box();
  after(t, b);
  const keep = { ACME_KEEP: 'kept', CLAUDE_CODE_OAUTH_TOKEN: 'acme-subscription' };
  const keys = { ANTHROPIC_API_KEY: 'sk-acme-1', OPENAI_API_KEY: 'sk-acme-2', CODEX_API_KEY: 'sk-acme-3', CODEX_ACCESS_TOKEN: 'acme', CLAUDE_CODE_USE_BEDROCK: '1', AWS_BEARER_TOKEN_BEDROCK: 'acme', AZURE_OPENAI_API_KEY: 'acme', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_PID: '42', CLAUDE_EFFORT: 'max', CLAUDE_AGENT_SDK_VERSION: '1.0', ...keep };
  for (const lead of ['claude', 'codex']) assert.equal(b.call({ lead, ticket: `ACME-${lead === 'claude' ? 2 : 3}` }, keys).status, 0);
  const calls = b.captures();
  assert.ok(calls.length >= 4);
  for (const c of calls) {
    for (const k of Object.keys(keys).filter((k) => !(k in keep))) assert.equal(c.env[k], undefined, `${k} reached ${c.tool} ${c.args[0]}`);
    assert.equal(c.env.ACME_KEEP, 'kept');
    assert.equal(c.env.CLAUDE_CODE_OAUTH_TOKEN, 'acme-subscription');
    assert.ok(c.env.CODEX_HOME);
    assert.ok(c.env.CLAUDE_CONFIG_DIR);
  }
});

test('a missing prompt file is a JSON usage failure', { skip: fakesSkip }, (t) => {
  const b = box();
  after(t, b);
  const r = b.call({ promptFile: join(b.s.root, 'nope.md') });
  assert.equal(r.status, 2);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.failure, 'usage');
  assert.match(r.json.detail, /prompt file/);
});

test('bad options are JSON usage failures', { skip: fakesSkip }, (t) => {
  const b = box();
  after(t, b);
  for (const opts of [{ subject: 'essay' }, { lead: 'acme' }, { critic: 'cousin' }, { ticket: 'acme' }, { round: 'x' }]) {
    const r = b.call(opts);
    assert.equal(r.status, 2, JSON.stringify(opts));
    assert.equal(r.json.failure, 'usage');
  }
  const r = b.s.run(['critic', '--ticket', 'ACME-1']);
  assert.equal(r.json.failure, 'usage');
  assert.match(r.json.detail, /--subject/);
});

test('the Workflow, Reviewer and Model placeholders are filled', { skip: fakesSkip }, (t) => {
  const b = box();
  after(t, b);
  assert.equal(b.call({ lead: 'claude' }).status, 0);
  const p = b.reviews().at(-1).prompt;
  assert.match(p, /^Workflow: Bollplank \S+, build (\d+|unknown)( plus unmerged commits)?(, with uncommitted changes)?$/m);
  assert.match(p, /^Reviewer: Codex$/m);
  assert.match(p, /^Model: Unverified$/m);
  for (const k of ['{WORKFLOW}', '{REVIEWER}', '{MODEL}']) assert.equal(p.includes(k), false);
});

test('the posted Model line names the model that ran, whatever the critic wrote', { skip: fakesSkip }, (t) => {
  const b = box();
  after(t, b);
  for (const lead of ['claude', 'codex']) {
    const r = b.call({ lead, ticket: lead === 'claude' ? 'ACME-1' : 'ACME-2' });
    assert.equal(r.status, 0);
    assert.notEqual(r.json.model, 'Unverified');
    assert.equal(r.json.text.split('\n').find((l) => l.startsWith('Model:')), `Model: ${r.json.model}`);
    assert.match(r.json.model, /, effort unverified$/);
    assert.equal(r.json.model.split(', ').length, 2);
    assert.equal(/^Model: fake$/m.test(r.json.text), false);
  }
});

test('the shipped prompts carry every placeholder and forbid posting and editing', () => {
  for (const f of ['critic.md', 'critic-same.md']) {
    const text = readFileSync(new URL(`../prompts/${f}`, import.meta.url), 'utf8');
    for (const p of ['{TICKET}', '{ROUND}', '{SUBJECT}', '{SUBJECT_SHORT}', '{DATE}', '{ROUND_NOTE}', '{REVIEWER}', '{MODEL}', '{WORKFLOW}', '{BODY}']) assert.ok(text.includes(p), `${f} ${p}`);
    assert.match(text, /Do not post the critique anywhere/);
    assert.match(text, /Do not create, edit or delete any file/);
    assert.match(text, /Reply with the critique only/);
    assert.equal(/[\u2013\u2014;]/.test(text), false, `${f} has a dash or semicolon`);
  }
});

for (const critic of ['claude', 'codex']) {
  const lead = critic === 'claude' ? 'codex' : 'claude';
  const failures = [
    ['timeout', 'timeout'],
    ['client-error', 'client-error'],
    ['no-result', 'exit'],
    ['exit-after-review', 'exit'],
    ['malformed', 'malformed-answer'],
    ['empty', 'empty-answer'],
  ];
  for (const [mode, failure] of failures) {
    test(`${critic}: ${mode} fails as ${failure}, writes no state and still binds the session`, { skip: fakesSkip }, (t) => {
      const b = box();
      after(t, b);
      const r = b.call({ lead, timeout: mode === 'timeout' ? 1 : undefined }, { FAKE_MODE: mode });
      assert.equal(r.status, 1, r.stdout);
      assert.equal(r.json.ok, false);
      assert.equal(r.json.failure, failure);
      assert.equal(r.json.critic, critic);
      assert.equal(b.state(`ACME-1.${critic}.json`), null);
      if (mode === 'client-error') assert.match(r.json.detail, /usage limit/);
      if (mode === 'no-result') assert.match(r.json.detail, /synthetic crash/);
      if (mode === 'exit-after-review') {
        assert.equal(r.json.receivedReview.verdict, 'Approve');
        assert.match(r.json.receivedReview.text, /^Critique of ACME-1/);
        assert.equal(r.json.receivedReview.round, 1);
      } else assert.equal(r.json.receivedReview, undefined);
      const [entry] = b.bindings();
      assert.ok(entry, 'a binding was written');
      assert.equal(entry.ticket, 'ACME-1');
      assert.equal(entry.tool, critic);
      assert.equal(entry.session, r.json.sessionId);
      assert.equal(entry.subject, 'brief');
      assert.equal(entry.round, 1);
      assert.ok(entry.at);
      // The failed round leaves round 1 open.
      const retry = b.call({ lead });
      assert.equal(retry.status, 0, retry.stdout);
      assert.equal(retry.json.round, 1);
    });
  }
}

test('a resumed round that fails keeps the saved session and count', { skip: fakesSkip }, (t) => {
  const b = box();
  after(t, b);
  const first = b.call({ lead: 'codex' });
  assert.equal(first.status, 0);
  const saved = b.state('ACME-1.claude.json');
  const r = b.call({ lead: 'codex', round: 2, timeout: 1 }, { FAKE_MODE: 'timeout' });
  assert.equal(r.json.failure, 'timeout');
  assert.equal(r.json.sessionId, saved.sessionId);
  assert.deepEqual(b.state('ACME-1.claude.json'), saved);
  assert.equal(b.bindings().length, 2);
});

test('a ledger that cannot be written never fails the call', { skip: fakesSkip }, (t) => {
  const b = box();
  after(t, b);
  writeFileSync(join(b.s.bollplank, 'ledger'), 'a file where the folder should be');
  const r = b.call({ lead: 'claude' });
  assert.equal(r.status, 0, r.stdout);
});

// A critic that used or was given a tool beyond the allowed reads: no state, a binding, no text.
const toolCases = [
  ['claude', 'tool-use', /called the tool mcp__acme__search/],
  ['claude', 'init-mcp', /started 1 MCP server/],
  ['claude', 'init-tools', /offered the tools Bash, mcp__acme__search/],
  ['codex', 'tool-use', /called the MCP tool acme_search/],
  ['codex', 'web-search', /used a web_search item/],
];
for (const [critic, mode, detail] of toolCases) {
  test(`${critic}: ${mode} fails as critic-used-tools, keeps no state and never returns the text`, { skip: fakesSkip }, (t) => {
    const b = box();
    after(t, b);
    const lead = critic === 'claude' ? 'codex' : 'claude';
    const r = b.call({ lead }, { FAKE_MODE: mode, FAKE_TEXT: 'Critique of ACME-1 brief v1\nVerdict: Approve\nAcme secret answer' });
    assert.equal(r.status, 1, r.stdout);
    assert.equal(r.json.failure, 'critic-used-tools');
    assert.match(r.json.detail, detail);
    assert.equal(r.stdout.includes('Acme secret answer'), false);
    assert.equal(r.json.text, undefined);
    assert.equal(r.json.receivedReview, undefined);
    assert.equal(b.state(`ACME-1.${critic}.json`), null);
    const [entry] = b.bindings();
    assert.ok(entry?.session, 'the session is bound for the ledger');
    assert.equal(entry.session, r.json.sessionId);
  });
}

test('codex: the critic is not started when its MCP servers cannot all be switched off', { skip: fakesSkip }, (t) => {
  const b = box();
  after(t, b);
  for (const [mode, extra, detail] of [['mcp-fails', {}, /did not list its MCP servers/], ['mcp-stays-on', {}, /still lists an MCP server as enabled/], ['ok', { FAKE_CODEX_MCP: 'acme.files' }, /cannot be switched off/]]) {
    const r = b.call({ lead: 'claude' }, { FAKE_MODE: mode, ...extra });
    assert.equal(r.json.failure, 'critic-unavailable', mode);
    assert.match(r.json.detail, detail);
  }
  assert.deepEqual(b.reviews(), []);
  assert.equal(b.state('ACME-1.codex.json'), null);
  const lists = b.captures().filter((c) => c.args[0] === 'mcp');
  assert.ok(lists.every((c) => c.args.includes('--json') && c.args.includes('model_provider="openai"') && c.args.includes('apps')));
  const none = b.call({ lead: 'claude' }, { FAKE_CODEX_MCP: '' });
  assert.equal(none.status, 0, none.stdout);
  assert.equal(b.reviews().at(-1).args.some((a) => a.startsWith('mcp_servers.')), false);
});

test('the header is the wrapper\'s: wrong lines are rewritten and missing ones inserted in order', { skip: fakesSkip }, (t) => {
  const b = box({ critic: { providers: { claude: { model: 'claude-acme', effort: 'high' } } } });
  after(t, b);
  const reply = 'Critique of ACME-1 brief v1\nModel: guessed, low\nDate: 2026-11-02\nVerdict: Revise\n\nModel: a quoted line in the body stays.';
  const r = b.call({ lead: 'codex' }, { FAKE_TEXT: reply });
  assert.equal(r.status, 0, r.stdout);
  const lines = r.json.text.split('\n');
  assert.equal(lines[0], 'Critique of ACME-1 brief v1');
  assert.equal(lines[1], 'Reviewer: Claude Code');
  assert.equal(lines[2], 'Model: claude-acme, high');
  assert.match(lines[3], /^Workflow: Bollplank /);
  assert.equal(lines[4], 'Date: 2026-11-02');
  assert.ok(lines.includes('Model: a quoted line in the body stays.'));
  assert.equal(r.json.model, 'claude-acme, high');
  const header = 'Critique of ACME-1 brief v1\nWorkflow: made up\nReviewer: made up\nVerdict: Approve';
  const again = b.call({ lead: 'codex', round: 2 }, { FAKE_TEXT: header });
  const top = again.json.text.split('\n');
  assert.deepEqual(top.slice(0, 2), ['Critique of ACME-1 brief v1', 'Workflow: ' + lines[3].slice(10)]);
  // Model goes after Reviewer, the line before it in the order.
  assert.equal(top[2], 'Reviewer: Claude Code');
  assert.equal(top[3], 'Model: claude-acme, high');
});

test('an unverified model is posted as Unverified, and a pinned one is never doubled', { skip: fakesSkip }, (t) => {
  const b = box({ critic: { providers: { codex: { effort: 'high' }, claude: { model: 'claude-acme', effort: 'max' } } } });
  after(t, b);
  const codexRun = b.call({ lead: 'claude' }, { FAKE_MODE: 'no-model' });
  assert.equal(codexRun.status, 0, codexRun.stdout);
  assert.equal(codexRun.json.model, 'Unverified');
  assert.ok(codexRun.json.text.split('\n').includes('Model: Unverified'));
  const claudeRun = b.call({ lead: 'codex' }, { FAKE_MODE: 'no-model' });
  assert.equal(claudeRun.json.model, 'claude-acme, max');
  const ran = b.call({ lead: 'codex', round: 2 });
  assert.equal(ran.json.model, 'claude-acme, max');
  assert.ok(ran.json.text.split('\n').includes('Model: claude-acme, max'));
});

for (const critic of ['claude', 'codex']) {
  const lead = critic === 'claude' ? 'codex' : 'claude';
  test(`${critic}: a session the client lost fails clearly, and --new-session recovers it with the counts kept`, { skip: fakesSkip }, (t) => {
    const b = box();
    after(t, b);
    assert.equal(b.call({ lead }).status, 0);
    const saved = b.state(`ACME-1.${critic}.json`);
    const lost = b.call({ lead, round: 2 }, { FAKE_MODE: 'resume-missing' });
    assert.equal(lost.json.failure, 'session-missing', lost.stdout);
    assert.match(lost.json.detail, /no longer has the critic session/);
    assert.match(lost.json.detail, /--new-session/);
    assert.deepEqual(b.state(`ACME-1.${critic}.json`), saved);
    const fresh = b.call({ lead, round: 2, newSession: true }, { FAKE_MODE: 'resume-missing' });
    assert.equal(fresh.status, 0, fresh.stdout);
    assert.equal(fresh.json.sessionRestarted, true);
    assert.notEqual(fresh.json.sessionId, saved.sessionId);
    assert.deepEqual(b.state(`ACME-1.${critic}.json`), { sessionId: fresh.json.sessionId, rounds: { brief: 2, plan: 0, code: 0 } });
    const call = b.reviews().at(-1);
    if (critic === 'claude') assert.equal(call.args.includes('--resume'), false);
    else assert.equal(call.args.includes('resume'), false);
    const next = b.call({ lead, subject: 'plan' });
    assert.equal(next.json.sessionId, fresh.json.sessionId);
    assert.equal(next.json.sessionRestarted, undefined);
  });
}

test('a second call for the same ticket, provider and mode fails as critic-busy and runs nothing', { skip: fakesSkip }, (t) => {
  const b = box();
  after(t, b);
  const lock = join(b.s.bollplank, 'critics', 'ACME-1.codex.json.lock');
  mkdirSync(lock, { recursive: true });
  const r = b.call({ lead: 'claude' });
  assert.equal(r.status, 1);
  assert.equal(r.json.failure, 'critic-busy');
  assert.ok(r.json.detail.includes(lock));
  assert.deepEqual(b.captures(), []);
  // Another ticket or another mode is not blocked.
  assert.equal(b.call({ lead: 'claude', ticket: 'ACME-2' }).status, 0);
  assert.equal(b.call({ lead: 'codex' }).status, 0);
  rmSync(lock, { recursive: true });
  const ok = b.call({ lead: 'claude' });
  assert.equal(ok.status, 0, ok.stdout);
  assert.equal(existsSync(lock), false, 'the lock is released');
  const failed = b.call({ lead: 'claude', round: 2 }, { FAKE_MODE: 'malformed' });
  assert.equal(failed.json.failure, 'malformed-answer');
  assert.equal(existsSync(lock), false, 'the lock is released after a failure');
  assert.deepEqual(readdirSync(join(b.s.bollplank, 'critics')).filter((n) => n.includes('.tmp')), []);
});

test('a missing provider is reported before a round mismatch, and a mismatch starts no client', { skip: fakesSkip }, (t) => {
  const b = box({ clients: ['claude'] });
  after(t, b);
  const r = b.call({ lead: 'claude', round: 3 });
  assert.equal(r.json.failure, 'critic-unavailable');
  assert.deepEqual(b.captures(), []);
  const mismatch = b.call({ lead: 'codex', round: 3 });
  assert.equal(mismatch.json.failure, 'round-mismatch');
  assert.deepEqual(b.captures(), []);
});
