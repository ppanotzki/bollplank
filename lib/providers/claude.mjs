// The Claude Code provider. It finds the CLI, reads its sign in and runs one critique turn in print
// mode with stream JSON in and out. The critic gets no tools, or read tools inside its source folder
// only, no MCP servers, no claude.ai connectors and no settings beyond the local ones of its neutral folder.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { expand, paths } from '../paths.mjs';
import { judge, LINEAR_PROBE_PROMPT, READ_VERBS } from '../setup/probe.mjs';

export const name = 'claude';
export const label = 'Claude Code';
// The CLI version every flag below was checked against with `claude --help`.
export const testedVersion = '2.1.312';

const READ_TOOLS = 'Read,Grep,Glob';
const NO_WRITE_TOOLS = 'Bash,Edit,Write,NotebookEdit,PowerShell';

// A PATH search in Node, then the desktop app's bundled copies, newest first.
export function resolve(env = process.env) {
  return onPath('claude', env) ?? bundled(env);
}

export function version(bin, env = process.env) {
  const r = spawnSync(bin, ['--version'], { env, encoding: 'utf8', timeout: 15000 });
  if (r.status !== 0) return null;
  return r.stdout.match(/\d+\.\d+\.\d+[\w.+-]*/)?.[0] ?? (r.stdout.trim() || null);
}

// `claude auth status --json` reports loggedIn, authMethod, apiProvider and subscriptionType.
// Only a first party claude.ai sign in with a subscription counts as a subscription.
export function signInStatus(bin, env = process.env) {
  const r = spawnSync(bin, ['auth', 'status', '--json'], { env, encoding: 'utf8', timeout: 15000 });
  let s = null;
  try {
    s = JSON.parse(r.stdout);
  } catch {}
  // A client that cannot start, or prints something else, has not reported a sign in.
  if (!s || typeof s !== 'object') return { signedIn: false, subscription: false, method: null, detail: 'Claude Code did not report its sign in. Run `claude auth status`.' };
  const signedIn = s.loggedIn === true;
  const method = s.authMethod ?? null;
  const firstParty = (s.apiProvider ?? 'firstParty') === 'firstParty';
  const subscription = signedIn && firstParty && method === 'claude.ai' && typeof s.subscriptionType === 'string' && s.subscriptionType !== '';
  let detail;
  if (!signedIn) detail = 'Claude Code is not signed in. Run `claude auth login` with a Claude subscription.';
  else if (subscription) detail = `Claude Code is signed in with a ${s.subscriptionType} subscription.`;
  else if (!firstParty) detail = `Claude Code is routed through ${s.apiProvider}, not a Claude subscription.`;
  else detail = `Claude Code is signed in with ${method ?? 'an unknown method'}, not a Claude subscription.`;
  return { signedIn, subscription, method, detail };
}

// One critique turn. A sessionId resumes that session, otherwise a fresh session gets a new id.
// The prompt goes in as one stream JSON user message and stdin closes once the result arrives.
// Without readDir the critic has no tools at all, since the whole subject is in the prompt. With
// readDir it has Read, Grep and Glob, allowed only inside that folder. MCP servers from settings
// and claude.ai connectors are both switched off. The event stream is checked as well: an MCP server
// in the init event, or any other tool offered or called, ends the turn as critic-used-tools.
export function review({ bin, prompt, sessionId, model, effort, readDir, cwd, timeoutMs = 600000, env = process.env }) {
  const resumed = Boolean(sessionId);
  const session = sessionId ?? randomUUID();
  const allowed = readDir ? READ_TOOLS.split(',') : [];
  const argv = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--setting-sources', 'local', '--strict-mcp-config', '--permission-prompts', 'none', '--tools', allowed.join(',')];
  if (readDir) argv.push('--allowedTools', readRule(readDir), '--add-dir', readDir, '--disallowedTools', NO_WRITE_TOOLS);
  if (model) argv.push('--model', model);
  if (effort) argv.push('--effort', effort);
  argv.push(...(resumed ? ['--resume', session] : ['--session-id', session]));

  return new Promise((done) => {
    let settled = false;
    let result = null;
    let used = null;
    let buffer = '';
    let err = '';
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(r);
    };
    const child = spawn(bin, argv, { env: { ...env, ENABLE_CLAUDEAI_MCP_SERVERS: 'false' }, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => (err += d));
    child.stdin.on('error', (e) => (err += e.message + '\n'));
    child.on('error', (e) => finish({ ok: false, failure: 'exit', detail: `Claude Code did not start: ${e.message}`, sessionId: resumed ? session : undefined }));
    const onEvent = (event, closing) => {
      if (!used) used = toolsUsed(event, allowed);
      if (used) {
        child.kill('SIGTERM');
        return finish({ ok: false, failure: 'critic-used-tools', detail: `Claude Code ${used}, which the critic is not allowed. The reply was not used.`, sessionId: event?.session_id ?? session });
      }
      if (event?.type !== 'result') return;
      result = event;
      if (!closing) child.stdin.end();
    };
    child.stdout.on('data', (d) => {
      buffer += d;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        onEvent(parseLine(line), false);
      }
    });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ ok: false, failure: 'timeout', detail: `no result after ${timeoutMs / 1000} seconds`, sessionId: session });
    }, timeoutMs);
    child.on('close', (code, signal) => {
      if (buffer.trim()) onEvent(parseLine(buffer), true);
      if (settled) return;
      const reported = result?.session_id ?? session;
      const usage = result?.usage ?? null;
      const gone = (detail) => resumed && (MISSING_SESSION.test(`${err}\n${detail}`) || (!result && !hasSession(session, env)));
      if (result?.is_error) {
        const detail = tail(String(result.result ?? result.subtype ?? 'Claude Code reported an error'));
        if (gone(detail)) return finish(missingSession(session, usage, code, signal));
        return finish({ ok: false, failure: 'client-error', detail, sessionId: reported, usage, code, signal });
      }
      const text = typeof result?.result === 'string' ? result.result : '';
      if (code !== 0 || !result) {
        const detail = tail(err) || (result ? `Claude Code exited with code ${code ?? signal} after its result.` : 'Claude Code closed without a result.');
        if (gone(detail)) return finish(missingSession(session, usage, code, signal));
        return finish({ ok: false, failure: 'exit', detail, sessionId: reported, usage, code, signal, ...(text.trim() ? { text } : {}) });
      }
      finish({ ok: true, text, sessionId: reported, model: modelLine(result.modelUsage, model, effort), usage });
    });
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n');
  });
}

// Claude Code says this when --resume names a session it does not have.
const MISSING_SESSION = /no conversation found|session[^\n]*(not found|does not exist)/i;

function missingSession(session, usage, code, signal) {
  return { ok: false, failure: 'session-missing', detail: `Claude Code no longer has the critic session ${session}. Retry with --new-session to start a fresh session. The saved round counts are kept.`, sessionId: session, usage, code, signal };
}

// What the event shows the critic was given or used beyond the allowed read tools, or null.
function toolsUsed(event, allowed) {
  if (event?.type === 'system' && event.subtype === 'init') {
    const servers = Array.isArray(event.mcp_servers) ? event.mcp_servers : [];
    if (servers.length) return `started ${servers.length} MCP server${servers.length === 1 ? '' : 's'}`;
    const extra = (Array.isArray(event.tools) ? event.tools : []).filter((t) => !allowed.includes(t));
    if (extra.length) return `offered the tools ${extra.slice(0, 5).join(', ')}`;
  }
  if (event?.type === 'assistant' && Array.isArray(event.message?.content)) {
    const call = event.message.content.find((c) => c?.type === 'tool_use' && !allowed.includes(c.name));
    if (call) return `called the tool ${String(call.name ?? 'unnamed').slice(0, 80)}`;
  }
  return null;
}

// A path scoped allow rule. Claude Code reads a rule path that starts with // as absolute.
function readRule(dir) {
  const p = dir.replace(/\\/g, '/').replace(/\/+$/, '');
  return `Read(/${p.startsWith('/') ? p : `/${p}`}/**)`;
}

// Whether Claude Code still keeps a session, as <config dir>/projects/<folder>/<id>.jsonl.
export function hasSession(id, env = process.env) {
  for (const root of sessionRoots(env)) {
    let folders;
    try {
      folders = readdirSync(root);
    } catch {
      continue;
    }
    if (folders.some((f) => existsSync(join(root, f, `${id}.jsonl`)))) return true;
  }
  return false;
}

// Claude Code keeps its sessions under <config dir>/projects.
export function sessionRoots(env = process.env) {
  return [join(expand(env.CLAUDE_CONFIG_DIR) ?? join(env.HOME || homedir(), '.claude'), 'projects')];
}

// The model the session ran, from the result's modelUsage, with the effort it was given. A pinned
// model counts only when it ran. Null when nothing is known.
// The model that did the review, as Claude Code reported it: the pinned one when it ran, otherwise
// the model that wrote the most, since helper models can appear in modelUsage too. A pin that did
// not run is never named as if it had.
function modelLine(modelUsage, model, effort) {
  const usage = modelUsage ?? {};
  const ran = Object.keys(usage);
  if (!ran.length) return null;
  const out = (m) => usage[m]?.outputTokens ?? 0;
  const seen = (model && ran.find((m) => m.startsWith(model))) ?? [...ran].sort((a, b) => out(b) - out(a))[0];
  const line = `${seen}, ${effort ?? 'effort unverified'}`;
  return model && !seen.startsWith(model) ? `${line} (asked for ${model})` : line;
}

function bundled(env) {
  const root = join(env.HOME || homedir(), 'Library', 'Application Support', 'Claude', 'claude-code');
  const found = [];
  try {
    for (const v of readdirSync(root)) {
      const vdir = join(root, v);
      if (!statSync(vdir).isDirectory()) continue;
      for (const h of readdirSync(vdir)) {
        const p = join(vdir, h, 'claude.app', 'Contents', 'MacOS', 'claude');
        if (existsSync(p)) found.push([v, p]);
      }
    }
  } catch {}
  const parts = (v) => v.split('.').map((n) => Number.parseInt(n, 10) || 0);
  found.sort((a, b) => parts(a[0]).reduce((r, n, i) => r || n - (parts(b[0])[i] ?? 0), 0));
  return found.length ? found[found.length - 1][1] : null;
}

function onPath(cmd, env) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  const dirs = (key ? env[key] : '').split(delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  for (const d of dirs) {
    for (const ext of exts) {
      const p = join(d, cmd + ext);
      try {
        if (!statSync(p).isFile()) continue;
        if (process.platform !== 'win32') accessSync(p, constants.X_OK);
        return p;
      } catch {}
    }
  }
  return null;
}

function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function tail(s) {
  return s.split('\n').filter((l) => l.trim()).slice(-3).join('\n').slice(0, 400);
}

// The Linear probe for setup and doctor. Claude Code lists its MCP servers, account connectors
// included, with `claude mcp list`. Only the read tools of servers whose names say Linear are
// allowed for this one headless call, every built in tool is removed, and anything else is denied
// before it can run: --permission-mode dontAsk denies whatever is not allowed, --permission-prompts
// none answers no prompt, and --setting-sources local drops the user and project settings, so an
// allow rule or a default mode there cannot let another tool through. The neutral folder has no
// local settings. Other MCP servers still load, since --strict-mcp-config would also drop the
// claude.ai Linear connector, which is an account connector and cannot be passed in --mcp-config.
// Their tools are denied, and judge() fails a probe that called any of them. Nothing is saved as a
// session.
export function probeLinear({ bin, env = process.env, timeoutMs = 120000, cwd }) {
  const list = spawnSync(bin, ['mcp', 'list'], { env, cwd: probeDir(cwd), encoding: 'utf8', timeout: 60000 });
  const servers = linearServers(`${list.stdout ?? ''}`);
  if (!servers.length) return { ok: false, detail: 'Claude Code lists no Linear MCP server or connector in `claude mcp list`.' };
  // Only the server's read tools are allowed, by the verbs that start their names. Claude Code takes
  // wildcards in these rules. judge() also fails a probe that called any other tool.
  const rules = servers.flatMap((s) => READ_VERBS.flatMap((v) => ['', 'linear_'].map((p) => `mcp__${s.replace(/[^A-Za-z0-9_-]/g, '_')}__${p}${v}*`)));
  const argv = ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--setting-sources', 'local', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--tools', '', '--allowedTools', rules.join(',')];
  const r = spawnSync(bin, argv, { env, cwd: probeDir(cwd), input: LINEAR_PROBE_PROMPT, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1 << 26 });
  if (r.error?.code === 'ETIMEDOUT') return { ok: false, detail: `Claude Code did not finish the Linear probe in ${timeoutMs / 1000} seconds.` };
  const events = `${r.stdout ?? ''}`.split('\n').map(parseLine).filter(Boolean);
  // Every tool call counts, with or without a result, so a denied or unanswered call is judged too.
  const uses = new Map();
  for (const e of events) {
    const content = Array.isArray(e.message?.content) ? e.message.content : [];
    for (const c of content) {
      if (e.type === 'assistant' && c.type === 'tool_use') uses.set(c.id, { name: c.name ?? '', ok: false, text: '' });
      if (e.type === 'user' && c.type === 'tool_result' && uses.has(c.tool_use_id)) Object.assign(uses.get(c.tool_use_id), { ok: c.is_error !== true, text: resultText(c.content) });
    }
  }
  const calls = [...uses.values()];
  const result = events.filter((e) => e.type === 'result').pop();
  if (!result && !calls.length) return { ok: false, detail: tail(`${r.stderr ?? ''}`) || 'Claude Code closed without a result.' };
  return judge('Claude Code', calls, typeof result?.result === 'string' ? result.result : '');
}

// Adds Linear's remote MCP server at user scope, then signs in to it, which opens a browser.
// Flags checked with `claude mcp get --help`, `claude mcp add --help` and `claude mcp login --help`
// on 2.1.312. A server named linear that is already there is signed in to and kept.
export function addLinearMcp({ bin, env = process.env, url, stdio = 'inherit' }) {
  const existed = spawnSync(bin, ['mcp', 'get', 'linear'], { env, encoding: 'utf8', timeout: 60000 }).status === 0;
  if (!existed) {
    const add = spawnSync(bin, ['mcp', 'add', '--transport', 'http', '--scope', 'user', 'linear', url], { env, encoding: 'utf8', timeout: 60000 });
    if (add.status !== 0) return { ok: false, detail: `claude mcp add failed: ${tail(`${add.stdout ?? ''}\n${add.stderr ?? ''}`) || `exit ${add.status ?? add.signal}`}` };
  }
  const login = spawnSync(bin, ['mcp', 'login', 'linear'], { env, stdio });
  if (login.status !== 0) return { ok: false, added: !existed, detail: 'The Linear sign in did not finish. Run `claude mcp login linear` and try again.' };
  return { ok: true, added: !existed, detail: existed ? 'Claude Code already had a server named linear. It is signed in now.' : 'Claude Code has the Linear MCP at user scope and is signed in to it.' };
}

// `claude mcp list` prints one server per line as "<name>: <url or command> - <state>".
function linearServers(text) {
  return [...new Set(text.split('\n').map((l) => l.match(/^\s*([^:\s][^:]*?):\s+\S/)?.[1]).filter((n) => n && /linear/i.test(n)))];
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c?.text === 'string' ? c.text : JSON.stringify(c ?? ''))).join('\n');
  return content == null ? '' : JSON.stringify(content);
}

function probeDir(cwd) {
  const dir = cwd ?? paths().neutral;
  mkdirSync(dir, { recursive: true });
  return dir;
}
