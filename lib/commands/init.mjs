// bollplank init [--answers <json file>] [--offline] [--json]
// Sets Bollplank up, and sets it up again: every earlier answer is offered as the default, and
// nothing is rewritten without asking. On a terminal it asks. With --answers it reads every answer
// from a JSON file by key, so tests and automation run the same steps.
//
//   1. finds Claude Code and Codex, their versions and their subscription sign ins
//   2. reads Linear from each client, and offers to add the Linear MCP when it cannot
//   3. the Linear team, project and the five statuses
//   4. the approver, the copy style and the critic default
//   5. optionally a first project: source folder, repos, checks, deploy and runs
//   6. writes config.json after it validates, keeping config.json.bak, and links the skills
//   7. runs doctor
//
// Answer keys: addLinear.claude, addLinear.codex, team, project, statuses.<draft|ready|inProgress|
// acceptance|done>, recheck.<status>, approver, copyStyle, critic, addProject, source, repos,
// projectName, replaceProject, tickets, github.<repo>, baseBranch.<repo>, checks.<repo>,
// deploy.<repo>, deployCommand.<repo>, deployWorkflow.<repo>, amplify.<repo>.<appId|region|branch|
// profile>, runs, writeConfig.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { parse } from '../args.mjs';
import { CRITICS, DEFAULT_STATUSES, DEPLOY_KINDS, STATUS_KEYS, validate } from '../config.mjs';
import { writeJsonAtomic } from '../fsx.mjs';
import { tryGit } from '../git.mjs';
import { emit, fail, say } from '../out.mjs';
import { expand, kitDir, paths } from '../paths.mjs';
import { childEnv } from '../providers/index.mjs';
import { findClients, keyVariables, SIGN_IN_HINT, versionNote } from '../setup/clients.mjs';
import { linkSkills, readInstallOrFail } from '../setup/links.mjs';
import { LINEAR_MCP_URL } from '../setup/probe.mjs';
import { asker } from '../setup/prompts.mjs';
import { collect as doctor, passed, render } from './doctor.mjs';

export const usage = 'bollplank init [--answers <json file>] [--offline] [--json]';

const DEFAULT_COPY_STYLE = 'Plain sentences. Say what to do. No filler.';

const STATUS_MEANING = {
  draft: 'a ticket whose brief is being written',
  ready: 'an approved ticket, ready to start',
  inProgress: 'a ticket being worked on',
  acceptance: 'a shipped ticket waiting for your acceptance test',
  done: 'an accepted ticket',
};
// The Linear status group each one belongs in, for the steps to create a missing one.
const STATUS_GROUP = { draft: 'Backlog', ready: 'Unstarted', inProgress: 'Started', acceptance: 'Started', done: 'Completed' };

export async function run(argv) {
  const { opts, positional, error } = parse(argv, { answers: 'value', offline: 'bool', json: 'bool' });
  if (error || positional.length) fail('usage', error ?? usage);
  let answers = null;
  if (opts.answers !== undefined) {
    try {
      answers = JSON.parse(readFileSync(opts.answers, 'utf8'));
    } catch (e) {
      fail('usage', `cannot read the answers file ${opts.answers}: ${e.code ?? e.message}`);
    }
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) fail('usage', 'the answers file must hold one JSON object');
  } else if (!process.stdin.isTTY) {
    fail('usage', 'init asks questions, so it needs a terminal. Run it in a terminal, or pass --answers <file> with the answers as JSON.');
  }
  const json = Boolean(opts.json);
  const offline = Boolean(opts.offline);
  const io = asker({ answers, json });
  const messages = [];
  const tell = (s) => (json ? messages.push(s) : say(s));
  const stdio = json ? [0, 2, 2] : 'inherit';
  try {
    const result = await setup({ io, tell, offline, stdio });
    if (json) emit({ ok: true, ...result, messages });
  } finally {
    io.close();
  }
}

async function setup({ io, tell, offline, stdio }) {
  // A corrupt install record stops init before it asks or writes anything.
  readInstallOrFail();
  const file = paths().config;
  const prevText = existsSync(file) ? readFileSync(file, 'utf8') : null;
  let prev = null;
  if (prevText !== null) {
    try {
      prev = JSON.parse(prevText);
    } catch (e) {
      tell(`${file} could not be read (${e.message}). Its answers are not offered as defaults. It is kept as config.json.bak when you save.`);
    }
    if (prev && (typeof prev !== 'object' || Array.isArray(prev))) prev = null;
    if (prev) tell(`Found your config at ${file}. Your earlier answers are the defaults.`);
  }
  const prevProject = prev?.projects && typeof prev.projects === 'object' ? Object.values(prev.projects)[0] : null;

  // 1. The clients.
  tell('\nStep 1 of 7: Claude Code and Codex');
  const clients = findClients();
  for (const c of clients) {
    if (!c.found) {
      tell(`- ${c.label}: not found.`);
      continue;
    }
    tell(`- ${versionNote(c)}`);
    tell(`  ${c.signIn.detail}${c.usable ? '' : ` Bollplank will not use it this way. ${SIGN_IN_HINT[c.name]}`}`);
  }
  const found = clients.filter((c) => c.found);
  const usable = clients.filter((c) => c.usable);
  if (!found.length) tell('Neither client was found. Bollplank needs Claude Code or Codex. Install one, then run `bollplank init` again.');
  const keys = keyVariables();
  if (keys.length) tell(`These key or provider variables are set in your shell: ${keys.join(', ')}. Bollplank removes them for critic calls and probes, so each client uses its own subscription sign in.`);

  // 2. Linear from each client.
  tell('\nStep 2 of 7: Linear');
  const env = childEnv(process.env);
  const linear = {};
  let teams = null;
  const probe = (c) => {
    const r = c.provider.probeLinear({ bin: c.bin, env, timeoutMs: 180000 });
    linear[c.name] = { ok: r.ok, detail: r.detail };
    if (r.ok && !teams) teams = r.teams;
    return r;
  };
  if (offline) tell('Skipped the Linear check, since --offline was given. Status names are not checked against Linear.');
  else if (!usable.length) tell('No client is signed in with a subscription, so Linear was not checked.');
  else {
    for (const c of usable) {
      let r = probe(c);
      tell(`- ${r.detail}`);
      if (r.ok) continue;
      if (!(await io.yes(['addLinear', c.name], `Add Linear's MCP server (${LINEAR_MCP_URL}) to ${c.label} now?`, false))) {
        tell(`  Left ${c.label} as it is. Run \`bollplank init\` again to add it later.`);
        continue;
      }
      tell('  A browser window opens for the Linear sign in. Finish it there, then come back here.');
      const added = c.provider.addLinearMcp({ bin: c.bin, env, url: LINEAR_MCP_URL, stdio });
      tell(`  ${added.detail}`);
      if (!added.ok) continue;
      r = probe(c);
      tell(`  Checked again: ${r.detail}`);
    }
  }

  // 3. The team, the project and the statuses.
  tell('\nStep 3 of 7: the Linear team, project and statuses');
  const teamNames = (teams ?? []).map((t) => t.key ?? t.name);
  const prevTeam = prevProject?.board?.team ?? prev?.board?.team;
  const team = teamNames.length
    ? await io.pick('team', 'Which Linear team holds your tickets?', teamNames, teamNames.includes(prevTeam) ? prevTeam : teamNames[0], { allowOther: true })
    : await io.text('team', 'Which Linear team holds your tickets? Its key, such as ACME:', prevTeam, { required: false });
  const teamInfo = (teams ?? []).find((t) => t.key === team || t.name === team) ?? null;
  const projects = teamInfo?.projects ?? [];
  const prevBoardProject = prevProject?.board?.project ?? prev?.board?.project;
  const project = projects.length
    ? await io.pick('project', 'Which Linear project?', projects, projects.includes(prevBoardProject) ? prevBoardProject : projects[0], { allowOther: true })
    : await io.text('project', 'Which Linear project? Leave it empty to choose later:', prevBoardProject, { required: false });
  const statuses = await askStatuses({ io, tell, prev: prev?.board?.statuses ?? {}, teamInfo, team, recheck: () => usable.find((c) => linear[c.name]?.ok) });
  tell(`Team ${team || 'not set'}, project ${project || 'not set'}. Statuses: ${STATUS_KEYS.map((k) => `${k} is ${statuses[k]}`).join(', ')}.`);

  // 4. The approver, the copy style and the critic.
  tell('\nStep 4 of 7: you and the critic');
  const gitName = spawnSync('git', ['config', 'user.name'], { encoding: 'utf8' }).stdout?.trim() || undefined;
  const approver = await io.text('approver', 'Your name, as the approver of briefs:', prev?.approver?.name ?? gitName);
  const copyStyle = await io.text('copyStyle', 'The copy style for briefs and comments:', prev?.copyStyle ?? DEFAULT_COPY_STYLE);
  const critic = await askCritic({ io, tell, prev: prev?.critic?.default, usable });
  tell(`Approver ${approver}. Critic ${critic}.`);

  // 5. A first project.
  tell('\nStep 5 of 7: a project');
  const existing = prev?.projects && typeof prev.projects === 'object' ? prev.projects : {};
  const count = Object.keys(existing).length;
  let added = null;
  if (await io.yes('addProject', count ? `You have ${count} project${count === 1 ? '' : 's'} (${Object.keys(existing).join(', ')}). Add another?` : 'Add a first project now?', count === 0)) {
    added = await askProject({ io, tell, existing, board: { team, project } });
    if (added) tell(`Project ${added.name} with ${Object.keys(added.project.repos).join(', ')}, runs ${added.project.runs ? 'on' : 'off'}.`);
  }

  // 6. The config and the links.
  tell('\nStep 6 of 7: saving');
  const next = {
    ...(prev ?? {}),
    approver: { ...(prev?.approver ?? {}), name: approver },
    copyStyle,
    board: { ...(prev?.board ?? {}), kind: 'linear', statuses, ...(team ? { team } : {}), ...(project ? { project } : {}) },
    critic: { ...(prev?.critic ?? {}), default: critic },
    projects: { ...existing, ...(added ? { [added.name]: added.project } : {}) },
  };
  const problems = validate(next);
  if (problems.length) fail('config', `the answers do not make a valid config, so nothing was written. ${problems.join('. ')}`);
  const text = JSON.stringify(next, null, 2) + '\n';
  let written = false;
  if (prevText !== null && prevText === text) tell(`${file} is unchanged.`);
  else if (prevText === null || (await io.yes('writeConfig', `Save the changes to ${file}? The old one is kept as config.json.bak.`, true))) {
    if (prevText !== null) copyFileSync(file, `${file}.bak`);
    writeJsonAtomic(file, next);
    written = true;
    tell(`Saved ${file}${prevText !== null ? `, with the old one in ${file}.bak` : ''}.`);
  } else tell(`Did not change ${file}.`);

  const links = linkSkills(found.map((c) => ({ name: c.name, dir: c.dir })));
  if (links.made.length) tell(`Linked ${links.made.length} skill${links.made.length === 1 ? '' : 's'}: ${[...new Set(links.made.map((l) => dirname(l.path)))].join(', ')}.`);
  if (links.kept.length) tell(`${links.kept.length} skill link${links.kept.length === 1 ? ' was' : 's were'} already in place.`);
  for (const s of links.skipped) tell(`Left ${s.path} alone. It is ${s.reason}. Move it away and run \`bollplank init\` again to link the skill there.`);
  for (const r of links.removed) tell(`Removed ${r.path}, a link to a skill the kit no longer has.`);
  if (!found.length) tell('No skills were linked, since no client was found.');

  // 7. Doctor.
  tell('\nStep 7 of 7: doctor');
  const checks = await doctor({ offline });
  tell(render(checks));
  tell(passed(checks) ? '\nBollplank is set up.' : '\nBollplank is set up, but doctor found problems. Fix them as it says, then run `bollplank doctor`.');
  return {
    config: file,
    written,
    kit: kitDir,
    clients: clients.map((c) => ({ name: c.name, found: c.found, version: c.version ?? null, tested: c.tested, subscription: c.usable, signIn: c.signIn?.detail ?? null })),
    keyVariables: keys,
    linear: offline ? 'skipped' : linear,
    critic,
    project: added?.name ?? null,
    links: { made: links.made.map((l) => l.path), kept: links.kept.map((l) => l.path), skipped: links.skipped.map((l) => ({ path: l.path, reason: l.reason })), removed: links.removed.map((l) => l.path) },
    doctor: { ok: passed(checks), checks },
  };
}

// Each of the five statuses is mapped to a name that exists in the team, when the probe could list
// them. A missing one is never created: the steps to create it are shown, and Linear is read again.
async function askStatuses({ io, tell, prev, teamInfo, team, recheck }) {
  const out = {};
  let options = teamInfo?.statuses ?? [];
  if (!options.length) tell('Bollplank could not list the statuses of this team, so the names below are not checked against Linear.');
  for (const k of STATUS_KEYS) {
    const question = `Which status means ${STATUS_MEANING[k]}?`;
    const match = (v) => options.find((o) => o.toLowerCase() === String(v ?? '').toLowerCase());
    if (!options.length) {
      out[k] = await io.text(['statuses', k], question, prev[k] ?? DEFAULT_STATUSES[k]);
      continue;
    }
    let v = await io.pick(['statuses', k], question, options, match(prev[k]) ?? match(DEFAULT_STATUSES[k]) ?? prev[k] ?? DEFAULT_STATUSES[k], { allowOther: true });
    for (let tries = 0; !match(v); tries++) {
      tell(`"${v}" is not a status of ${team} in Linear. Bollplank never creates one on its own. To add it, open Linear, go to Settings, then Teams, then ${team}, then Workflow. Under ${STATUS_GROUP[k]}, add a status named "${v}".`);
      const client = recheck();
      if (tries >= 3 || !client || !(await io.yes(['recheck', k], 'Check Linear again now?', false))) {
        tell(`Kept "${v}". Moving a ticket to it fails until it exists in Linear.`);
        break;
      }
      const r = client.provider.probeLinear({ bin: client.bin, env: childEnv(process.env), timeoutMs: 180000 });
      const t = r.ok ? r.teams.find((x) => x.key === team || x.name === team) : null;
      if (t) options = t.statuses;
      tell(match(v) ? `Found "${match(v)}" now.` : `Still no status named "${v}".`);
    }
    out[k] = match(v) ?? v;
  }
  return out;
}

// other needs both clients. With one, same is offered: a separate fresh session of the same model,
// labelled as such, weaker than a review by another vendor. An existing choice is the default, so
// nothing changes it without an answer.
async function askCritic({ io, tell, prev, usable }) {
  const both = usable.length === 2;
  if (!both) {
    const here = usable.length ? `Only ${usable[0].label} works with a subscription here.` : 'No client works with a subscription here yet.';
    tell(`${here} The critic "other" needs both Claude Code and Codex. With one client, "same" means a separate fresh session of the same model reviews the work. It is labelled as such, and it is weaker than a review by another vendor.`);
    if (prev === 'other') tell('Your config says "other". It stays that way unless you choose another one now, and critiques fail until both clients work.');
  }
  const def = CRITICS.includes(prev) ? prev : both ? 'other' : 'same';
  return io.pick('critic', 'Which critic reviews briefs, plans and code by default?', CRITICS, def);
}

async function askProject({ io, tell, existing, board }) {
  let given;
  for (;;) {
    given = resolve(expand(await io.text('source', 'The source folder of the project, holding its repo or its repos:')));
    if (isDir(given)) break;
    if (io.scripted) fail('usage', `the source folder ${given} does not exist`);
    tell(`${given} is not a folder. Try again.`);
  }
  // A folder that is itself a repo is saved as its parent folder and the repo's folder name, since
  // every command finds a repo at join(source, repo).
  const single = isGitRepo(given);
  const source = single ? dirname(given) : given;
  if (single) tell(`${given} is a git repo, so the project's source folder is ${source} and its repo is ${basename(given)}.`);
  const found = single ? [basename(given)] : readdirSync(source).filter((n) => isDir(join(source, n)) && isGitRepo(join(source, n))).sort();
  if (!found.length) {
    tell(`No git repo was found in ${source} or its folders, so no project was added.`);
    return null;
  }
  const dirOf = (name) => join(source, name);
  let repoNames = found;
  if (found.length > 1) {
    for (;;) {
      repoNames = await io.list('repos', `Which repos belong to the project? Found: ${found.join(', ')}. Names, comma separated:`, found);
      const unknown = repoNames.filter((n) => !found.includes(n));
      if (!unknown.length) break;
      if (io.scripted) fail('usage', `repos names ${unknown.join(', ')}, which are not git repos in ${source}`);
      tell(`${unknown.join(', ')} is not one of the found repos.`);
    }
  }
  const name = await io.text('projectName', 'A short name for the project:', slug(basename(given)));
  if (existing[name] && !(await io.yes('replaceProject', `A project named ${name} is already configured. Replace it?`, false))) {
    tell(`Kept the project ${name} as it was.`);
    return null;
  }
  const ticketsDefault = join(source, 'Tickets');
  const tickets = resolve(expand(await io.text('tickets', 'The folder for ticket work and worktrees:', tilde(ticketsDefault))));

  const repos = {};
  for (const repo of repoNames) {
    const dir = dirOf(repo);
    const detected = githubSlug(tryGit(dir, 'remote', 'get-url', 'origin'));
    const github = await io.text(['github', repo], `The GitHub repo of ${repo}, as owner/name:`, detected ?? undefined);
    const head = tryGit(dir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
    const baseBranch = await io.text(['baseBranch', repo], `The base branch of ${repo}:`, head?.startsWith('origin/') ? head.slice('origin/'.length) : 'main');
    const offered = ghChecks(github);
    if (!offered.checks.length) tell(`Bollplank could not read check names for ${github} from gh. Type them as GitHub shows them on a pull request.`);
    const checks = await io.list(['checks', repo], `The checks that must pass on a pull request to ${repo}, comma separated:`, offered.checks);
    const kind = await io.pick(['deploy', repo], `How does ${repo} deploy after a merge? none means nothing to wait for.`, DEPLOY_KINDS, 'none');
    const deploy = { kind };
    if (kind === 'command') deploy.command = await io.text(['deployCommand', repo], 'The command that waits for the deploy of {commit} and exits 0 when it is live:');
    if (kind === 'github-actions') deploy.workflow = await io.text(['deployWorkflow', repo], 'The name of the deploy workflow:', offered.workflows[0]);
    if (kind === 'amplify') {
      deploy.appId = await io.text(['amplify', repo, 'appId'], 'The Amplify app id:');
      deploy.region = await io.text(['amplify', repo, 'region'], 'The AWS region of the app:');
      const branch = await io.text(['amplify', repo, 'branch'], 'The Amplify branch, if it differs from the base branch:', '', { required: false });
      const profile = await io.text(['amplify', repo, 'profile'], 'The AWS profile to use, if not the default:', '', { required: false });
      if (branch) deploy.branch = branch;
      if (profile) deploy.profile = profile;
    }
    repos[repo] = { github, checks, baseBranch, deploy };
  }
  tell('Runs let an agent take an approved ticket from plan to merge and deploy on its own, within the project stop list. They are off unless you turn them on.');
  const runs = await io.yes('runs', `Turn on runs for ${name}?`, false);
  const project = { source: tilde(source), tickets: tilde(tickets), repos, shipOrder: repoNames, runs };
  if (board.team || board.project) project.board = Object.fromEntries(Object.entries(board).filter(([, v]) => v));
  return { name, project };
}

// The check names gh reports on the repo's latest pull request, else its workflow names.
function ghChecks(slug) {
  const gh = (...a) => {
    const r = spawnSync('gh', a, { encoding: 'utf8', timeout: 30000 });
    try {
      return JSON.parse(r.stdout);
    } catch {
      return null;
    }
  };
  if (!slug) return { checks: [], workflows: [] };
  const workflows = (gh('workflow', 'list', '-R', slug, '--json', 'name') ?? []).map((w) => w?.name).filter(Boolean);
  const pr = gh('pr', 'list', '-R', slug, '--state', 'all', '--limit', '1', '--json', 'number')?.[0]?.number;
  const checks = pr ? [...new Set((gh('pr', 'checks', String(pr), '-R', slug, '--json', 'name') ?? []).map((c) => c?.name).filter(Boolean))] : [];
  return { checks: checks.length ? checks : workflows, workflows };
}

// owner/name from git@github.com:owner/name.git or https://github.com/owner/name(.git).
export function githubSlug(url) {
  const m = url?.match(/github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isGitRepo(p) {
  return existsSync(join(p, '.git'));
}

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
}

function tilde(p) {
  const h = homedir();
  return p === h ? '~' : p.startsWith(h + sep) ? `~/${p.slice(h.length + 1)}` : p;
}
