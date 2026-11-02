// The Codex provider. It finds the CLI, reads its sign in and runs one critique turn with
// `codex exec` and JSON events, in a read only sandbox, signed in with ChatGPT only, with no MCP
// servers, no ChatGPT connectors and no other tool but a read only shell.
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { expand, paths } from '../paths.mjs';
import { judge, LINEAR_PROBE_PROMPT } from '../setup/probe.mjs';

export const name = 'codex';
export const label = 'Codex';
// The CLI version every flag below was checked against with `codex exec --help`.
export const testedVersion = '0.166.0-alpha.5.1';

// A PATH search in Node, then the copy the ChatGPT desktop app bundles. BOLLPLANK_APPS_DIR stands in
// for /Applications so tests never find the real app.
export function resolve(env = process.env) {
  const found = onPath('codex', env);
  if (found) return found;
  const apps = expand(env.BOLLPLANK_APPS_DIR) ?? '/Applications';
  const p = join(apps, 'ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'bin', 'codex');
  return isExecutable(p) ? p : null;
}

export function version(bin, env = process.env) {
  const r = spawnSync(bin, ['--version'], { env, encoding: 'utf8', timeout: 15000 });
  if (r.status !== 0) return null;
  return r.stdout.match(/\d+\.\d+\.\d+[\w.+-]*/)?.[0] ?? (r.stdout.trim() || null);
}

// `codex login status` prints "Logged in using ChatGPT" for a subscription sign in. Any other
// sign in, such as an API key, is reported and never used. The raw output is not passed on,
// since a key based status can include part of the key.
export function signInStatus(bin, env = process.env) {
  const r = spawnSync(bin, ['login', 'status'], { env, encoding: 'utf8', timeout: 15000 });
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  if (r.status !== 0 || /not logged in/i.test(out)) return { signedIn: false, subscription: false, method: null, detail: 'Codex is not signed in. Run `codex login` with a ChatGPT subscription.' };
  if (/Logged in using ChatGPT/i.test(out)) return { signedIn: true, subscription: true, method: 'chatgpt', detail: 'Codex is signed in with ChatGPT.' };
  if (/Logged in using an? API key/i.test(out)) return { signedIn: true, subscription: false, method: 'api-key', detail: 'Codex is signed in with an API key, not a ChatGPT subscription.' };
  if (/^\s*Logged in/im.test(out)) return { signedIn: true, subscription: false, method: 'other', detail: 'Codex is signed in, but not with ChatGPT.' };
  return { signedIn: false, subscription: false, method: null, detail: 'Codex did not report a sign in. Run `codex login status`.' };
}

// The flags that keep the critic on the ChatGPT subscription and away from everything but a read
// only shell. A profile or provider in config.toml cannot move it onto a key. Each feature below is
// a way out of the sandbox or a source of tools: ChatGPT connectors (apps), plugins and their MCP
// servers, browsers, computer use, image generation, sub agents, memories, tool suggestions, hooks
// and skill installs. Checked with `codex features list` on 0.166.0-alpha.5.1, which errors on an
// unknown feature, so a renamed one fails loudly instead of staying on.
const NO_TOOLS = ['apps', 'plugins', 'remote_plugin', 'browser_use', 'browser_use_external', 'computer_use', 'in_app_browser', 'image_generation', 'multi_agent', 'memories', 'tool_suggest', 'hooks', 'skill_mcp_dependency_install'];
const PIN = ['-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"', '-c', 'web_search="disabled"', ...NO_TOOLS.flatMap((f) => ['--disable', f])];

// The event items a critique may hold. A command runs in the read only sandbox. Anything else, an
// MCP or connector call, a file change, a web search or a sub agent, ends the turn.
const ALLOWED_ITEMS = ['agent_message', 'reasoning', 'command_execution', 'todo_list', 'error'];

// One critique turn. A sessionId resumes that thread, otherwise Codex starts one and names it in
// its first event. The working folder is readDir when given, else cwd. The prompt goes on stdin.
// Every MCP server Codex lists for that folder is switched off by name first, and the list is read
// again to confirm it. `-c mcp_servers={}` does not do this, since an override is merged into the
// configured servers rather than replacing them.
export function review({ bin, prompt, sessionId, model, effort, readDir, cwd, timeoutMs = 600000, env = process.env }) {
  const work = readDir ?? cwd;
  const off = isolate(bin, env, work);
  if (!off.ok) return Promise.resolve({ ok: false, failure: 'critic-unavailable', detail: off.detail, sessionId });
  // exec level flags go before `resume`, which does not take --sandbox or --cd.
  const execFlags = ['--json', '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', work];
  const pin = [...PIN, ...off.flags];
  if (model) pin.push('-m', model);
  if (effort) pin.push('-c', `model_reasoning_effort="${effort}"`);
  const argv = sessionId ? ['exec', ...execFlags, 'resume', ...pin, sessionId, '-'] : ['exec', ...execFlags, ...pin, '-'];

  return new Promise((done) => {
    let settled = false;
    let out = '';
    let err = '';
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(r);
    };
    const child = spawn(bin, argv, { env, cwd: work, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      out += d;
      const ev = events(out);
      const item = ev.map((e) => e.item).find((i) => i && !ALLOWED_ITEMS.includes(i.type));
      if (!item) return;
      child.kill('SIGTERM');
      const kind = item.type === 'mcp_tool_call' ? `called the MCP tool ${String(item.tool ?? 'unnamed').slice(0, 80)}` : `used a ${String(item.type ?? 'unknown').slice(0, 40)} item`;
      finish({ ok: false, failure: 'critic-used-tools', detail: `Codex ${kind}, which the critic is not allowed. The reply was not used.`, sessionId: sessionId ?? ev.find((e) => e.type === 'thread.started')?.thread_id });
    });
    child.stderr.on('data', (d) => (err += d));
    child.stdin.on('error', (e) => (err += e.message + '\n'));
    child.on('error', (e) => finish({ ok: false, failure: 'exit', detail: `Codex did not start: ${e.message}`, sessionId }));
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ ok: false, failure: 'timeout', detail: `no answer after ${timeoutMs / 1000} seconds`, sessionId: sessionId ?? events(out).find((e) => e.type === 'thread.started')?.thread_id });
    }, timeoutMs);
    child.on('close', (code, signal) => {
      if (settled) return;
      const ev = events(out);
      const session = sessionId ?? ev.find((e) => e.type === 'thread.started')?.thread_id;
      const text = ev.filter((e) => e.type === 'item.completed' && e.item?.type === 'agent_message').map((e) => e.item.text ?? '').pop() ?? '';
      const usage = ev.filter((e) => e.type === 'turn.completed').map((e) => e.usage ?? null).pop() ?? null;
      const failed = ev.filter((e) => e.type === 'turn.failed' || e.type === 'error').pop();
      // A thread that never started and has no session file is gone, whatever the wording.
      const gone = (detail) => sessionId && !text.trim() && (MISSING_SESSION.test(`${err}\n${detail}`) || (!ev.some((e) => e.type === 'thread.started') && !hasSession(sessionId, env)));
      if (failed && !text.trim()) {
        const detail = tail(String(failed.error?.message ?? failed.message ?? 'Codex reported an error'));
        if (gone(detail)) return finish(missingSession(sessionId, usage, code, signal));
        return finish({ ok: false, failure: 'client-error', detail, sessionId: session, usage, code, signal });
      }
      if (code !== 0) {
        const detail = tail(err) || `Codex exited with code ${code ?? signal}.`;
        if (gone(detail)) return finish(missingSession(sessionId, usage, code, signal));
        return finish({ ok: false, failure: 'exit', detail, sessionId: session, usage, code, signal, ...(text.trim() ? { text } : {}) });
      }
      finish({ ok: true, text, sessionId: session, model: sessionModel(session, env), usage });
    });
    child.stdin.end(prompt);
  });
}

// Codex says this, in one wording or another, when `exec resume` names a thread it does not have.
const MISSING_SESSION = /no (saved |matching )?(session|conversation|thread|rollout)[^\n]*found|(session|conversation|thread|rollout)[^\n]*(not found|does not exist)/i;

function missingSession(session, usage, code, signal) {
  return { ok: false, failure: 'session-missing', detail: `Codex no longer has the critic session ${session}. Retry with --new-session to start a fresh session. The saved round counts are kept.`, sessionId: session, usage, code, signal };
}

// Lists the MCP servers Codex would start in this folder, with the same pins, switches each one
// off by name and lists them again to confirm that none is left on. Names that a dotted -c path
// cannot carry are refused. Nothing here starts a model turn.
function isolate(bin, env, work) {
  const list = (flags) => {
    const r = spawnSync(bin, ['mcp', 'list', '--json', ...PIN, ...flags], { env, cwd: work, encoding: 'utf8', timeout: 60000, maxBuffer: 1 << 24 });
    if (r.status !== 0) return null;
    try {
      const servers = JSON.parse(r.stdout);
      return Array.isArray(servers) ? servers : null;
    } catch {
      return null;
    }
  };
  const before = list([]);
  if (!before) return { ok: false, detail: 'Codex did not list its MCP servers with `codex mcp list --json`, so the critic cannot be started without them.' };
  const names = before.map((s) => s?.name);
  if (names.some((n) => typeof n !== 'string' || !/^[A-Za-z0-9_-]+$/.test(n))) return { ok: false, detail: 'Codex has an MCP server whose name cannot be switched off with -c, so the critic cannot be started without it.' };
  const flags = names.flatMap((n) => ['-c', `mcp_servers.${n}.enabled=false`]);
  if (!names.length) return { ok: true, flags };
  const after = list(flags);
  if (!after || after.some((s) => s?.enabled !== false)) return { ok: false, detail: 'Codex still lists an MCP server as enabled after switching each one off, so the critic cannot be started without it.' };
  return { ok: true, flags };
}

// Whether Codex still keeps a thread, as a session file under <codex home>/sessions.
export function hasSession(id, env = process.env) {
  return Boolean(id) && sessionRoots(env).some((root) => findFile(root, id));
}

// Codex keeps its sessions under <codex home>/sessions.
export function sessionRoots(env = process.env) {
  return [join(expand(env.CODEX_HOME) ?? join(env.HOME || homedir(), '.codex'), 'sessions')];
}

// The model and effort the thread really ran, from the last turn_context of its session file.
// Null when nothing is known.
function sessionModel(id, env) {
  if (!id) return null;
  for (const root of sessionRoots(env)) {
    const file = findFile(root, id);
    if (!file) continue;
    try {
      const ctx = readFileSync(file, 'utf8').split('\n').map(parseLine).filter((e) => e?.type === 'turn_context').pop();
      if (ctx?.payload?.model) return `${ctx.payload.model}, ${ctx.payload.effort ?? 'effort unverified'}`;
    } catch {}
  }
  return null;
}

// Session folders are dated, so the newest names are searched first.
function findFile(dir, id) {
  let names;
  try {
    names = readdirSync(dir).sort().reverse();
  } catch {
    return null;
  }
  for (const n of names) {
    const p = join(dir, n);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      const f = findFile(p, id);
      if (f) return f;
    } else if (n.includes(id)) return p;
  }
  return null;
}

function events(out) {
  return out.split('\n').map(parseLine).filter(Boolean);
}

function isExecutable(p) {
  try {
    if (!statSync(p).isFile()) return false;
    if (process.platform !== 'win32') accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function onPath(cmd, env) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  const dirs = (key ? env[key] : '').split(delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  for (const d of dirs) for (const ext of exts) if (isExecutable(join(d, cmd + ext))) return join(d, cmd + ext);
  return null;
}

function parseLine(line) {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function tail(s) {
  return s.split('\n').filter((l) => l.trim() && !l.includes('failed to load skill')).slice(-3).join('\n').slice(0, 400);
}

// The Linear probe for setup and doctor. One ephemeral `codex exec` in a read only sandbox, signed
// in with ChatGPT only. Its JSON events show every MCP tool call with the server, the tool and the
// result, so a call that never happened cannot pass. Account connectors count as well as
// configured servers, since the tool is found by its Linear purpose in its names.
export function probeLinear({ bin, env = process.env, timeoutMs = 120000, cwd }) {
  const dir = cwd ?? paths().neutral;
  mkdirSync(dir, { recursive: true });
  const argv = ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '--cd', dir, '-c', 'forced_login_method="chatgpt"', '-'];
  const r = spawnSync(bin, argv, { env, cwd: dir, input: LINEAR_PROBE_PROMPT, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1 << 26 });
  if (r.error?.code === 'ETIMEDOUT') return { ok: false, detail: `Codex did not finish the Linear probe in ${timeoutMs / 1000} seconds.` };
  const ev = events(`${r.stdout ?? ''}`);
  const calls = ev
    .filter((e) => e.type === 'item.completed' && e.item?.type === 'mcp_tool_call')
    .map(({ item }) => ({
      name: [item.server, item.tool, item.connector_name, item.connector_id].filter((s) => typeof s === 'string' && s).join('/'),
      ok: item.status === 'completed' && !item.error,
      text: item.error ? String(item.error.message ?? JSON.stringify(item.error)) : item.result == null ? '' : JSON.stringify(item.result),
    }));
  const reply = ev.filter((e) => e.type === 'item.completed' && e.item?.type === 'agent_message').map((e) => e.item.text ?? '').pop() ?? '';
  if (!ev.length) return { ok: false, detail: tail(`${r.stderr ?? ''}`) || 'Codex closed without any events.' };
  return judge('Codex', calls, reply);
}

// Adds Linear's remote MCP server, then signs in to it, which opens a browser. Flags checked with
// `codex mcp get --help`, `codex mcp add --help` and `codex mcp login --help` on 0.166.0-alpha.5.1.
// A server named linear that is already there is signed in to and kept.
export function addLinearMcp({ bin, env = process.env, url, stdio = 'inherit' }) {
  const existed = spawnSync(bin, ['mcp', 'get', 'linear', '--json'], { env, encoding: 'utf8', timeout: 60000 }).status === 0;
  if (!existed) {
    const add = spawnSync(bin, ['mcp', 'add', 'linear', '--url', url], { env, stdio, timeout: 300000 });
    if (add.status !== 0) return { ok: false, detail: `codex mcp add failed with exit ${add.status ?? add.signal}. Run \`codex mcp add linear --url ${url}\` to see why.` };
  }
  const login = spawnSync(bin, ['mcp', 'login', 'linear'], { env, stdio });
  if (login.status !== 0) return { ok: false, added: !existed, detail: 'The Linear sign in did not finish. Run `codex mcp login linear` and try again.' };
  return { ok: true, added: !existed, detail: existed ? 'Codex already had a server named linear. It is signed in now.' : 'Codex has the Linear MCP and is signed in to it.' };
}
