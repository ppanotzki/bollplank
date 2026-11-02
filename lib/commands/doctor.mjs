// bollplank doctor [--offline] [--json]
// Checks that Bollplank can work on this machine and says what to do about each problem:
// Node, the Workflow line, the command on PATH (a warning, since the full path works too), the
// config, every recorded link, every kit skill linked into each client found, each client with
// its version and subscription sign in, a live Linear read from each client, one critic dry run
// per configured critic, and the ship lock. --offline skips the Linear reads and the dry runs.
// Exits 1 when a required check fails. --json lists every check with ok, detail and fix.
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { parse } from '../args.mjs';
import { readConfig } from '../config.mjs';
import { emit, Exit, fail, say } from '../out.mjs';
import { homedir } from 'node:os';
import { kitDir, paths } from '../paths.mjs';
import { childEnv } from '../providers/index.mjs';
import { findClients, INSTALL_HINT, SIGN_IN_HINT, versionNote } from '../setup/clients.mjs';
import { checkLinks, kitSkills, linkTarget, pointsInto, readInstall } from '../setup/links.mjs';
import { LINEAR_MCP_URL } from '../setup/probe.mjs';
import { workflowLine } from '../version.mjs';

export const usage = 'bollplank doctor [--offline] [--json]';

// The dry run asks for a reply in the critique format and nothing else.
const DRY_RUN = [
  'This is a Bollplank health check, not a review. Use no tools.',
  'Reply with exactly these three lines and nothing else:',
  'Critique of ACME-0 health check v1',
  'Verdict: Approve',
  'No material points.',
].join('\n');

const ADD_LINEAR = {
  claude: `Run \`bollplank init\` to add the Linear MCP, or run \`claude mcp add --transport http --scope user linear ${LINEAR_MCP_URL}\` and then \`claude mcp login linear\`.`,
  codex: `Run \`bollplank init\` to add the Linear MCP, or run \`codex mcp add linear --url ${LINEAR_MCP_URL}\` and then \`codex mcp login linear\`.`,
};

export async function run(argv) {
  const { opts, positional, error } = parse(argv, { offline: 'bool', json: 'bool' });
  if (error || positional.length) fail('usage', error ?? usage);
  const checks = await collect({ offline: Boolean(opts.offline) });
  const ok = passed(checks);
  if (opts.json) emit({ ok, offline: Boolean(opts.offline), checks }, ok ? 0 : 1);
  say(render(checks));
  if (!ok) throw new Exit(1);
}

export function passed(checks) {
  return checks.every((c) => !c.required || c.ok !== false);
}

export async function collect({ offline = false } = {}) {
  const checks = [];
  const add = (c) => checks.push({ required: true, fix: null, ...c });

  const major = Number(process.versions.node.split('.')[0]);
  add({ id: 'node', name: 'Node', ok: major >= 20, detail: `Node ${process.versions.node}`, fix: major >= 20 ? null : 'Install Node 20 or later from https://nodejs.org, then run this again.' });

  const line = workflowLine();
  const knownBuild = !/build unknown/.test(line);
  add({ id: 'workflow', name: 'Workflow line', required: false, ok: knownBuild, detail: line, fix: knownBuild ? null : 'The kit is not a git checkout, so its build is unknown. Install it with git clone as the setup guide says.' });

  // Without the command on PATH Bollplank still works through its full path, so this only warns.
  const onPath = findOnPath('bollplank');
  const install = readInstall();
  const binLink = install.links.find((l) => l.kind === 'bin')?.path;
  const binDir = binLink ? dirname(binLink) : join(homedir(), '.local', 'bin');
  add({
    id: 'path',
    name: 'bollplank on PATH',
    required: false,
    ok: Boolean(onPath),
    detail: onPath ? (pointsInto(onPath) ? `${onPath}, a link into this kit` : onPath) : `bollplank is not on PATH. Until it is, run it as ${join(kitDir, 'bin', 'bollplank')}.`,
    fix: onPath ? null : `${binLink ? 'Add' : 'Run install.sh from the kit to link the command. Then add'} this line to ${process.env.SHELL?.endsWith('bash') ? '~/.bashrc' : '~/.zshrc'} and open a new terminal: export PATH="${shellPath(binDir)}:$PATH"`,
  });

  const cfg = readConfig();
  add({ id: 'config', name: 'Config', ok: cfg.problems.length === 0, detail: cfg.problems.length ? cfg.problems.join('. ') : `${paths().config} is valid`, fix: cfg.problems.length ? (cfg.missing ? 'Run `bollplank init`.' : `Fix ${paths().config}, or run \`bollplank init\` to set it again. The previous version is in config.json.bak when init wrote it.`) : null });
  const config = cfg.config ?? null;

  if (install.missing) add({ id: 'links', name: 'Links', ok: false, detail: `no install record at ${paths().install}`, fix: 'Run `bollplank init` to link the skills.' });
  else if (install.corrupt) add({ id: 'links', name: 'Links', ok: false, detail: install.corrupt, fix: `Fix ${install.file} by hand, or move it away and run \`bollplank init\` to link again. Links it listed and init does not make again are then not removed by uninstall.` });
  else {
    const links = checkLinks();
    const bad = links.filter((l) => !l.ok);
    add({ id: 'links', name: 'Links', ok: bad.length === 0, detail: bad.length ? bad.map((l) => `${l.path}: ${l.problem}`).join('. ') : `${links.length} recorded link${links.length === 1 ? '' : 's'} point into ${kitDir}`, fix: bad.length ? 'Run `bollplank init` to link again. A path you changed yourself is left alone, so move it away first if you want the link back.' : null });
  }

  const clients = findClients();
  // Every kit skill must be linked into the skills folder of each client found, and point into the kit.
  const skills = kitSkills();
  for (const c of clients.filter((x) => x.found)) {
    const missing = [];
    const foreign = [];
    for (const skill of skills) {
      const path = join(c.dir, 'skills', skill);
      if (!lexists(path)) missing.push(path);
      else if (!pointsInto(path)) foreign.push({ path, why: linkTarget(path) ? `a link to ${linkTarget(path)}, which is not this kit` : 'not a link into the kit' });
      else if (!existsSync(path)) foreign.push({ path, why: 'a link to a kit path that is gone' });
    }
    const ok = !missing.length && !foreign.length;
    const detail = [...missing.map((p) => `${p} is missing`), ...foreign.map((f) => `${f.path} is ${f.why}`)].join('. ');
    const fix = [missing.length ? `Run \`bollplank init\` to link ${missing.join(', ')}.` : null, foreign.length ? `Move ${foreign.map((f) => f.path).join(', ')} away, then run \`bollplank init\` to link the skill there.` : null].filter(Boolean).join(' ');
    add({ id: `skills.${c.name}`, name: `${c.label} skills`, ok, detail: ok ? `${skills.length} skill${skills.length === 1 ? '' : 's'} linked into ${join(c.dir, 'skills')}` : detail, fix: ok ? null : fix });
  }

  const choice = config?.critic.default ?? 'other';
  const needed = (name) => choice === 'other' || choice === name || (choice === 'same' && !clients.some((c) => c.usable));
  for (const c of clients) {
    if (!c.found) {
      add({ id: `client.${c.name}`, name: c.label, required: needed(c.name), ok: false, detail: `${c.label} was not found`, fix: INSTALL_HINT[c.name] });
      continue;
    }
    add({ id: `client.${c.name}`, name: c.label, required: needed(c.name), ok: true, detail: `${c.label} at ${c.bin}` });
    add({ id: `version.${c.name}`, name: `${c.label} version`, required: false, ok: c.testedMatch, detail: versionNote(c), fix: c.testedMatch ? null : 'Nothing is required. If something breaks, report it with both versions.' });
    add({ id: `signin.${c.name}`, name: `${c.label} sign in`, required: needed(c.name), ok: c.usable, detail: c.signIn.detail, fix: c.usable ? null : SIGN_IN_HINT[c.name] });
  }

  const usable = clients.filter((c) => c.usable);
  const env = childEnv(process.env);
  mkdirSync(paths().neutral, { recursive: true });
  let anyLinear = false;
  for (const c of usable) {
    if (offline) {
      add({ id: `linear.${c.name}`, name: `Linear from ${c.label}`, required: false, ok: null, skipped: true, detail: 'skipped with --offline' });
      continue;
    }
    const r = c.provider.probeLinear({ bin: c.bin, env, timeoutMs: 180000 });
    anyLinear ||= r.ok;
    add({ id: `linear.${c.name}`, name: `Linear from ${c.label}`, required: false, ok: r.ok, detail: r.detail, fix: r.ok ? null : ADD_LINEAR[c.name] });
  }
  if (!offline) add({ id: 'linear', name: 'Linear', ok: anyLinear, detail: anyLinear ? 'at least one client reads Linear' : 'no client could read Linear', fix: anyLinear ? null : 'Add the Linear MCP to the client you lead with. Run `bollplank init` to do it.' });

  const critics = choice === 'other' ? clients : choice === 'same' ? usable : clients.filter((c) => c.name === choice);
  for (const c of critics) {
    const mode = choice === 'same' ? 'same' : 'critic';
    const name = `${mode === 'same' ? 'Same provider critic' : 'Critic'} ${c.label}`;
    if (offline) {
      add({ id: `critic.${c.name}`, name, required: false, ok: null, skipped: true, detail: 'skipped with --offline' });
      continue;
    }
    if (!c.usable) {
      add({ id: `critic.${c.name}`, name, ok: false, detail: `${c.label} is not available as a critic. ${c.found ? c.signIn.detail : 'It was not found.'}`, fix: c.found ? SIGN_IN_HINT[c.name] : `${INSTALL_HINT[c.name]} Or set critic.default in the config to a client you have.` });
      continue;
    }
    const pinned = (mode === 'same' ? config?.critic.same?.[c.name] : undefined) ?? config?.critic.providers?.[c.name] ?? {};
    const r = await c.provider.review({ bin: c.bin, prompt: DRY_RUN, model: pinned.model, effort: pinned.effort, cwd: paths().neutral, timeoutMs: 180000, env });
    const text = (r.text ?? '').trimStart();
    const good = r.ok && /^Critique of /.test(text) && /^Verdict:\s*(Approve|Revise)\b/m.test(text);
    add({ id: `critic.${c.name}`, name, ok: good, detail: good ? `${c.label} answered in the critique format` : r.ok ? `${c.label} answered, but not in the critique format: ${text.slice(0, 120)}` : `${c.label} failed: ${r.failure}. ${r.detail ?? ''}`.trim(), fix: good ? null : `Run \`${c.name === 'claude' ? 'claude' : 'codex'}\` by hand to see whether it works, and check its usage limits.` });
  }

  const lock = config?.shipLock ?? paths().shipLock;
  if (!existsSync(lock)) add({ id: 'lock', name: 'Ship lock', required: false, ok: true, detail: `free (${lock})` });
  else {
    let h = null;
    try {
      h = JSON.parse(readFileSync(join(lock, 'holder.json'), 'utf8'));
    } catch {}
    const minutes = h?.since ? Math.round((Date.now() - Date.parse(h.since)) / 60000) : null;
    if (h?.ticket) add({ id: 'lock', name: 'Ship lock', required: false, ok: true, detail: `held by ${h.ticket}${h.session ? `, session ${h.session}` : ''}, for ${minutes} minutes` });
    else add({ id: 'lock', name: 'Ship lock', required: false, ok: false, detail: `${lock} exists without a readable holder record`, fix: 'Check that nothing is shipping, then remove the lock folder by hand.' });
  }
  return checks;
}

export function render(checks) {
  const mark = (c) => (c.skipped ? 'skip' : c.ok ? 'ok  ' : c.required ? 'FAIL' : 'warn');
  const lines = checks.map((c) => `  ${mark(c)}  ${c.name}: ${c.detail}${c.ok === false && c.fix ? `\n        Fix: ${c.fix}` : ''}`);
  const failed = checks.filter((c) => c.required && c.ok === false).length;
  const warned = checks.filter((c) => !c.required && c.ok === false).length;
  const skipped = checks.filter((c) => c.skipped).length;
  const tally = [`${checks.length} checks`, `${failed} failed`, warned ? `${warned} to look at` : null, skipped ? `${skipped} skipped` : null].filter(Boolean).join(', ');
  return `Bollplank doctor\n${lines.join('\n')}\n${tally}.`;
}

function lexists(p) {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

// A folder as a shell would write it in a profile line, with $HOME for the home folder.
function shellPath(dir) {
  const h = homedir();
  return dir === h ? '$HOME' : dir.startsWith(h + sep) ? `$HOME/${dir.slice(h.length + 1)}` : dir;
}

function findOnPath(cmd) {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH');
  const dirs = (key ? process.env[key] : '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const d of dirs) {
    const p = join(d, cmd);
    if (existsSync(p)) return p;
  }
  return null;
}
