// The Claude Code provider. It finds the CLI, reads its sign in and runs one critique turn in print
// mode with stream JSON in and out. The critic gets read tools only, no MCP servers and no settings
// beyond the local ones of its neutral folder.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { expand } from '../paths.mjs';

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
  let s;
  try {
    s = JSON.parse(r.stdout);
  } catch {
    return { signedIn: false, subscription: false, method: null, detail: 'Claude Code did not report its sign in. Run `claude auth status`.' };
  }
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
export function review({ bin, prompt, sessionId, model, effort, readDir, cwd, timeoutMs = 600000, env = process.env }) {
  const resumed = Boolean(sessionId);
  const session = sessionId ?? randomUUID();
  const argv = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--setting-sources', 'local', '--strict-mcp-config', '--permission-prompts', 'none', '--tools', READ_TOOLS, '--allowedTools', READ_TOOLS];
  if (readDir) argv.push('--add-dir', readDir, '--disallowedTools', NO_WRITE_TOOLS);
  if (model) argv.push('--model', model);
  if (effort) argv.push('--effort', effort);
  argv.push(...(resumed ? ['--resume', session] : ['--session-id', session]));

  return new Promise((done) => {
    let settled = false;
    let result = null;
    let buffer = '';
    let err = '';
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(r);
    };
    const child = spawn(bin, argv, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => (err += d));
    child.stdin.on('error', (e) => (err += e.message + '\n'));
    child.on('error', (e) => finish({ ok: false, failure: 'exit', detail: `Claude Code did not start: ${e.message}`, sessionId: resumed ? session : undefined }));
    const onEvent = (event, closing) => {
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
      const reported = result?.session_id ?? session;
      const usage = result?.usage ?? null;
      if (result?.is_error) return finish({ ok: false, failure: 'client-error', detail: tail(String(result.result ?? result.subtype ?? 'Claude Code reported an error')), sessionId: reported, usage, code, signal });
      const text = typeof result?.result === 'string' ? result.result : '';
      if (code !== 0 || !result) {
        const detail = tail(err) || (result ? `Claude Code exited with code ${code ?? signal} after its result.` : 'Claude Code closed without a result.');
        return finish({ ok: false, failure: 'exit', detail, sessionId: reported, usage, code, signal, ...(text.trim() ? { text } : {}) });
      }
      finish({ ok: true, text, sessionId: reported, model: modelLine(result.modelUsage, model, effort), usage });
    });
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n');
  });
}

// Claude Code keeps its sessions under <config dir>/projects.
export function sessionRoots(env = process.env) {
  return [join(expand(env.CLAUDE_CONFIG_DIR) ?? join(env.HOME || homedir(), '.claude'), 'projects')];
}

// The model the session ran, from the result's modelUsage. A pinned model counts only when it ran.
function modelLine(modelUsage, model, effort) {
  const ran = Object.keys(modelUsage ?? {});
  const seen = model ? ran.find((m) => m.startsWith(model)) : ran[0];
  if (!seen) return 'Unverified';
  return `${model ?? seen}, ${effort ?? 'effort unverified'}`;
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
