// The critic command and both providers, against fake claude and codex programs on a PATH that
// holds nothing else. No test runs a real client, reads a real sign in or makes a model call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { sandbox, acmeConfig, fakesSkip } from './helpers.mjs';
import * as claude from '../lib/providers/claude.mjs';
import * as codex from '../lib/providers/codex.mjs';
import { get, other, childEnv, providers } from '../lib/providers/index.mjs';

const CRITIQUE = 'Critique of ACME-1 brief v1\\nReviewer: fake\\nModel: fake\\nVerdict: Approve\\n\\nNo material points.';

const FAKE_CLAUDE = `
const fs = require('node:fs');
const args = process.argv.slice(2);
const mode = process.env.FAKE_MODE || 'ok';
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(ANTHROPIC_|OPENAI_|CODEX_|CLAUDE_|AWS_|AZURE_|ACME_)/.test(k)));
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
emit({ type: 'system', subtype: 'init', session_id: session, claude_code_version: 'fake' });
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const prompt = JSON.parse(line).message.content;
  record({ prompt });
  if (mode === 'timeout') return;
  if (mode === 'client-error') return emit({ type: 'result', subtype: 'error', is_error: true, result: 'synthetic usage limit reached', session_id: session });
  if (mode === 'no-result') { process.stderr.write('synthetic crash\\n'); process.exit(4); }
  const text = mode === 'malformed' ? 'Here is my review.\\nVerdict: Approve' : mode === 'empty' ? '' : '${CRITIQUE}';
  emit({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: session, modelUsage: { [model + '-20261101']: {} }, usage: { input_tokens: 12, output_tokens: 34 } });
  if (mode === 'exit-after-review') process.exitCode = 9;
});
`;

const FAKE_CODEX = `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const mode = process.env.FAKE_MODE || 'ok';
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(ANTHROPIC_|OPENAI_|CODEX_|CLAUDE_|AWS_|AZURE_|ACME_)/.test(k)));
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
if (args[0] !== 'exec') process.exit(2);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  record({ prompt: input });
  const emit = (e) => process.stdout.write(JSON.stringify(e) + '\\n');
  const resumed = args.includes('resume');
  const id = resumed ? args[args.length - 2] : require('node:crypto').randomUUID();
  emit({ type: 'thread.started', thread_id: id });
  emit({ type: 'turn.started' });
  if (mode === 'timeout') { setInterval(() => {}, 1000); return; }
  if (mode === 'client-error') { emit({ type: 'turn.failed', error: { message: 'synthetic usage limit reached' } }); process.exit(1); }
  if (mode === 'no-result') { process.stderr.write('synthetic crash\\n'); process.exit(4); }
  const text = mode === 'malformed' ? 'Here is my review.\\nVerdict: Approve' : mode === 'empty' ? '' : '${CRITIQUE}';
  emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } });
  emit({ type: 'turn.completed', usage: { input_tokens: 12, cached_input_tokens: 0, output_tokens: 34 } });
  const m = args.indexOf('-m') >= 0 ? args[args.indexOf('-m') + 1] : 'gpt-acme-default';
  const effort = (args.find((a) => a.startsWith('model_reasoning_effort=')) || '').match(/"(.*)"/)?.[1] ?? null;
  const dir = path.join(process.env.CODEX_HOME, 'sessions', '2026', '11', '02');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'rollout-2026-11-02-' + id + '.jsonl'), JSON.stringify({ type: 'turn_context', payload: { model: m, effort } }) + '\\n');
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
    const { subject = 'brief', round = 1, lead = 'claude', critic: c, readDir, timeout, promptFile = prompt, ticket = 'ACME-1' } = opts;
    const args = ['critic', '--ticket', ticket, '--subject', subject, '--round', String(round), '--prompt-file', promptFile, '--lead', lead];
    if (c) args.push('--critic', c);
    if (readDir) args.push('--read-dir', readDir);
    if (timeout) args.push('--timeout', String(timeout));
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

test('the child environment loses every key and provider route and nothing else', () => {
  const env = childEnv({ ANTHROPIC_API_KEY: 'x', ANTHROPIC_BASE_URL: 'x', OPENAI_API_KEY: 'x', CODEX_API_KEY: 'x', CODEX_ACCESS_TOKEN: 'x', CLAUDE_CODE_USE_BEDROCK: '1', AWS_BEARER_TOKEN_BEDROCK: 'x', AZURE_OPENAI_API_KEY: 'x', CODEX_HOME: '/h', CLAUDE_CONFIG_DIR: '/c', AWS_PROFILE: 'acme', HOME: '/home', PATH: '/bin' });
  assert.deepEqual(Object.keys(env).sort(), ['AWS_PROFILE', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HOME', 'PATH']);
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

test('claude: read-dir adds the real folder and denies shell and edit tools, otherwise neither', { skip: fakesSkip }, (t) => {
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
    assert.equal(argAfter(c.args, '--tools'), 'Read,Grep,Glob');
    assert.equal(c.args.includes('--dangerously-skip-permissions'), false);
    assert.equal(realpathSync(c.cwd), realpathSync(join(b.s.bollplank, 'neutral')));
  }
  assert.equal(first.args.includes('--add-dir'), false);
  assert.equal(first.args.includes('--disallowedTools'), false);
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
  const keys = { ANTHROPIC_API_KEY: 'sk-acme-1', OPENAI_API_KEY: 'sk-acme-2', CODEX_API_KEY: 'sk-acme-3', CODEX_ACCESS_TOKEN: 'acme', CLAUDE_CODE_USE_BEDROCK: '1', AWS_BEARER_TOKEN_BEDROCK: 'acme', AZURE_OPENAI_API_KEY: 'acme', ACME_KEEP: 'kept' };
  for (const lead of ['claude', 'codex']) assert.equal(b.call({ lead, ticket: `ACME-${lead === 'claude' ? 2 : 3}` }, keys).status, 0);
  const calls = b.captures();
  assert.ok(calls.length >= 4);
  for (const c of calls) {
    for (const k of Object.keys(keys).filter((k) => k !== 'ACME_KEEP')) assert.equal(c.env[k], undefined, `${k} reached ${c.tool} ${c.args[0]}`);
    assert.equal(c.env.ACME_KEEP, 'kept');
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
