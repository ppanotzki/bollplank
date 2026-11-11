// The Codex provider. It finds the CLI, reads its sign in and runs one critique turn with
// `codex exec` and JSON events, in a read only sandbox with no network and no approvals, signed in
// with ChatGPT only, with no ChatGPT connectors and no other tool but a read only shell. A critic for
// an issue also keeps its board's MCP servers, to work the board: on Linear with all their tools, on
// Jira with its two read tools only. Every other
// MCP server is off, and a call without an issue, the doctor's dry run, has none at all.
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { expand, paths } from '../paths.mjs';
import { BOARDS } from '../boards.mjs';
import { innerCall, isOfficialUrl, JIRA_CRITIC_INNER, JIRA_CRITIC_TOOLS, PROBES, timedOut } from '../setup/probe.mjs';

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
  if (r.status !== 0 || /not logged in/i.test(out)) return { signedIn: false, subscription: false, method: null, detail: 'Codex is not signed in.' };
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

// The sandbox of a critique turn, on top of --sandbox read-only: Codex never asks for approval, so
// nothing can escalate out of the sandbox, and a shell command has no network. Checked against the
// config keys of 0.166.0-alpha.5.1. No flag that bypasses approvals or the sandbox is ever passed.
const SANDBOX = ['-c', 'approval_policy="never"', '-c', 'sandbox_workspace_write.network_access=false'];

// The event items a critique may hold. A command runs in the read only sandbox. An MCP tool call
// counts only when it goes to one of the critic's board servers. Anything else, another MCP server,
// a connector call, a file change, a web search or a sub agent, ends the turn.
export const ALLOWED_ITEMS = ['agent_message', 'reasoning', 'command_execution', 'todo_list', 'error', 'mcp_tool_call'];

// What to do when the critic's Codex has no Linear server, the same fix the probe gives.
export const LINEAR_FIX = BOARDS.linear.fix.codex;

// Whether an event item is one the critic may hold, given the board servers it kept. only limits
// the board's tools, as on Jira: only.tools names the tools and only.inner the inner tools each
// execute tool may run. Without it every tool of a kept server is allowed, as on Linear.
export function allowedItem(item, linear = [], only = null) {
  if (!ALLOWED_ITEMS.includes(item?.type)) return false;
  if (item.type !== 'mcp_tool_call') return true;
  if (!linear.includes(item.server) || item.connector_id || item.connector_name) return false;
  if (!only) return true;
  if (!only.tools.includes(item.tool)) return false;
  const inner = only.inner?.[item.tool];
  return !inner || inner.includes(innerCall(item.arguments).tool);
}

// One critique turn. A sessionId resumes that thread, otherwise Codex starts one and names it in
// its first event. The working folder is readDir when given, else cwd. The prompt goes on stdin.
// Every MCP server Codex lists for that folder is switched off by name first, and the list is read
// again to confirm it. `-c mcp_servers={}` does not do this, since an override is merged into the
// configured servers rather than replacing them. With issue, the board's servers stay on. On Linear
// those are the servers whose names say Linear, with all their tools, read and write, and their
// tools run without an approval request, so the critic can read the issue and post its critique. On
// Jira they are the servers whose URL is one of Atlassian's official ones, never a server by its
// name alone, with enabled_tools set to getJiraIssue and executeRead only and no approve mode, so
// approval_policy never refuses any write as well. The critic is reply only there, and an executeRead
// of any inner tool but listJiraIssueComments ends the turn. A board server that is not signed in is
// switched off like the others. No signed in board server left fails before any model turn.
// Connectors stay off, so Codex reaches the board only through its MCP server. Every board call
// comes back in calls, on every outcome, so the wrapper can tell whether the critic read the issue
// and posted on it.
export function review({ bin, prompt, sessionId, model, effort, readDir, cwd, issue, board = 'linear', timeoutMs = 600000, env = process.env }) {
  const work = readDir ?? cwd;
  if (issue && !BOARDS[board]) return Promise.resolve({ ok: false, failure: 'critic-unavailable', detail: `Bollplank has no critic for a ${board} board.`, sessionId, calls: [] });
  const jira = issue && board !== 'linear';
  const isBoard = (s) => (jira ? isOfficialUrl(board, serverUrl(s)) : isLinearServer(s?.name));
  const label = issue ? BOARDS[board].label : '';
  const keep = issue
    ? {
        pick: (s) => isBoard(s) && s.enabled !== false && s.auth_status !== 'not_logged_in',
        tools: jira ? JIRA_CRITIC_TOOLS : null,
        approve: !jira,
        none: jira
          ? `Codex has no ${PROBES[board].server} MCP server switched on at ${BOARDS[board].server.urls.join(' or ')}, so the critic cannot read the issue. A server with another URL is not used, whatever its name, and ${label} through a ChatGPT connector is not used, since connectors stay off.`
          : 'Codex has no Linear MCP server switched on, so the critic cannot read the issue or post its critique. Linear through a ChatGPT connector is not used, since connectors stay off.',
      }
    : null;
  const off = isolate(bin, env, work, keep);
  if (!off.ok) {
    const signedOut = off.none ? (off.listed ?? []).filter((s) => isBoard(s) && s.enabled !== false && s.auth_status === 'not_logged_in').map((s) => s.name) : [];
    if (signedOut.length) return Promise.resolve({ ok: false, failure: 'critic-unavailable', detail: `Codex has the ${label} MCP server ${signedOut.join(', ')} but is not signed in to it.`, fix: `Run \`codex mcp login ${signedOut[0]}\`, which opens a browser.`, sessionId, calls: [] });
    return Promise.resolve({ ok: false, failure: 'critic-unavailable', detail: off.detail, ...(off.none ? { fix: BOARDS[board].fix.codex } : {}), sessionId, calls: [] });
  }
  const only = jira ? { tools: JIRA_CRITIC_TOOLS, inner: JIRA_CRITIC_INNER } : null;
  const linear = off.kept ?? [];
  // exec level flags go before `resume`, which does not take --sandbox or --cd.
  const execFlags = ['--json', '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', work];
  const pin = [...PIN, ...SANDBOX, ...off.flags];
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
      const item = ev.map((e) => e.item).find((i) => i && !allowedItem(i, linear, only));
      if (!item) return;
      child.kill('SIGTERM');
      const inner = item.type === 'mcp_tool_call' && only?.inner?.[item.tool] ? ` of ${String(innerCall(item.arguments).tool ?? 'no named tool').slice(0, 80)}` : '';
      const kind = item.type === 'mcp_tool_call' ? `called the MCP tool ${String(item.server ?? 'unnamed').slice(0, 40)}/${String(item.tool ?? 'unnamed').slice(0, 80)}${inner}` : `used a ${String(item.type ?? 'unknown').slice(0, 40)} item`;
      finish({ ok: false, failure: 'critic-used-tools', detail: `Codex ${kind}, which the critic is not allowed. The reply was not used.`, sessionId: sessionId ?? ev.find((e) => e.type === 'thread.started')?.thread_id, calls: boardCalls(ev) });
    });
    child.stderr.on('data', (d) => (err += d));
    child.stdin.on('error', (e) => (err += e.message + '\n'));
    child.on('error', (e) => finish({ ok: false, failure: 'exit', detail: `Codex did not start: ${e.message}`, sessionId, calls: boardCalls(events(out)) }));
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      const ev = events(out);
      finish({ ok: false, failure: 'timeout', detail: `no answer after ${timeoutMs / 1000} seconds`, sessionId: sessionId ?? ev.find((e) => e.type === 'thread.started')?.thread_id, calls: boardCalls(ev) });
    }, timeoutMs);
    child.on('close', (code, signal) => {
      if (settled) return;
      const ev = events(out);
      const session = sessionId ?? ev.find((e) => e.type === 'thread.started')?.thread_id;
      const text = ev.filter((e) => e.type === 'item.completed' && e.item?.type === 'agent_message').map((e) => e.item.text ?? '').pop() ?? '';
      const usage = ev.filter((e) => e.type === 'turn.completed').map((e) => e.usage ?? null).pop() ?? null;
      const failed = ev.filter((e) => e.type === 'turn.failed' || e.type === 'error').pop();
      const calls = boardCalls(ev);
      // A thread that never started and has no session file is gone, whatever the wording.
      const gone = (detail) => sessionId && !text.trim() && (MISSING_SESSION.test(`${err}\n${detail}`) || (!ev.some((e) => e.type === 'thread.started') && !hasSession(sessionId, env)));
      if (failed && !text.trim()) {
        const detail = tail(String(failed.error?.message ?? failed.message ?? 'Codex reported an error'));
        if (gone(detail)) return finish(missingSession(sessionId, usage, code, signal));
        return finish({ ok: false, failure: 'client-error', detail, sessionId: session, usage, code, signal, calls });
      }
      if (code !== 0) {
        const detail = tail(err) || `Codex exited with code ${code ?? signal}.`;
        if (gone(detail)) return finish(missingSession(sessionId, usage, code, signal));
        return finish({ ok: false, failure: 'exit', detail, sessionId: session, usage, code, signal, calls, ...(text.trim() ? { text } : {}) });
      }
      finish({ ok: true, text, sessionId: session, model: sessionModel(session, env), usage, calls });
    });
    child.stdin.end(prompt);
  });
}

// The MCP tool calls of a turn, one per item id, as the last event about each showed it. A call
// is ok only when it completed with no error.
function boardCalls(ev) {
  const items = new Map();
  for (const e of ev) {
    if ((e.type !== 'item.started' && e.type !== 'item.completed') || e.item?.type !== 'mcp_tool_call') continue;
    const item = e.item;
    const failed = Boolean(item.error) || item.result?.is_error === true || item.result?.isError === true;
    items.set(item.id ?? `item-${items.size}`, {
      server: String(item.server ?? ''),
      tool: String(item.tool ?? ''),
      args: item.arguments ?? null,
      ok: e.type === 'item.completed' && item.status === 'completed' && !failed,
      text: item.error ? String(item.error.message ?? JSON.stringify(item.error)) : item.result == null ? '' : JSON.stringify(item.result),
    });
  }
  return [...items.values()];
}

// Codex says this, in one wording or another, when `exec resume` names a thread it does not have.
const MISSING_SESSION = /no (saved |matching )?(session|conversation|thread|rollout)[^\n]*found|(session|conversation|thread|rollout)[^\n]*(not found|does not exist)/i;

function missingSession(session, usage, code, signal) {
  return { ok: false, failure: 'session-missing', detail: `Codex no longer has the critic session ${session}. Retry with --new-session to start a fresh session. The saved round counts are kept.`, sessionId: session, usage, code, signal };
}

// Lists the MCP servers Codex would start in this folder, with the same pins, switches each one
// off by name and lists them again to confirm that none is left on. Names that a dotted -c path
// cannot carry are refused. Nothing here starts a model turn.
//
// With keep, the servers it picks stay on. With keep.tools, a kept server offers only the named
// tools: enabled_tools is Codex's allow list per server, so every other tool of a kept server is
// off. `codex mcp get --json` shows the list Codex will use, and it must equal the one asked for.
// Checked on 0.166.0-alpha.5.1, where `mcp get --json` reports enabled_tools and honours a -c
// override. With keep.tools null, as for a critic on the board, a kept server keeps all its tools.
// With keep.approve, a kept server's tools run without an approval request, since the critic runs
// with approval_policy never, which otherwise refuses a board write such as posting the comment.
// Only the kept Linear servers get it. Checked on 0.166.0-alpha.5.1, whose values are auto,
// prompt, writes and approve.
// signedOut names the kept servers whose auth_status says they are not signed in. When keep picks no
// server, listed is the list Codex gave, so the caller can tell why.
function isolate(bin, env, work, keep = null, who = 'the critic') {
  const run = (args, flags) => {
    const r = spawnSync(bin, [...args, ...PIN, ...flags], { env, cwd: work, encoding: 'utf8', timeout: 60000, maxBuffer: 1 << 24 });
    if (r.status !== 0) return null;
    try {
      return JSON.parse(r.stdout);
    } catch {
      return null;
    }
  };
  const list = (flags) => {
    const servers = run(['mcp', 'list', '--json'], flags);
    return Array.isArray(servers) ? servers : null;
  };
  const before = list([]);
  if (!before) return { ok: false, detail: `Codex did not list its MCP servers with \`codex mcp list --json\`, so ${who} cannot be started without them.` };
  const names = before.map((s) => s?.name);
  if (names.some((n) => typeof n !== 'string' || !/^[A-Za-z0-9_-]+$/.test(n))) return { ok: false, detail: `Codex has an MCP server whose name cannot be switched off with -c, so ${who} cannot be started without it.` };
  const kept = keep ? before.filter((s) => keep.pick(s)).map((s) => s.name) : [];
  if (keep && !kept.length) return { ok: false, none: true, detail: keep.none, listed: before };
  const tools = keep?.tools ? `[${keep.tools.map((t) => JSON.stringify(t)).join(',')}]` : null;
  const flags = names.flatMap((n) => (kept.includes(n) ? [...(tools ? ['-c', `mcp_servers.${n}.enabled_tools=${tools}`] : []), ...(keep.approve ? ['-c', `mcp_servers.${n}.default_tools_approval_mode="approve"`] : [])] : ['-c', `mcp_servers.${n}.enabled=false`]));
  if (!names.length) return { ok: true, flags };
  const after = list(flags);
  if (!after || after.some((s) => (kept.includes(s?.name) ? s?.enabled === false : s?.enabled !== false))) return { ok: false, detail: `Codex still lists an MCP server as enabled after switching each one off, so ${who} cannot be started without it.` };
  for (const n of tools ? kept : []) {
    const got = run(['mcp', 'get', n, '--json'], flags)?.enabled_tools;
    if (!Array.isArray(got) || got.length !== keep.tools.length || got.some((t, i) => t !== keep.tools[i])) return { ok: false, detail: `Codex did not confirm that the MCP server ${n} offers only ${keep.tools.join(', ')}, so ${who} cannot be started with it.` };
  }
  const signedOut = after.filter((s) => kept.includes(s?.name) && s?.auth_status === 'not_logged_in').map((s) => s.name);
  return { ok: true, flags, kept, signedOut };
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

// Whether a server's name says Linear as a whole word, so nonlinear-solver is not a Linear server.
export function isLinearServer(name) {
  return typeof name === 'string' && /(^|[^a-z])linear([^a-z]|$)/i.test(name);
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

// The board probe for setup and doctor, per board kind. One ephemeral `codex exec` with the critic's
// isolation: a read only sandbox, signed in with ChatGPT only, connectors (apps), plugins and the
// other tool features off, and every MCP server off except the board's configured servers, which
// offer only the probe's tools (PROBES[kind].codexTools). For Linear those are the servers whose
// names say Linear. For Jira they are the servers whose URL is one of Atlassian's official ones,
// never a server by its name alone. A board through a ChatGPT connector is never used, since a
// connector cannot be narrowed to read tools. Its JSON events show every tool call, so a call that
// never happened cannot pass, and any call that is not a board read fails it.
export function probeBoard(kind, { bin, env = process.env, timeoutMs = 120000, cwd, target } = {}) {
  const probe = PROBES[kind];
  if (!probe) return { ok: false, detail: `Bollplank has no probe for a ${kind} board.` };
  const dir = cwd ?? paths().neutral;
  mkdirSync(dir, { recursive: true });
  const keep = kind === 'linear'
    ? {
        pick: (s) => isLinearServer(s?.name) && s.enabled !== false,
        tools: probe.codexTools,
        none: 'Codex has no Linear MCP server switched on. Linear through a ChatGPT connector cannot be narrowed to read tools, so the probe does not use it. Add the Linear MCP server to Codex, which `bollplank init` offers.',
      }
    : {
        pick: (s) => isOfficialUrl(kind, serverUrl(s)) && s.enabled !== false,
        tools: probe.codexTools,
        none: `Codex has no ${probe.server} MCP server switched on at ${BOARDS[kind].server.urls.join(' or ')}. A server with another URL is not used, whatever its name, and ${probe.label} through a ChatGPT connector cannot be narrowed to read tools. Add the ${probe.server} MCP server to Codex, which \`bollplank init\` offers.`,
      };
  const off = isolate(bin, env, dir, keep, `the ${probe.label} probe`);
  if (!off.ok) return { ok: false, needsServer: Boolean(off.none), detail: off.detail };
  // A board server that is not signed in can never answer, so say how to sign in instead of
  // spending a model turn on it.
  let listed = [];
  try {
    listed = JSON.parse(spawnSync(bin, ['mcp', 'list', '--json'], { env, cwd: dir, encoding: 'utf8', timeout: 60000 }).stdout);
  } catch {}
  const signedOut = (Array.isArray(listed) ? listed : []).filter((s) => keep.pick(s) && s.auth_status === 'not_logged_in').map((s) => s.name);
  if (signedOut.length) return { ok: false, needsLogin: true, detail: `Codex has the ${probe.server} MCP server ${signedOut.join(', ')} but is not signed in to it. Run \`codex mcp login ${signedOut[0]}\`, which opens a browser.` };
  const argv = ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '--cd', dir, ...PIN, ...off.flags, '-'];
  const r = spawnSync(bin, argv, { env, cwd: dir, input: probe.prompt(target), encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1 << 26 });
  const ev = events(`${r.stdout ?? ''}`);
  // Every item that is not a message, reasoning, a todo list or an error is a tool call, started
  // or completed, and the judge fails any that is not a board read.
  const items = new Map();
  for (const e of ev) {
    if ((e.type !== 'item.started' && e.type !== 'item.completed') || !e.item || PROBE_TEXT_ITEMS.includes(e.item.type)) continue;
    const item = e.item;
    const call = item.type === 'mcp_tool_call'
      ? {
          name: [item.server, item.tool, item.connector_name, item.connector_id].filter((s) => typeof s === 'string' && s).join('/'),
          ok: e.type === 'item.completed' && item.status === 'completed' && !item.error,
          text: item.error ? String(item.error.message ?? JSON.stringify(item.error)) : item.result == null ? '' : JSON.stringify(item.result),
          args: item.arguments ?? null,
        }
      : { name: String(item.type ?? 'unknown'), ok: false, text: '' };
    items.set(item.id ?? `item-${items.size}`, call);
  }
  const calls = [...items.values()];
  const ctx = { servers: off.kept ?? [], space: Boolean(target?.spaces?.length) };
  if (r.error?.code === 'ETIMEDOUT') return timedOut('Codex', calls, timeoutMs, kind, ctx);
  const reply = ev.filter((e) => e.type === 'item.completed' && e.item?.type === 'agent_message').map((e) => e.item.text ?? '').pop() ?? '';
  if (!ev.length) return { ok: false, retry: true, detail: tail(`${r.stderr ?? ''}`) || 'Codex closed without any events.' };
  return probe.judge('Codex', calls, reply, ctx);
}

// The Linear probe, as before the board kinds.
export function probeLinear(opts) {
  return probeBoard('linear', opts);
}

// A server's URL as `codex mcp list --json` and `codex mcp get --json` report it. Codex 0.166 puts
// it in transport.url for a streamable HTTP server. A top level url is read too. Assumed from the
// shape of those commands, checked on 10 November 2026.
export function serverUrl(s) {
  const u = s?.transport?.url ?? s?.url;
  return typeof u === 'string' ? u : null;
}

// The event items of a probe that are not tool calls.
const PROBE_TEXT_ITEMS = ['agent_message', 'reasoning', 'todo_list', 'error'];

// Adds the board kind's remote MCP server, then signs in to it, which opens a browser. Flags checked
// with `codex mcp get --help`, `codex mcp add --help` and `codex mcp login --help` on
// 0.166.0-alpha.5.1. A server of that name that is already there is signed in to and kept. For Jira
// such a server must already point at an official Atlassian URL, or nothing is changed. For a server
// that signs in with OAuth, `codex mcp add` runs the sign in itself, so the add can end by the
// timeout while the person is still in the browser. The server is then there but not signed in, and
// the message says so and names `codex mcp login`.
export function addBoardMcp(kind, { bin, env = process.env, url, stdio = 'inherit', addTimeoutMs = 300000 } = {}) {
  const board = BOARDS[kind];
  if (!board) return { ok: false, detail: `Bollplank has no MCP server for a ${kind} board.` };
  const name = board.server.name;
  const label = PROBES[kind].server;
  const at = url ?? board.server.urls[0];
  // Only an official URL is ever added, whoever the caller is.
  if (!board.server.urls.includes(at)) return { ok: false, detail: `Bollplank adds the ${label} MCP only at ${board.server.urls.join(' or ')}, not at ${at}.` };
  const got = spawnSync(bin, ['mcp', 'get', name, '--json'], { env, encoding: 'utf8', timeout: 60000 });
  const existed = got.status === 0;
  if (existed && kind !== 'linear') {
    let s = null;
    try {
      s = JSON.parse(got.stdout);
    } catch {}
    if (!isOfficialUrl(kind, serverUrl(s))) return { ok: false, detail: `Codex already has a server named ${name} that does not point at ${board.server.urls.join(' or ')}. Bollplank left it as it is. Remove it with \`codex mcp remove ${name}\`, then run \`bollplank init\` again.` };
  }
  if (!existed) {
    const add = spawnSync(bin, ['mcp', 'add', name, '--url', at], { env, stdio, timeout: addTimeoutMs });
    if (add.error?.code === 'ETIMEDOUT' || (add.status === null && add.signal === 'SIGTERM')) {
      const now = spawnSync(bin, ['mcp', 'get', name, '--json'], { env, encoding: 'utf8', timeout: 60000 });
      const n = Math.max(1, Math.round(addTimeoutMs / 60000));
      const minutes = `${n} minute${n === 1 ? '' : 's'}`;
      if (now.status === 0) return { ok: false, added: true, needsLogin: true, detail: `Codex has the ${label} MCP now, but its sign in did not finish within ${minutes}. Run \`codex mcp login ${name}\`, then run \`bollplank init\` again.` };
      return { ok: false, detail: `codex mcp add did not finish within ${minutes}, and Codex has no server named ${name}. Run \`codex mcp add ${name} --url ${at}\`, then run \`bollplank init\` again.` };
    }
    if (add.status !== 0) return { ok: false, detail: `codex mcp add failed with exit ${add.status ?? add.signal}. Run \`codex mcp add ${name} --url ${at}\` to see why.` };
  }
  const login = spawnSync(bin, ['mcp', 'login', name], { env, stdio });
  if (login.status !== 0) return { ok: false, added: !existed, detail: `The ${label} sign in did not finish. Run \`codex mcp login ${name}\` and try again.` };
  return { ok: true, added: !existed, detail: existed ? `Codex already had a server named ${name}. It is signed in now.` : `Codex has the ${label} MCP and is signed in to it.` };
}

// Adds Linear's remote MCP server, as before the board kinds.
export function addLinearMcp(opts) {
  return addBoardMcp('linear', opts);
}
