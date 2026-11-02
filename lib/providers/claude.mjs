// The Claude Code provider. It finds the CLI, reads its sign in and runs one critique turn in print
// mode with stream JSON in and out. A critic for an issue works the board through the tools of its
// Linear MCP servers and connectors, with read tools inside its source folder only, no shell, no
// file edits, no web and no other MCP server. A call without an issue, the doctor's dry run, gets no
// board, no MCP servers, no claude.ai connectors and no settings beyond the local ones.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve as resolvePath, sep } from 'node:path';
import { claudeDir, expand, paths } from '../paths.mjs';
import { SCRUB } from './index.mjs';
import { isReadTool, judge, LINEAR_MCP_URL, LINEAR_PROBE_PROMPT, READ_VERBS, toolPart } from '../setup/probe.mjs';

export const name = 'claude';
export const label = 'Claude Code';
// The CLI version every flag below was checked against with `claude --help`.
export const testedVersion = '2.1.312';

const READ_TOOLS = 'Read,Grep,Glob';
const NO_WRITE_TOOLS = 'Bash,Edit,Write,NotebookEdit,PowerShell';
// What a critic on the board is denied by name, since the user's settings load with it.
const BOARD_DENY = 'Bash,Edit,Write,NotebookEdit,PowerShell,WebFetch,WebSearch,Task';
// Claude Code defers MCP tools behind ToolSearch, so a critic on the board keeps it.
const TOOL_SEARCH = 'ToolSearch';

// What to do when the critic's Claude Code has no Linear server, the same fix the probe gives.
export const LINEAR_FIX = `Run \`bollplank init\` to add the Linear MCP, or run \`claude mcp add --transport http --scope user linear ${LINEAR_MCP_URL}\` and then \`claude mcp login linear\`.`;

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
// With issue, the critic works the board. Claude Code lists its servers with `claude mcp list`, as
// the probe does, and the tools of every server or connector whose name says Linear are allowed,
// read and write. Every other server is denied by name, and so are the shell, file edits, the web
// and sub agents. --setting-sources local and --strict-mcp-config are not used, since they hide the
// claude.ai Linear connector, so the user's settings load and the deny rules carry the restriction:
// a deny rule wins over any allow rule. --permission-mode dontAsk denies whatever is not allowed.
// Since the user's settings load, they are read first, and the critic does not run when they set a
// key or a provider route, or let it read outside its folder (criticSettings). No usable Linear
// server, one that is connected or whose state is not shown, fails before any model turn. Without
// issue, the critic has no MCP servers, no claude.ai connectors and only the local settings of its
// neutral folder. Either way, with readDir it also has Read, Grep and Glob, allowed only inside that
// folder. The event stream is checked: an MCP server in the init event that is neither Linear nor
// denied by name, any other tool offered or called, or a Read, Grep or Glob call that names a path
// outside readDir ends the turn as critic-used-tools. A server denied by name may start, since its
// deny rule hides its tools, as long as none of them is offered. Every Linear call comes back in
// calls, on every outcome, so the wrapper can tell whether the critic read the issue and posted on it.
export function review({ bin, prompt, sessionId, model, effort, readDir, cwd, issue, timeoutMs = 600000, env = process.env }) {
  const resumed = Boolean(sessionId);
  const session = sessionId ?? randomUUID();
  let rules;
  if (issue) {
    const risky = criticSettings(settingsFiles(env, cwd), readDir, env.HOME || homedir());
    if (!risky.ok) return Promise.resolve({ ok: false, failure: 'critic-unavailable', detail: risky.detail, fix: risky.fix, sessionId, calls: [] });
    rules = boardRules(bin, env, cwd);
    if (!rules.ok) return Promise.resolve({ ok: false, failure: 'critic-unavailable', detail: rules.detail, fix: rules.fix ?? LINEAR_FIX, sessionId, calls: [] });
  }
  const reads = readDir ? READ_TOOLS.split(',') : [];
  const builtIn = issue ? [...reads, TOOL_SEARCH] : reads;
  const argv = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
  if (issue) {
    const allow = [...(readDir ? [readRule(readDir)] : []), TOOL_SEARCH, ...rules.linear.map((id) => `mcp__${id}__*`)];
    const deny = [...BOARD_DENY.split(','), ...rules.deny];
    argv.push('--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--tools', builtIn.join(','), '--allowedTools', allow.join(','), '--disallowedTools', deny.join(','));
    if (readDir) argv.push('--add-dir', readDir);
  } else {
    argv.push('--setting-sources', 'local', '--strict-mcp-config', '--permission-prompts', 'none', '--tools', builtIn.join(','));
    if (readDir) argv.push('--allowedTools', readRule(readDir), '--add-dir', readDir, '--disallowedTools', NO_WRITE_TOOLS);
  }
  if (model) argv.push('--model', model);
  if (effort) argv.push('--effort', effort);
  argv.push(...(resumed ? ['--resume', session] : ['--session-id', session]));
  const allowed = { builtIn, linear: issue ? rules.linear : [], denied: issue ? rules.denied : [], readDir: readDir ?? null, cwd, home: env.HOME || homedir() };
  // With the board, Claude Code waits for its MCP servers before the turn. A claude.ai connector
  // connects in the background by default and can drop out of a headless turn, so the critic would
  // find no Linear tool. A value the user set is kept.
  const childEnvironment = issue
    ? { ...env, MCP_CONNECTION_NONBLOCKING: env.MCP_CONNECTION_NONBLOCKING ?? '0', MCP_CONNECT_TIMEOUT_MS: env.MCP_CONNECT_TIMEOUT_MS ?? '15000', CLAUDE_CODE_MCP_STARTUP_WAIT_MS: env.CLAUDE_CODE_MCP_STARTUP_WAIT_MS ?? '15000' }
    : { ...env, ENABLE_CLAUDEAI_MCP_SERVERS: 'false' };

  return new Promise((done) => {
    let settled = false;
    let result = null;
    let used = null;
    let buffer = '';
    let err = '';
    // Every Linear tool call by its id, with its result once one arrives.
    const uses = new Map();
    const calls = () => [...uses.values()];
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(r);
    };
    const child = spawn(bin, argv, { env: childEnvironment, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => (err += d));
    child.stdin.on('error', (e) => (err += e.message + '\n'));
    child.on('error', (e) => finish({ ok: false, failure: 'exit', detail: `Claude Code did not start: ${e.message}`, sessionId: resumed ? session : undefined, calls: calls() }));
    const onEvent = (event, closing) => {
      if (!used) used = toolsUsed(event, allowed);
      if (used) {
        child.kill('SIGTERM');
        return finish({ ok: false, failure: 'critic-used-tools', detail: `Claude Code ${used}, which the critic is not allowed. The reply was not used.`, sessionId: event?.session_id ?? session, calls: calls() });
      }
      track(event, uses);
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
      finish({ ok: false, failure: 'timeout', detail: `no result after ${timeoutMs / 1000} seconds`, sessionId: session, calls: calls() });
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
        return finish({ ok: false, failure: 'client-error', detail, sessionId: reported, usage, code, signal, calls: calls() });
      }
      const text = typeof result?.result === 'string' ? result.result : '';
      if (code !== 0 || !result) {
        const detail = tail(err) || (result ? `Claude Code exited with code ${code ?? signal} after its result.` : 'Claude Code closed without a result.');
        if (gone(detail)) return finish(missingSession(session, usage, code, signal));
        return finish({ ok: false, failure: 'exit', detail, sessionId: reported, usage, code, signal, calls: calls(), ...(text.trim() ? { text } : {}) });
      }
      finish({ ok: true, text, sessionId: reported, model: modelLine(result.modelUsage, model, effort), usage, calls: calls() });
    });
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n');
  });
}

// The Linear servers a critic on the board may use, by the id in their tool names, and the deny
// rules for every other server `claude mcp list` shows. A Linear server that needs authentication
// or failed to connect is not usable and is denied like the others. No usable Linear server is not ok.
function boardRules(bin, env, cwd) {
  const list = spawnSync(bin, ['mcp', 'list'], { env, cwd, encoding: 'utf8', timeout: 60000 });
  const listed = mcpServerStates(`${list.stdout ?? ''}`);
  const all = listed.map((s) => s.name);
  const linearListed = listed.filter((s) => isLinearServer(s.name));
  if (!linearListed.length) return { ok: false, detail: 'Claude Code lists no Linear MCP server or connector in `claude mcp list`, so the critic cannot read the issue or post its critique.' };
  const servers = linearListed.filter((s) => s.usable).map((s) => s.name);
  if (!servers.length) {
    const [first] = linearListed;
    const named = linearListed.map((s) => `${s.name} (${s.state})`).join(', ');
    const fix = first.name.startsWith('claude.ai ') ? `Open /mcp in a Claude Code session and connect ${first.name}, then call the critic again.` : `Run \`claude mcp login ${first.name}\`, or open /mcp in a Claude Code session, then call the critic again.`;
    return { ok: false, detail: `Claude Code lists no usable Linear server: ${named}. The critic cannot read the issue or post its critique.`, fix };
  }
  const deny = denyOthers(all, servers);
  return { ok: true, linear: servers.map(toolId), deny, denied: deny.map((r) => r.slice('mcp__'.length)) };
}

// Whether a server's name says Linear as a whole word, so nonlinear-solver is not a Linear server.
export function isLinearServer(name) {
  return /(^|[^a-z])linear([^a-z]|$)/i.test(String(name ?? ''));
}

// The user setting keys that would move a critic onto a key or a provider route, or let it read
// outside its folder. Claude Code loads these settings for a critic on the board, so each file the
// probe reads is checked before the call: an env variable the environment scrub removes, an
// apiKeyHelper, an allow rule for Read, Grep or Glob that reaches outside readDir (or any such rule
// without readDir), and additionalDirectories. A file that exists but cannot be read as JSON fails
// closed, since its keys are unknown. Only the variable name or a rule's tool part is printed.
export function criticSettings(files, readDir, home) {
  const found = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') found.push({ file, unreadable: true });
      continue;
    }
    let s;
    try {
      s = JSON.parse(text);
    } catch {
      found.push({ file, unreadable: true });
      continue;
    }
    if (!s || typeof s !== 'object') continue;
    if (s.env && typeof s.env === 'object') for (const k of Object.keys(s.env)) if (SCRUB.test(k)) found.push({ file, key: `env.${k}` });
    if (s.apiKeyHelper != null && s.apiKeyHelper !== '') found.push({ file, key: 'apiKeyHelper' });
    const perms = s.permissions && typeof s.permissions === 'object' ? s.permissions : {};
    for (const rule of Array.isArray(perms.allow) ? perms.allow : []) {
      if (typeof rule !== 'string') continue;
      const tool = rule.split('(')[0].trim();
      if (!READ_TOOLS.split(',').includes(tool)) continue;
      const spec = rule.match(/^[^(]*\((.*)\)\s*$/s)?.[1];
      if (!readDir || !ruleInside(spec, readDir, home)) found.push({ file, key: 'permissions.allow', tool });
    }
    const extra = perms.additionalDirectories;
    if (Array.isArray(extra) ? extra.length : extra) found.push({ file, key: 'permissions.additionalDirectories' });
  }
  if (!found.length) return { ok: true };
  const what = found.map((f) => (f.unreadable ? `${f.file} cannot be read as JSON` : f.tool ? `a ${f.tool} rule under permissions.allow in ${f.file}` : `${f.key} in ${f.file}`));
  const fixes = found.map((f) => {
    if (f.unreadable) return `Make ${f.file} readable and valid JSON.`;
    if (f.tool && readDir) return `Narrow the ${f.tool} rule under permissions.allow in ${f.file} to ${readRule(readDir)}, or remove it.`;
    if (f.tool) return `Remove the ${f.tool} rule under permissions.allow from ${f.file}, or open its folder with --read-dir.`;
    return `Remove ${f.key} from ${f.file}.`;
  });
  return {
    ok: false,
    detail: `Your Claude Code settings load with the critic and could move it onto a key or a provider route, or let it read outside its folder: ${[...new Set(what)].join(', ')}. The critic did not run.`,
    fix: `${[...new Set(fixes)].join(' ')} Then call the critic again.`,
  };
}

// Whether a Read, Grep or Glob rule's path stays inside dir. Only an absolute rule path (//path) or
// one from home (~/path) is judged, and its part before the first wildcard must be dir or a path
// under it. A rule with no path, a relative path or a .. segment reaches outside.
function ruleInside(spec, dir, home) {
  if (spec == null) return false;
  let p = spec.trim().replace(/\\/g, '/');
  if (p.startsWith('//')) p = p.slice(1);
  else if (p.startsWith('~/')) p = `${home.replace(/\\/g, '/').replace(/\/+$/, '')}/${p.slice(2)}`;
  else return false;
  if (p.split('/').includes('..')) return false;
  const root = dir.replace(/\\/g, '/').replace(/\/+$/, '');
  const wild = p.search(/[*?[{]/);
  if (wild >= 0) return p.slice(0, wild).startsWith(`${root}/`);
  return p === root || p.startsWith(`${root}/`);
}

// The paths a Read, Grep or Glob call names that are outside readDir, the first one or null. A
// relative path is read from the critic's working folder, as Claude Code does. A call that names no
// path searches that empty working folder and names nothing.
function pathOutside(call, allowed) {
  const input = call?.input && typeof call.input === 'object' ? call.input : {};
  const named = ['file_path', 'path', 'notebook_path'].map((k) => input[k]).filter((v) => typeof v === 'string' && v.trim());
  if (call.name === 'Glob' && typeof input.pattern === 'string' && (isAbsolute(input.pattern) || input.pattern.startsWith('~') || input.pattern.split(/[\\/]/).includes('..'))) named.push(input.pattern);
  return named.find((p) => !pathInside(p, allowed)) ?? null;
}

function pathInside(p, { readDir, cwd, home }) {
  if (!readDir) return false;
  let t = p.trim();
  if (t === '~' || t.startsWith('~/')) t = join(home, t.slice(1));
  const wild = t.search(/[*?[{]/);
  const literal = wild >= 0 ? t.slice(0, wild) : t;
  if (wild >= 0 && t.split(/[\\/]/).includes('..')) return false;
  const abs = resolvePath(cwd ?? '/', literal || '.');
  const root = readDir.replace(/[\\/]+$/, '');
  return abs === root || abs.startsWith(root + sep);
}

// Keeps each Linear tool call of an assistant event and the result a later user event gives it.
function track(event, uses) {
  const content = Array.isArray(event?.message?.content) ? event.message.content : [];
  for (const c of content) {
    if (event.type === 'assistant' && c?.type === 'tool_use' && String(c.name ?? '').startsWith('mcp__')) uses.set(c.id, { server: String(c.name).split('__').slice(1, -1).join('__'), tool: toolPart(c.name), args: c.input ?? null, ok: false, text: '' });
    if (event.type === 'user' && c?.type === 'tool_result' && uses.has(c.tool_use_id)) Object.assign(uses.get(c.tool_use_id), { ok: c.is_error !== true, text: resultText(c.content) });
  }
}

// Claude Code says this when --resume names a session it does not have.
const MISSING_SESSION = /no conversation found|session[^\n]*(not found|does not exist)/i;

function missingSession(session, usage, code, signal) {
  return { ok: false, failure: 'session-missing', detail: `Claude Code no longer has the critic session ${session}. Retry with --new-session to start a fresh session. The saved round counts are kept.`, sessionId: session, usage, code, signal };
}

// What the event shows the critic was given or used beyond what it is allowed, or null. allowed
// holds the built in tools it has, the ids of its Linear servers, the ids of the servers denied by
// name, and readDir with the working folder cwd and home. A denied server may still start, as long
// as none of its tools is offered. A Read, Grep or Glob call that names a path outside readDir is
// stopped too, as a second layer after the allow rule and the settings check.
export function toolsUsed(event, allowed) {
  const ok = (name) => allowed.builtIn.includes(name) || allowed.linear.some((id) => String(name).startsWith(`mcp__${id}__`));
  if (event?.type === 'system' && event.subtype === 'init') {
    const servers = (Array.isArray(event.mcp_servers) ? event.mcp_servers : []).map((s) => String(s?.name ?? ''));
    const strange = servers.filter((n) => !allowed.linear.includes(toolId(n)) && !allowed.denied.includes(toolId(n)));
    if (strange.length) return `started the MCP server${strange.length === 1 ? '' : 's'} ${strange.slice(0, 5).map((n) => n.slice(0, 80)).join(', ')}`;
    const extra = (Array.isArray(event.tools) ? event.tools : []).filter((t) => !ok(t));
    if (extra.length) return `offered the tools ${extra.slice(0, 5).join(', ')}`;
  }
  if (event?.type === 'assistant' && Array.isArray(event.message?.content)) {
    const call = event.message.content.find((c) => c?.type === 'tool_use' && !ok(c.name));
    if (call) return `called the tool ${String(call.name ?? 'unnamed').slice(0, 80)}`;
    const reader = event.message.content.find((c) => c?.type === 'tool_use' && READ_TOOLS.split(',').includes(c.name) && pathOutside(c, allowed));
    if (reader) return `called ${reader.name} on a path outside the source folder`;
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
// before it can run: --permission-mode dontAsk denies whatever is not allowed and --permission-prompts
// none answers no prompt. The user's settings stay loaded, because --setting-sources local also hides
// the claude.ai connectors (checked with a real probe on 2.1.312), so every other server is denied by
// name, which wins over any allow rule in those settings. --strict-mcp-config is not used either,
// since it would drop the claude.ai Linear connector too. dontAsk still runs a tool that a saved allow
// rule approves, so the allow rules of those settings are read first: a rule for one Linear tool that
// is not a read is denied by name, and a rule that allows Linear tools broadly stops the probe before
// any model turn. Common write verbs on each Linear server are denied as a second layer. judge()
// fails a probe that called any tool other than a Linear read. Nothing is saved as a session.
export function probeLinear({ bin, env = process.env, timeoutMs = 120000, cwd }) {
  const list = spawnSync(bin, ['mcp', 'list'], { env, cwd: probeDir(cwd), encoding: 'utf8', timeout: 60000 });
  const all = mcpServers(`${list.stdout ?? ''}`);
  const servers = all.filter(isLinearServer);
  if (!servers.length) return { ok: false, detail: 'Claude Code lists no Linear MCP server or connector in `claude mcp list`.' };
  const ids = servers.map(toolId);
  const saved = savedLinearAllows(settingsFiles(env, probeDir(cwd)), ids);
  if (saved.unreadable.length) return { ok: false, blocked: true, detail: `Bollplank could not read ${saved.unreadable.join(' and ')}, so it cannot tell which Linear tools your Claude Code settings allow. The Linear probe did not run.`, fix: `Make ${saved.unreadable.length === 1 ? 'that file' : 'those files'} valid JSON, then run \`bollplank doctor\` again.` };
  if (saved.broad.length) {
    const where = [...new Set(saved.broad.map((b) => b.file))];
    const named = saved.broad.map((b) => `${b.tool} in ${b.file}`).join(', ');
    return {
      ok: false,
      blocked: true,
      detail: `Your Claude Code settings allow Linear tools broadly (${named}), so a read only probe cannot be guaranteed. The Linear probe did not run. Replace that allow rule with rules that each name one Linear tool, such as mcp__${ids[0]}__list_teams, or with read verbs only, such as mcp__${ids[0]}__list*. Or remove it.`,
      fix: `Narrow the Linear allow rule in ${where.join(' and ')}, then run \`bollplank doctor\` again.`,
    };
  }
  // Only the server's read tools are allowed, by the verbs that start their names. Claude Code takes
  // wildcards in these rules. judge() also fails a probe that called any other tool.
  const rules = ids.flatMap((s) => READ_VERBS.flatMap((v) => ['', 'linear_'].map((p) => `mcp__${s}__${p}${v}*`)));
  // Deny wins over allow, wherever the allow rule is.
  const writes = ids.flatMap((s) => WRITE_VERBS.flatMap((v) => ['', 'linear_'].map((p) => `mcp__${s}__${p}${v}*`)));
  const deny = [...denyOthers(all, servers), ...writes, ...saved.deny];
  const argv = ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--tools', '', '--allowedTools', rules.join(','), '--disallowedTools', [...new Set(deny)].join(',')];
  const r = spawnSync(bin, argv, { env, cwd: probeDir(cwd), input: LINEAR_PROBE_PROMPT, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1 << 26 });
  if (r.error?.code === 'ETIMEDOUT') return { ok: false, detail: `Claude Code did not finish the Linear probe in ${timeoutMs / 1000} seconds.` };
  const events = `${r.stdout ?? ''}`.split('\n').map(parseLine).filter(Boolean);
  // Every tool call counts, with or without a result, so a denied or unanswered call is judged too.
  const uses = new Map();
  for (const e of events) {
    const content = Array.isArray(e.message?.content) ? e.message.content : [];
    for (const c of content) {
      if (e.type === 'assistant' && c.type === 'tool_use') uses.set(c.id, { name: c.name ?? '', ok: false, text: '', args: c.input ?? null });
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

// `claude mcp list` prints one server per line as "<name>: <url or command> - <state>", such as
// "✓ Connected", "! Needs authentication" or "✗ Failed to connect". The name is everything before
// the first ": ", so a plugin server such as plugin:acme:files keeps its colons. A server that
// needs authentication or failed is not usable. One whose state is not shown is taken as usable.
export function mcpServerStates(text) {
  const seen = new Map();
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\S.*?):\s+(\S.*)$/);
    if (!m || seen.has(m[1])) continue;
    const state = m[2].match(/\s-\s+([^-]*)$/)?.[1]?.trim() ?? '';
    seen.set(m[1], { name: m[1], state: state || 'state not shown', usable: !/needs auth|fail/i.test(state) });
  }
  return [...seen.values()];
}

function mcpServers(text) {
  return mcpServerStates(text).map((s) => s.name);
}

// Deny rules for every server that is not Linear. A deny rule wins over an allow rule in the settings.
function denyOthers(all, linear) {
  return all.filter((n) => !linear.includes(n)).map((n) => `mcp__${toolId(n)}`);
}

// A server's name as Claude Code writes it in a tool name: mcp__<id>__<tool>. A claude.ai connector
// is normalized further, as Claude Code 2.1.312 does: runs of _ collapse to one and a leading or
// trailing _ goes, so "claude.ai Linear (Acme)" is claude_ai_Linear_Acme.
export function toolId(server) {
  const id = server.replace(/[^A-Za-z0-9_-]/g, '_');
  return server.startsWith('claude.ai ') ? id.replace(/_+/g, '_').replace(/^_|_$/g, '') : id;
}

// The verbs that start the names of tools that change something. Each is denied on every Linear
// server the probe keeps, as a second layer after the read only allow rules.
export const WRITE_VERBS = ['create', 'update', 'delete', 'save', 'set', 'add', 'remove', 'archive', 'move', 'assign', 'post', 'send', 'upload', 'link', 'unlink', 'merge'];

// The settings files whose allow rules Claude Code loads for a call in dir: the user's, the
// folder's own, and the managed file. BOLLPLANK_CLAUDE_MANAGED_SETTINGS replaces the managed path, so
// tests never read the real one.
export function settingsFiles(env, dir) {
  const user = claudeDir(env);
  return [join(user, 'settings.json'), join(user, 'settings.local.json'), join(dir, '.claude', 'settings.json'), join(dir, '.claude', 'settings.local.json'), managedSettings(env)];
}

export function managedSettings(env = process.env) {
  const set = expand(env.BOLLPLANK_CLAUDE_MANAGED_SETTINGS);
  if (set) return set;
  if (process.platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  if (process.platform === 'win32') return 'C:\\Program Files\\ClaudeCode\\managed-settings.json';
  return '/etc/claude-code/managed-settings.json';
}

// The saved allow rules that reach a tool of the Linear servers ids. A rule for one tool that is not
// a read goes into deny. A rule for the whole server, or a wildcard that is not limited to read
// verbs, goes into broad, with only its tool part and its file. A file that exists but cannot be read
// as JSON goes into unreadable, since its rules are unknown.
export function savedLinearAllows(files, ids) {
  const deny = new Set();
  const broad = [];
  const unreadable = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') unreadable.push(file);
      continue;
    }
    let allow;
    try {
      allow = JSON.parse(text)?.permissions?.allow ?? [];
    } catch {
      unreadable.push(file);
      continue;
    }
    for (const rule of Array.isArray(allow) ? allow : []) {
      if (typeof rule !== 'string') continue;
      const tool = rule.split('(')[0].trim();
      for (const id of ids) {
        const reach = linearReach(tool, id);
        if (reach === 'one') deny.add(tool);
        if (reach === 'broad' && !broad.some((b) => b.tool === tool && b.file === file)) broad.push({ tool, file });
      }
    }
  }
  return { deny: [...deny], broad, unreadable };
}

// What an allow rule's tool part reaches on the server id: null for nothing or only reads, 'one' for
// one tool that is not a read, 'broad' for more than one tool that may not be a read.
export function linearReach(tool, id) {
  const base = `mcp__${id}`;
  if (!tool.includes('*')) {
    if (tool === base) return 'broad';
    if (tool.startsWith(`${base}__`) && tool.length > base.length + 2) return isReadTool(tool) ? null : 'one';
    return null;
  }
  const re = new RegExp(`^${tool.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  const samples = SAMPLE_TOOLS.map((t) => `${base}__${t}`);
  const literal = tool.slice(0, tool.indexOf('*'));
  const touches = re.test(base) || samples.some((n) => re.test(n)) || `${base}__`.startsWith(literal) || literal.startsWith(`${base}__`);
  if (!touches) return null;
  // A wildcard whose tool name starts with a read verb, as the probe's own rules do, stays limited.
  const sep = tool.lastIndexOf('__');
  const own = sep > 3 ? tool.slice(sep + 2).split('*')[0] : '';
  const readOnly = own !== '' && isReadTool(own) && samples.every((n) => !re.test(n) || isReadTool(n));
  return readOnly ? null : 'broad';
}

// Tool names to try a wildcard against: every read and write verb, with and without a linear prefix,
// in snake and camel case, and names that start with neither.
const SAMPLE_TOOLS = [...READ_VERBS, ...WRITE_VERBS, 'import', 'do', 'x'].flatMap((v) => [`${v}_issue`, `linear_${v}_issue`, `${v}Issue`]);

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
