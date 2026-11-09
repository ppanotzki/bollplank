// bollplank doctor [--offline] [--json]
// Checks that Bollplank can work on this machine and says what to do about each problem:
// Node, the Workflow line, the command on PATH (a warning, since the full path works too), the
// config, every recorded link, every kit skill linked into each client found, each client with
// its version and subscription sign in, a live read of every board kind the config uses from each
// client found, each project's board against what each client read (team, project and statuses on
// Linear, site, project key, cloud id, project id, statuses and space on Jira), one critic dry run
// per configured critic, and the ship lock. --offline skips the board reads, the board checks and
// the dry runs.
// Exits 1 when a required check fails. --json lists every check with ok, detail and fix.
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { parse } from '../args.mjs';
import { BOARDS, isBoardKind, kindOf, missingInNewTeam } from '../boards.mjs';
import { readConfig, STATUS_KEYS, statusKeyOf } from '../config.mjs';
import { emit, Exit, fail, say } from '../out.mjs';
import { homedir } from 'node:os';
import { kitDir, paths } from '../paths.mjs';
import { childEnv } from '../providers/index.mjs';
import { rememberModel } from './critic.mjs';
import { findClients, INSTALL_HINT, SIGN_IN_HINT, versionNote } from '../setup/clients.mjs';
import { checkLinks, kitSkills, linkTarget, pointsInto, readInstall } from '../setup/links.mjs';
import { addStatusSteps, jiraAddStatusSteps, PROBES } from '../setup/probe.mjs';
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


export async function run(argv) {
  const { opts, positional, error } = parse(argv, { offline: 'bool', json: 'bool' });
  if (error || positional.length) fail('usage', error ?? usage);
  // The slow checks say what they are doing on stderr, so stdout keeps only the result.
  const progress = opts.json ? undefined : (line) => process.stderr.write(`${line}\n`);
  const checks = await collect({ offline: Boolean(opts.offline), progress });
  const ok = passed(checks);
  if (opts.json) emit({ ok, offline: Boolean(opts.offline), checks }, ok ? 0 : 1);
  say(render(checks));
  if (!ok) throw new Exit(1);
}

export function passed(checks) {
  return checks.every((c) => !c.required || c.ok !== false);
}

// Dry run failures that a second try cannot change: the critic used a tool it may not, or the
// client cannot run a critic at all.
const NO_RETRY = ['critic-used-tools', 'critic-unavailable'];

// A client check that fails in a way a second try can fix runs once more, since a client or its
// service can fail for a moment. The result carries tries: 2 when it ran twice, and its check
// says so.
export async function secondTry(call, passed, retryable, what, step = () => {}) {
  const first = await call();
  if (passed(first) || !retryable(first)) return first;
  step(`${what}. Trying once more...`);
  return { ...(await call()), tries: 2 };
}

// The detail of a check, with what it ran twice added.
function withTries(detail, ok, r) {
  const text = String(detail ?? '');
  if (r.tries !== 2) return detail;
  if (ok) return text.endsWith('.') ? `${text.slice(0, -1)}, on the second try.` : `${text}, on the second try`;
  return `${text.replace(/\.?$/, '.')} It failed on both tries.`;
}

// progress, when given, gets a line before each check that starts Claude Code or Codex, since
// those take up to a few minutes in all and print nothing until they are done.
export async function collect({ offline = false, progress } = {}) {
  const checks = [];
  const step = (line) => progress?.(line);
  if (!offline) step('Doctor starts Claude Code and Codex for some checks. This takes a few minutes.');
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
    fix: onPath ? null : binLink ? cap(pathAdvice(binDir)) : `Run install.sh from the kit to link the command. Then ${pathAdvice(binDir)}`,
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

  // The critic defaults in use: the config's and each project's own.
  const choices = [...new Set([config?.critic.default ?? 'other', ...Object.values(config?.projects ?? {}).map((p) => p?.critic?.default).filter(Boolean)])];
  const needed = (name) => choices.some((choice) => choice === 'other' || choice === name || (choice === 'same' && !clients.some((c) => c.usable)));
  for (const c of clients) {
    if (!c.found) {
      add({ id: `client.${c.name}`, name: c.label, required: needed(c.name), ok: false, detail: `${c.label} was not found`, fix: INSTALL_HINT[c.name] });
      continue;
    }
    add({ id: `client.${c.name}`, name: c.label, required: needed(c.name), ok: true, detail: `${c.label} at ${c.bin}` });
    add(clientPathCheck(c, findOnPath(c.name)));
    add({ id: `version.${c.name}`, name: `${c.label} version`, required: false, ok: c.testedMatch, detail: versionNote(c), fix: c.testedMatch ? null : 'Nothing is required. If something breaks, report it with both versions.' });
    add({ id: `signin.${c.name}`, name: `${c.label} sign in`, required: needed(c.name), ok: c.usable, detail: c.signIn.detail, fix: c.usable ? null : SIGN_IN_HINT[c.name] });
  }

  const usable = clients.filter((c) => c.usable);
  const env = childEnv(process.env);
  mkdirSync(paths().neutral, { recursive: true });
  // Either client may lead a ticket, so each one found must read every board kind the config uses.
  // Linear when there is no config. Check ids are <kind>.<client> and <kind>.
  const found = clients.filter((c) => c.found);
  for (const kind of boardKinds(config)) {
    const { label, server } = PROBES[kind];
    const target = kind === 'jira' ? jiraTarget(config) : undefined;
    const reads = [];
    for (const c of found) {
      const id = `${kind}.${c.name}`;
      const name = `${label} from ${c.label}`;
      if (offline) {
        add({ id, name, required: false, ok: null, skipped: true, detail: 'skipped with --offline' });
        continue;
      }
      if (!c.usable) {
        add({ id, name, ok: false, detail: `not read, since ${c.label} is not signed in with a subscription`, fix: SIGN_IN_HINT[c.name] });
        continue;
      }
      step(`Reading ${label} from ${c.label}...`);
      const r = await secondTry(() => c.provider.probeBoard(kind, { bin: c.bin, env, timeoutMs: 180000, ...(target ? { target } : {}) }), (x) => x.ok, (x) => x.retry === true, `${c.label} could not read ${label}`, step);
      if (r.ok) reads.push({ client: c, teams: r.teams ?? [], sites: r.sites ?? [] });
      add({ id, name, ok: r.ok, detail: withTries(r.detail, r.ok, r), fix: r.ok ? null : (r.fix ?? BOARDS[kind].fix[c.name]) });
    }
    if (!offline && found.length) {
      const all = reads.length === found.length;
      const failing = found.filter((c) => !reads.some((r) => r.client === c)).map((c) => c.label);
      add({ id: kind, name: label, ok: all, detail: all ? `every client found reads ${label} (${found.map((c) => c.label).join(', ')})` : `${failing.join(' and ')} could not read ${label}`, fix: all ? null : found.some((c) => !c.usable) ? 'Sign in to each client first, as its own check says. Then run `bollplank doctor` again.' : `Either client may lead a ticket, so each one needs ${label}. Run \`bollplank init\` to add the ${server} MCP to it.` });
    }
    if (!offline && config && reads.length) for (const check of kind === 'linear' ? boardChecks(config, reads, cfg.raw) : jiraBoardChecks(config, reads, cfg.raw)) add(check);
  }

  // One dry run per client and mode the critic defaults use.
  const critics = [];
  const want = (c, mode) => critics.some((x) => x.c === c && x.mode === mode) || critics.push({ c, mode });
  for (const choice of choices) {
    if (choice === 'other') clients.forEach((c) => want(c, 'critic'));
    else if (choice === 'same') usable.forEach((c) => want(c, 'same'));
    else clients.filter((c) => c.name === choice).forEach((c) => want(c, 'critic'));
  }
  for (const { c, mode } of critics) {
    const id = mode === 'same' && critics.some((x) => x.c === c && x.mode === 'critic') ? `critic.${c.name}.same` : `critic.${c.name}`;
    const name = `${mode === 'same' ? 'Same provider critic' : 'Critic'} ${c.label}`;
    if (offline) {
      add({ id, name, required: false, ok: null, skipped: true, detail: 'skipped with --offline' });
      continue;
    }
    if (!c.usable) {
      add({ id, name, ok: false, detail: `${c.label} is not available as a critic. ${c.found ? c.signIn.detail : 'It was not found.'}`, fix: c.found ? SIGN_IN_HINT[c.name] : `${INSTALL_HINT[c.name]} Or set critic.default in the config to a client you have.` });
      continue;
    }
    const pinned = (mode === 'same' ? config?.critic.same?.[c.name] : undefined) ?? config?.critic.providers?.[c.name] ?? {};
    // No issue, so the dry run gets no board tools and doctor never offers a board write.
    step(`Running a test critique with ${c.label}${mode === 'same' ? ' in same provider mode' : ''}...`);
    const inFormat = (x) => x.ok && /^Critique of /.test((x.text ?? '').trimStart()) && /^Verdict:\s*(Approve|Revise)\b/m.test((x.text ?? '').trimStart());
    const r = await secondTry(() => c.provider.review({ bin: c.bin, prompt: DRY_RUN, model: pinned.model, effort: pinned.effort, cwd: paths().neutral, timeoutMs: 180000, env }), inFormat, (x) => !NO_RETRY.includes(x.failure), `The test critique with ${c.label} failed`, step);
    const text = (r.text ?? '').trimStart();
    const good = inFormat(r);
    // The model the client reports fills the first critique's Model line, unless one is pinned.
    if (r.ok && r.model && !pinned.model) rememberModel(c.name, r.model);
    add({ id, name, ok: good, detail: withTries(good ? `${c.label} answered in the critique format` : r.ok ? `${c.label} answered, but not in the critique format: ${text.slice(0, 120)}` : `${c.label} failed: ${r.failure}. ${r.detail ?? ''}`.trim(), good, r), fix: good ? null : `Run \`${c.name === 'claude' ? 'claude' : 'codex'}\` by hand to see whether it works, and check its usage limits.` });
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

// The board kinds the config uses: the top level kind and each project's own, top level first.
// Linear when there is no config, so a fresh install still checks the board.
export function boardKinds(config) {
  if (!config) return ['linear'];
  const kinds = [config.board.kind, ...Object.keys(config.projects).map((n) => kindOf(config, n))];
  return [...new Set(kinds.filter(isBoardKind))];
}

// The Linear board team, projects and five statuses the config names, against what each client read.
// Only the Linear boards are checked here: the top level one when it is Linear, and each project
// whose kind is Linear. jiraBoardChecks checks the Jira ones.
// Each project is checked against its own team with its own effective statuses, and the top level
// board against the top level team. One check per team, project and status, failing with the client
// that does not see it. The top level statuses are required only when a project falls back to at
// least one of them, otherwise a missing one is a warning. Names are compared exactly, as the board skill finds a status by its exact
// name. A name that differs from Linear's only in case fails with Linear's spelling to put in the
// config. raw is the config as read, which tells whether a name is the project's own.
export function boardChecks(config, reads, raw = null) {
  const wanted = new Map();
  const want = (team, project, where, statuses, required = true) => {
    if (!team) return;
    const t = wanted.get(team) ?? { team, projects: new Map(), where: new Set(), statuses: new Map() };
    t.where.add(where.team);
    if (project) t.projects.set(project, { project, where: where.project });
    for (const { key, name, at } of statuses) {
      const s = t.statuses.get(`${key}\n${name}`) ?? { key, name, at: new Set(), required: false };
      s.at.add(at);
      s.required ||= required;
      t.statuses.set(`${key}\n${name}`, s);
    }
    wanted.set(team, t);
  };
  // The config key a project's team or project comes from: its own, or the top level default.
  const own = (name, field) => (raw?.projects?.[name]?.board?.[field] !== undefined ? `projects.${name}.board` : 'board');
  // Without the config as read, every project is taken to fall back to the top level names.
  const topLinear = (config.board.kind ?? 'linear') === 'linear';
  const linearProjects = Object.entries(config.projects).filter(([name]) => (kindOf(config, name) ?? 'linear') === 'linear');
  const fallsBack = topLinear && linearProjects.some(([name]) => !raw || STATUS_KEYS.some((key) => raw.projects?.[name]?.board?.statuses?.[key] === undefined));
  if (topLinear) want(config.board.team, config.board.project, { team: 'board', project: 'board' }, STATUS_KEYS.map((key) => ({ key, name: config.board.statuses[key], at: `board.statuses.${key}` })), fallsBack);
  for (const [name, pr] of linearProjects) {
    const top = topLinear ? config.board : { statuses: {} };
    const statuses = STATUS_KEYS.map((key) => ({ key, name: pr.board?.statuses?.[key] ?? top.statuses[key], at: statusKeyOf(raw, name, key) }));
    want(pr.board?.team ?? top.team, pr.board?.project ?? top.project, { team: raw ? own(name, 'team') : `projects.${name}.board`, project: raw ? own(name, 'project') : `projects.${name}.board` }, statuses);
  }
  const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
  // Linear's spelling of name, when a client read it in another case only.
  const spelling = (lists, name) => lists.flat().find((x) => typeof x === 'string' && x !== name && same(x, name)) ?? null;
  // The suggested names a new team lacks, to say so when one of them is missing.
  const kind = 'linear';
  const byHand = missingInNewTeam(kind);
  const checks = [];
  for (const { team, projects, where, statuses } of wanted.values()) {
    const seen = reads.map((r) => {
      const exact = r.teams.find((t) => t.key === team || t.name === team) ?? null;
      const near = exact ? null : (r.teams.find((t) => same(t.key, team) || same(t.name, team)) ?? null);
      return { label: r.client.label, exact, info: exact ?? near, spelled: near ? (same(near.key, team) ? near.key : near.name) : null };
    });
    const without = seen.filter((s) => !s.exact).map((s) => s.label);
    const teamSpelled = seen.find((s) => s.spelled)?.spelled ?? null;
    const teamAt = [...where].map((w) => `${w}.team`).join(' and ');
    checks.push({
      id: `board.team.${team}`,
      name: `Linear team ${team}`,
      ok: !without.length,
      detail: without.length ? `${team} is not a team ${without.join(' or ')} can read in Linear${teamSpelled ? `. Linear spells it ${teamSpelled}` : ''}` : `${team} is in Linear`,
      fix: !without.length ? null : teamSpelled ? `Set ${teamAt} in the config to ${teamSpelled}, exactly as Linear spells it.` : `Check the team key in ${[...where].join(' and ')} of the config, and sign ${without.join(' and ')} in to the Linear workspace that has it. Run \`bollplank init\` to choose the team again.`,
    });
    // A team read in another case is still checked for its projects and statuses.
    const withTeam = seen.filter((s) => s.info);
    if (!withTeam.length) continue;
    for (const { project, where: at } of projects.values()) {
      const lacking = withTeam.filter((s) => !(s.info.projects ?? []).includes(project));
      const spelled = spelling(lacking.map((s) => s.info.projects ?? []), project);
      const names = lacking.map((s) => s.label);
      checks.push({
        id: `board.project.${team}.${project}`,
        name: `Linear project ${project}`,
        ok: !lacking.length,
        detail: lacking.length ? `${project} is not a project of ${team} that ${names.join(' or ')} can read${spelled ? `. Linear spells it ${spelled}` : ''}` : `${project} is a project of ${team}`,
        fix: !lacking.length ? null : spelled ? `Set ${at}.project in the config to ${spelled}, exactly as Linear spells it.` : `Create the project ${project} in ${team} in Linear, or set ${at}.project to a project that exists. Run \`bollplank init\` to choose it again.`,
      });
    }
    // Two mappings in one team may name a state differently. Each name gets its own check then.
    const named = [...statuses.values()];
    for (const { key, name: status, at, required } of named) {
      const lacking = withTeam.filter((s) => !(s.info.statuses ?? []).includes(status));
      const spelled = spelling(lacking.map((s) => s.info.statuses ?? []), status);
      const names = lacking.map((s) => s.label);
      const keys = [...at].join(' and ');
      const fresh = byHand.includes(status) ? ` A new ${BOARDS[kind].label} team has only ${BOARDS[kind].newTeam.join(', ')}, so a status named "${status}" is added by hand.` : '';
      checks.push({
        required,
        id: `board.status.${team}.${key}${named.filter((x) => x.key === key).length > 1 ? `.${status}` : ''}`,
        name: `Linear status ${status}`,
        ok: !lacking.length,
        detail: lacking.length ? `${team} has no status named "${status}" that ${names.join(' or ')} can read${spelled ? `. Linear spells it "${spelled}"` : ''}` : `${team} has the status "${status}"`,
        fix: !lacking.length ? null : spelled ? `Set ${keys} in the config to "${spelled}", exactly as Linear spells it.` : `${addStatusSteps(withTeam[0].info.name ?? team, key, status)} Or set ${keys} in the config to a status that exists.${fresh}`,
      });
    }
  }
  return checks.map((c) => ({ required: true, ...c }));
}

// The Jira projects and spaces a probe should read: every Jira board's project key and space.
export function jiraTarget(config) {
  const boards = jiraBoards(config, null);
  return { projects: [...new Set(boards.map((b) => b.project).filter(Boolean))], spaces: [...new Set(boards.map((b) => b.space).filter(Boolean))] };
}

// Every Jira board the config uses: the top level one when it is Jira, and each project whose kind
// is Jira, with the top level site, key, ids and space filled in for a project of the top level
// kind. Each knows the config keys it comes from. raw is the config as read.
function jiraBoards(config, raw) {
  const topJira = config.board.kind === 'jira';
  const out = [];
  const projects = Object.entries(config.projects).filter(([name]) => kindOf(config, name) === 'jira');
  if (topJira) {
    const fallsBack = projects.some(([name]) => !raw || STATUS_KEYS.some((key) => raw.projects?.[name]?.board?.statuses?.[key] === undefined));
    out.push({ at: 'board', site: config.board.team, project: config.board.project, teamId: config.board.teamId, projectId: config.board.projectId, space: config.board.space, statuses: STATUS_KEYS.map((key) => ({ key, name: config.board.statuses[key], at: `board.statuses.${key}` })), required: fallsBack });
  }
  for (const [name, pr] of projects) {
    const b = pr.board ?? {};
    const top = topJira ? config.board : {};
    const at = (field) => (b[field] !== undefined || !topJira ? `projects.${name}.board` : 'board');
    const site = b.team ?? top.team;
    const sameSite = site === top.team;
    const key = b.project ?? top.project;
    out.push({
      at: at('team'),
      atOf: at,
      site,
      project: key,
      teamId: b.teamId ?? (sameSite ? top.teamId : undefined),
      projectId: b.projectId ?? (sameSite && key === top.project ? top.projectId : undefined),
      space: b.space ?? top.space,
      statuses: STATUS_KEYS.map((k) => ({ key: k, name: b.statuses?.[k] ?? top.statuses?.[k], at: statusKeyOf(raw, name, k) })),
      required: true,
    });
  }
  return out.map((x) => ({ atOf: () => x.at, ...x }));
}

// The Jira site, project key, cloud id, project id, five statuses and space of every Jira board,
// against what each client read. One check per site, cloud id, project, project id, status and
// space, grouped by site then project, failing with the client that does not see it. A cloud id or
// project id the config leaves out is a warning, since init saves them from the tools. The top level
// statuses are required only when a Jira project falls back to one of them.
export function jiraBoardChecks(config, reads, raw = null) {
  const sites = new Map();
  for (const b of jiraBoards(config, raw)) {
    if (!b.site) continue;
    const s = sites.get(b.site) ?? { site: b.site, at: new Set(), ids: new Map(), projects: new Map(), spaces: new Map() };
    s.at.add(b.atOf('team'));
    if (b.teamId) s.ids.set(b.teamId, b.atOf('teamId'));
    else s.ids.set(null, b.atOf('teamId'));
    if (b.project) {
      const p = s.projects.get(b.project) ?? { key: b.project, at: new Set(), ids: new Map(), statuses: new Map() };
      p.at.add(b.atOf('project'));
      p.ids.set(b.projectId ?? null, b.atOf('projectId'));
      for (const { key, name, at } of b.statuses) {
        if (!name) continue;
        const st = p.statuses.get(`${key}\n${name}`) ?? { key, name, at: new Set(), required: false };
        st.at.add(at);
        st.required ||= b.required;
        p.statuses.set(`${key}\n${name}`, st);
      }
      s.projects.set(b.project, p);
    }
    if (b.space) s.spaces.set(b.space, b.atOf('space'));
    sites.set(b.site, s);
  }
  const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
  const checks = [];
  const byHand = missingInNewTeam('jira');
  for (const { site, at, ids, projects, spaces } of sites.values()) {
    const seen = reads.map((r) => ({ label: r.client.label, info: (r.sites ?? []).find((x) => x.site === site) ?? null }));
    const without = seen.filter((x) => !x.info).map((x) => x.label);
    checks.push({
      id: `board.jira.site.${site}`,
      name: `Jira site ${site}`,
      ok: !without.length,
      detail: without.length ? `${site} is not a site ${without.join(' or ')} can read through the Atlassian MCP` : `${site} is a Jira site every client reads`,
      fix: without.length ? `Check the site in ${[...at].join(' and ')} of the config, and sign ${without.join(' and ')} in to the Atlassian account that has it. Run \`bollplank init\` to choose the site again.` : null,
    });
    const withSite = seen.filter((x) => x.info);
    if (!withSite.length) continue;
    const cloudId = withSite[0].info.cloudId;
    for (const [id, idAt] of ids) {
      const differs = withSite.filter((x) => x.info.cloudId !== id).map((x) => x.label);
      checks.push({
        id: `board.jira.cloudId.${site}${ids.size > 1 && id ? `.${id}` : ''}`,
        name: `Jira cloud id of ${site}`,
        required: id !== null,
        ok: id !== null && !differs.length,
        detail: id === null ? `${idAt}.teamId is not set, so a readback cannot tell ${site} from another site` : differs.length ? `${idAt}.teamId is ${id}, but ${differs.join(' and ')} read the cloud id ${cloudId} for ${site}` : `${site} has the cloud id ${id}`,
        fix: id === null || differs.length ? `Run \`bollplank init\` to save the cloud id the Atlassian tools return, or set ${idAt}.teamId to ${cloudId}.` : null,
      });
    }
    for (const { key, at: keyAt, ids: projectIds, statuses } of projects.values()) {
      const lacking = withSite.filter((x) => !(x.info.projects ?? []).some((p) => p.key === key));
      const spelled = withSite.flatMap((x) => (x.info.projects ?? []).map((p) => p.key)).find((k) => k !== key && same(k, key)) ?? null;
      checks.push({
        id: `board.jira.project.${site}.${key}`,
        name: `Jira project ${key}`,
        ok: !lacking.length,
        detail: lacking.length ? `${key} is not a project on ${site} that ${lacking.map((x) => x.label).join(' or ')} can read${spelled ? `. Jira spells it ${spelled}` : ''}` : `${key} is a project on ${site}`,
        fix: !lacking.length ? null : spelled ? `Set ${[...keyAt].map((a) => `${a}.project`).join(' and ')} in the config to ${spelled}, exactly as Jira spells it.` : `Check the project key in ${[...keyAt].join(' and ')} of the config, or give ${lacking.map((x) => x.label).join(' and ')} access to it in Jira. Run \`bollplank init\` to choose it again.`,
      });
      const withProject = withSite.map((x) => ({ ...x, project: (x.info.projects ?? []).find((p) => p.key === key) ?? null })).filter((x) => x.project);
      if (!withProject.length) continue;
      const readId = withProject[0].project.id;
      for (const [id, idAt] of projectIds) {
        const differs = withProject.filter((x) => x.project.id !== id).map((x) => x.label);
        checks.push({
          id: `board.jira.projectId.${site}.${key}${projectIds.size > 1 && id ? `.${id}` : ''}`,
          name: `Jira project id of ${key}`,
          required: id !== null,
          ok: id !== null && !differs.length,
          detail: id === null ? `${idAt}.projectId is not set, so a readback cannot tell ${key} from a project of the same key elsewhere` : differs.length ? `${idAt}.projectId is ${id}, but ${differs.join(' and ')} read the id ${readId} for ${key}` : `${key} has the project id ${id}`,
          fix: id === null || differs.length ? `Run \`bollplank init\` to save the project id the Atlassian tools return, or set ${idAt}.projectId to ${readId}.` : null,
        });
      }
      const named = [...statuses.values()];
      for (const { key: k, name: status, at: sAt, required } of named) {
        const missing = withProject.filter((x) => !(x.project.statuses ?? []).includes(status));
        const spelledStatus = missing.flatMap((x) => x.project.statuses ?? []).find((v) => v !== status && same(v, status)) ?? null;
        const keys = [...sAt].join(' and ');
        const fresh = byHand.includes(status) ? ` A new Jira project has only ${BOARDS.jira.newTeam.join(', ')}, so a status named "${status}" is added by hand.` : '';
        checks.push({
          required,
          id: `board.jira.status.${site}.${key}.${k}${named.filter((x) => x.key === k).length > 1 ? `.${status}` : ''}`,
          name: `Jira status ${status}`,
          ok: !missing.length,
          detail: missing.length ? `${key} has no status named "${status}" that ${missing.map((x) => x.label).join(' or ')} can read${spelledStatus ? `. Jira spells it "${spelledStatus}"` : ''}` : `${key} has the status "${status}"`,
          fix: !missing.length ? null : spelledStatus ? `Set ${keys} in the config to "${spelledStatus}", exactly as Jira spells it.` : `${jiraAddStatusSteps(key, k, status)} Or set ${keys} in the config to a status that exists.${fresh}`,
        });
      }
    }
    for (const [space, spaceAt] of spaces) {
      const missing = withSite.filter((x) => !(x.info.spaces ?? []).includes(space)).map((x) => x.label);
      checks.push({
        id: `board.jira.space.${site}.${space}`,
        name: `Confluence space ${space}`,
        ok: !missing.length,
        detail: missing.length ? `${space} is not a Confluence space on ${site} that ${missing.join(' or ')} can read` : `${space} is a Confluence space on ${site}`,
        fix: missing.length ? `Check the space key in ${spaceAt}.space of the config, or give ${missing.join(' and ')} access to the space. Remove ${spaceAt}.space to keep release notes in the comment and the CHANGELOG only.` : null,
      });
    }
  }
  return checks.map((c) => ({ required: true, ...c }));
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

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// How to put dir on PATH in the person's shell: fish_add_path for fish, else the line for the
// profile file. bash on macOS opens a login shell, which reads ~/.bash_profile and not ~/.bashrc.
export function pathAdvice(dir, shell = process.env.SHELL, platform = process.platform) {
  const name = basename(shell ?? '');
  if (name === 'fish') return `run this once in fish, then open a new terminal: fish_add_path ${shellPath(dir)}`;
  const file = name === 'bash' ? (platform === 'darwin' ? '~/.bash_profile' : '~/.bashrc') : '~/.zshrc';
  return `add this line to ${file} and open a new terminal: export PATH="${shellPath(dir)}:$PATH"`;
}

// Bollplank finds a client in its app bundle, but the fixes it prints say `claude ...` or `codex ...`,
// which a shell runs only from PATH. So a client found only in its bundle warns, with the PATH line.
export function clientPathCheck(c, onPath, shell = process.env.SHELL, platform = process.platform) {
  const ok = Boolean(onPath);
  return {
    id: `path.${c.name}`,
    name: `${c.name} on PATH`,
    required: false,
    ok,
    detail: ok ? onPath : `${c.label} was found at ${c.bin}, but \`${c.name}\` is not on PATH, so the ${c.name} commands Bollplank suggests do not run as typed. Until it is, run them as ${c.bin}.`,
    fix: ok ? null : cap(pathAdvice(dirname(c.bin), shell, platform)),
  };
}

// The first file named cmd on PATH that the shell can run: a file, not a folder, that is
// executable. Windows has no executable bit, so there a file is enough.
export function findOnPath(cmd, env = process.env, platform = process.platform) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  const dirs = (key ? env[key] : '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const d of dirs) {
    const p = join(d, cmd);
    try {
      if (!statSync(p).isFile()) continue;
      if (platform !== 'win32') accessSync(p, constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}
