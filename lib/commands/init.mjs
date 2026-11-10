// bollplank init [--answers <json file>] [--offline] [--json]
// Sets Bollplank up, and sets it up again: every earlier answer is offered as the default, and
// nothing is rewritten without asking. On a terminal it asks. With --answers it reads every answer
// from a JSON file by key, so tests and automation run the same steps.
//
//   1. finds Claude Code and Codex, their versions and their subscription sign ins
//   2. the board kind, Linear or Jira, then reads that board from each client, and offers to add
//      its MCP server when it cannot. A Jira setup never reads Linear, and a Linear one never Jira.
//   3. the board: for Linear the team, project and the five statuses, for Jira the site, project
//      key, the five statuses and an optional Confluence space. Statuses are offered as the board
//      kind's suggestion. The Jira cloud id and project id are saved from the probe's tool results,
//      never typed.
//   4. the approver, the copy style and the critic default
//   5. optionally a first project: source folder, its board kind, its team and project (site and
//      project key on Jira), its own statuses when it needs them, repos, checks, deploy and runs. A
//      kind init has not read yet in this run is read then.
//   6. writes config.json after it validates, keeping config.json.bak, and links the skills
//   7. runs doctor
//
// Init never writes to the board. A Linear project that is missing is created by the person, in
// their own Claude Code or Codex session or in Linear, and init reads Linear again to find it.
//
// Answer keys: kind (linear or jira, linear when left out), addBoard.<kind>.<client> (with
// addLinear.<client> still read for Linear), team (the Jira site on Jira), project (the Jira
// project key on Jira), space (Jira only), statuses.<draft|ready|inProgress|
// acceptance|done>, recheck.<status>, missingProject.<team>.<project> (other, session or linear),
// otherProject.<team>.<project>, approver, copyStyle, critic, addProject, source, repos,
// projectName, replaceProject, tickets, projects.<name>.<kind|team|project|space|mapping>,
// projects.<name>.statuses.<status>, projects.<name>.recheck.<status>, github.<repo>,
// baseBranch.<repo>, checks.<repo>, deploy.<repo>, deployCommand.<repo>, deployWorkflow.<repo>,
// amplify.<repo>.<appId|region|branch|profile>, runs, writeConfig.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { parse } from '../args.mjs';
import { BOARD_KINDS, BOARDS, isBoardKind, missingInNewTeam, suggestedStatuses } from '../boards.mjs';
import { CONFLUENCE_SPACE_KEY, CRITICS, DEPLOY_KINDS, JIRA_PROJECT_KEY, JIRA_SITE, pinProjects, STATUS_KEYS, validate } from '../config.mjs';
import { writeJsonAtomic } from '../fsx.mjs';
import { tryGit } from '../git.mjs';
import { emit, fail, say } from '../out.mjs';
import { expand, kitDir, paths } from '../paths.mjs';
import { childEnv } from '../providers/index.mjs';
import { findClients, keyVariables, SIGN_IN_HINT, versionNote } from '../setup/clients.mjs';
import { linkSkills, readInstallOrFail } from '../setup/links.mjs';
import { PROBES, siteHost } from '../setup/probe.mjs';
import { asker } from '../setup/prompts.mjs';
import { collect as doctor, passed, render } from './doctor.mjs';

export const usage = 'bollplank init [--answers <json file>] [--offline] [--json]';

const DEFAULT_COPY_STYLE = 'Plain sentences. No em or en dashes. No semicolons. No filler.';

const STATUS_MEANING = {
  draft: 'a ticket whose brief is being written',
  ready: 'an approved ticket, ready to start',
  inProgress: 'a ticket being worked on',
  acceptance: 'a shipped ticket waiting for your acceptance test',
  done: 'an accepted ticket',
};

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
    // A sign in that is not a subscription is never used. A client with no sign in only needs one.
    tell(`  ${c.signIn.detail}${c.usable ? '' : `${c.signIn.signedIn ? ' Bollplank will not use it this way.' : ''} ${SIGN_IN_HINT[c.name]}`}`);
  }
  const found = clients.filter((c) => c.found);
  const usable = clients.filter((c) => c.usable);
  if (!found.length) tell('Neither client was found. Bollplank needs Claude Code or Codex. Install one, then run `bollplank init` again.');
  const keys = keyVariables();
  if (keys.length) tell(`These key or provider variables are set in your shell: ${keys.join(', ')}. Bollplank removes them for critic calls and probes, so each client uses its own subscription sign in.`);

  // 2. The board kind, then that board from each client.
  tell('\nStep 2 of 7: the board');
  const prevBoard = isObject(prev?.board) ? prev.board : {};
  const kind = await io.pick('kind', 'Which kind of board holds your tickets? linear is Linear, jira is Jira on an Atlassian site.', BOARD_KINDS, isBoardKind(prevBoard.kind) ? prevBoard.kind : 'linear');
  // The earlier board answers are the defaults only for the same kind.
  const prevSame = (prevBoard.kind ?? 'linear') === kind;
  const env = childEnv(process.env);
  // Per kind: what each client said, and what the first client that read it returned, the teams
  // for Linear and the sites for Jira. Each kind is read once per run, the first time it is needed.
  const status = {};
  const data = {};
  const probed = new Set();
  const read = (k, c, target) => c.provider.probeBoard(k, { bin: c.bin, env, timeoutMs: 180000, ...(target ? { target } : {}) });
  const probe = (k, c) => {
    const r = read(k, c);
    (status[k] ??= {})[c.name] = { ok: r.ok, detail: r.detail };
    if (r.ok && !data[k]) data[k] = k === 'linear' ? r.teams : r.sites;
    return r;
  };
  const reader = (k) => usable.find((c) => status[k]?.[c.name]?.ok);
  // Reads Linear again for one team, with the same read only probe. undefined when no client reads
  // Linear, null when the read failed or has no such team.
  const rereadLinear = (name) => {
    const c = reader('linear');
    if (!c) return undefined;
    const r = read('linear', c);
    if (!r.ok) return null;
    data.linear = r.teams;
    return findTeam(data.linear, name);
  };
  // Reads Jira again for the projects and spaces in target, with the same read only probe. undefined
  // when no client reads Jira, null when the read failed, else the sites it read.
  const rereadJira = (target) => {
    const c = reader('jira');
    if (!c) return undefined;
    const r = read('jira', c, target);
    if (!r.ok) return null;
    data.jira = r.sites;
    return r.sites;
  };
  // Looks a Confluence space up on a site, client by client, since reading Jira does not prove a
  // client can read Confluence. found: the key was read, or a listed space has it as its name, and
  // key is the space's key. missing: a list of the site's spaces was read and has no such space.
  // unreadable: no client could read the site's spaces. The first found or missing wins.
  const findSpace = ({ site, space }) => {
    for (const c of usable.filter((x) => status.jira?.[x.name]?.ok)) {
      // Only the space is read. The project's statuses were read when it was asked.
      const r = read('jira', c, { projects: [], spaces: [space] });
      const info = r.ok ? (r.sites ?? []).find((x) => x.site === site) : null;
      if (!info) continue;
      const key = (info.spaces ?? []).find((k) => sameName(k, space)) ?? (info.spaceList ?? []).find((l) => sameName(l.key, space))?.key;
      if (key) return { state: 'found', key, client: c.label };
      const byName = (info.spaceList ?? []).find((l) => sameName(l.name, space));
      if (byName) return { state: 'found', key: byName.key, name: byName.name, client: c.label };
      if (info.spaceList) return { state: 'missing', client: c.label };
    }
    return { state: 'unreadable' };
  };
  const linearIo = { io, tell, reread: rereadLinear, canRead: () => Boolean(reader('linear')) };
  const jiraIo = { io, tell, reread: rereadJira, canRead: () => Boolean(reader('jira')), findSpace };
  // The add question per kind. An answers file may still say addLinear.<client> for Linear.
  const askAdd = async (k, c, question) => {
    if (io.scripted && k === 'linear') {
      const v = await io.yes(['addBoard', 'linear', c.name], question, null);
      if (typeof v === 'boolean') return v;
      return io.yes(['addLinear', c.name], question, false);
    }
    return io.yes(['addBoard', k, c.name], question, false);
  };
  const readKind = async (k) => {
    probed.add(k);
    status[k] ??= {};
    const { label, server } = PROBES[k];
    if (offline) return tell(`Skipped the ${label} check, since --offline was given. Status names are not checked against ${label}.`);
    if (!usable.length) return tell(`No client is signed in with a subscription, so ${label} was not checked.`);
    const url = BOARDS[k].server.urls[0];
    for (const c of usable) {
      let r = probe(k, c);
      tell(`- ${r.detail}`);
      if (r.ok) continue;
      // A probe stopped by the client's own settings is not fixed by adding the MCP server.
      if (r.blocked) {
        tell(`  ${r.fix}`);
        continue;
      }
      if (!(await askAdd(k, c, `Add ${server}'s MCP server (${url}) to ${c.label} now?`))) {
        tell(`  Left ${c.label} as it is. Run \`bollplank init\` again to add it later.`);
        continue;
      }
      tell(`  A browser window opens for the ${server} sign in. Finish it there, then come back here.`);
      const added = c.provider.addBoardMcp(k, { bin: c.bin, env, url, stdio });
      tell(`  ${added.detail}`);
      if (!added.ok) continue;
      r = probe(k, c);
      tell(`  Checked again: ${r.detail}`);
    }
  };
  // A kind init has not read in this run, such as a Jira project added to a Linear config, is read
  // when a project first needs it.
  const ensure = async (k, why) => {
    if (probed.has(k)) return;
    tell(why);
    await readKind(k);
  };
  await readKind(kind);

  // 3. The board: the team or site, the project and the statuses.
  let top;
  if (kind === 'linear') {
    tell('\nStep 3 of 7: the Linear team, project and statuses');
    const picked = await askTeam({ io, tell, key: 'team', question: 'Which Linear team holds your tickets?', teams: data.linear, def: prevSame ? (prev?.board?.team ?? prevProject?.board?.team) : undefined });
    const team = picked.team;
    const board = await askLinearProject({ ...linearIo, key: 'project', question: 'Which Linear project?', team, info: picked.info, def: prevSame ? (prev?.board?.project ?? prevProject?.board?.project) : undefined });
    const project = board.project;
    const statuses = await askStatuses({ ...linearIo, keys: { status: (k) => ['statuses', k], recheck: (k) => ['recheck', k] }, prev: (prevSame ? prev?.board?.statuses : null) ?? {}, teamInfo: board.info, team });
    tell(`Team ${team || 'not set'}, project ${project || 'not set'}. Statuses: ${STATUS_KEYS.map((k) => `${k} is ${statuses[k]}`).join(', ')}.`);
    top = { team, project, statuses };
  } else {
    tell('\nStep 3 of 7: the Jira site, project and statuses');
    const was = prevSame ? prevBoard : {};
    const where = await askJira({ ...jiraIo, keys: { team: 'team', project: 'project' }, whose: 'your tickets', def: { team: was.team, project: was.project }, sites: data.jira });
    const statuses = await askStatuses({ ...jiraIo, reread: where.rereadStatuses, kind: 'jira', keys: { status: (k) => ['statuses', k], recheck: (k) => ['recheck', k] }, prev: was.statuses ?? {}, teamInfo: where.info, team: where.project });
    const space = await askSpace({ ...jiraIo, key: 'space', def: was.space, site: where.team, project: where.project });
    // The ids come from the tools. Offline, the earlier ones stay while the site and project do.
    const teamId = where.teamId ?? (was.team === where.team ? was.teamId : undefined);
    const projectId = where.projectId ?? (was.team === where.team && was.project === where.project ? was.projectId : undefined);
    tell(`Site ${where.team || 'not set'}, project ${where.project || 'not set'}${space ? `, space ${space}` : ''}. Statuses: ${STATUS_KEYS.map((k) => `${k} is ${statuses[k]}`).join(', ')}.`);
    top = { team: where.team, project: where.project, statuses, teamId, projectId, space };
  }
  const { team, project, statuses } = top;
  // A project the new kind does not fit stays on the board it had, with that board written out on it.
  const pins = pinProjects(prev, kind);
  for (const p of pins.pinned) {
    const where = p.kind === 'jira' ? `Jira site ${p.team || 'not set'}, project ${p.project || 'not set'}` : `Linear team ${p.team || 'not set'}, project ${p.project || 'not set'}`;
    tell(`${p.name} stays on its ${BOARDS[p.kind].label} board, ${where}. Its board is now written out on the project, since step 3's board is ${BOARDS[kind].label}. To move it, set it up again in step 5.`);
  }

  // 4. The approver, the copy style and the critic.
  tell('\nStep 4 of 7: you and the critic');
  const gitName = spawnSync('git', ['config', 'user.name'], { encoding: 'utf8' }).stdout?.trim() || undefined;
  const approver = await io.text('approver', 'Your name, as the approver of briefs:', prev?.approver?.name ?? gitName);
  const copyStyle = await io.text('copyStyle', 'The copy style for briefs and comments:', prev?.copyStyle ?? DEFAULT_COPY_STYLE);
  const critic = await askCritic({ io, tell, prev: prev?.critic?.default, usable });
  tell(`Approver ${approver}. Critic ${critic}.`);

  // 5. A first project.
  tell('\nStep 5 of 7: a project');
  const existing = pins.projects;
  const count = Object.keys(existing).length;
  let added = null;
  if (await io.yes('addProject', count ? `You have ${count} project${count === 1 ? '' : 's'} (${Object.keys(existing).join(', ')}). Add another?` : 'Add a first project now?', count === 0)) {
    added = await askProject({ io, tell, linearIo, jiraIo, existing, topKind: kind, board: top, data: (k) => data[k], ensure });
    if (added) {
      const b = added.project.board ?? {};
      const where = (b.kind ?? kind) === 'jira' ? `Jira site ${b.team || 'not set'}, project ${b.project || 'not set'}${b.space ? `, space ${b.space}` : ''}` : `Linear team ${b.team || 'not set'}, project ${b.project || 'not set'}`;
      tell(`Project ${added.name} with ${Object.keys(added.project.repos).join(', ')}, runs ${added.project.runs ? 'on' : 'off'}. ${where}, ${b.statuses ? 'with its own statuses' : 'with the board\'s statuses'}.`);
    }
  }

  // 6. The config and the links.
  tell('\nStep 6 of 7: saving');
  const next = {
    ...(prev ?? {}),
    approver: { ...(prev?.approver ?? {}), name: approver },
    copyStyle,
    board: kind === 'linear'
      ? { ...(prevSame ? (prev?.board ?? {}) : {}), kind: 'linear', statuses, ...(team ? { team } : {}), ...(project ? { project } : {}) }
      : {
          ...(prevSame ? Object.fromEntries(Object.entries(prevBoard).filter(([k]) => !JIRA_FIELDS.includes(k))) : {}),
          kind: 'jira',
          statuses,
          ...(team ? { team } : {}),
          ...(project ? { project } : {}),
          ...(top.teamId ? { teamId: top.teamId } : {}),
          ...(top.projectId ? { projectId: top.projectId } : {}),
          ...(top.space ? { space: top.space } : {}),
        },
    critic: { ...(prev?.critic ?? {}), default: critic },
    projects: { ...existing, ...(added ? { [added.name]: added.project } : {}) },
  };
  const problems = validate(next);
  if (problems.length) {
    // The answers are kept, so a second run need not ask them all again.
    const kept = join(dirname(file), 'config.answers.json');
    let saved = false;
    try {
      writeJsonAtomic(kept, io.answered());
      saved = true;
    } catch {
      // The failure below still names the problems.
    }
    const again = saved ? ` Your answers are in ${kept}. Fix what the problems name, in that file or in the config, then run \`bollplank init --answers "${kept}"\`.` : '';
    fail('config', `the answers do not make a valid config, so nothing was written. ${problems.join('. ')}.${again}`);
  }
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
  const checks = await doctor({ offline, progress: tell });
  tell(render(checks));
  tell(passed(checks) ? '\nBollplank is set up.' : '\nBollplank is set up, but doctor found problems. Fix them as it says, then run `bollplank doctor`.');
  return {
    config: file,
    written,
    kit: kitDir,
    clients: clients.map((c) => ({ name: c.name, found: c.found, version: c.version ?? null, tested: c.tested, subscription: c.usable, signIn: c.signIn?.detail ?? null })),
    keyVariables: keys,
    kind,
    linear: offline ? 'skipped' : (status.linear ?? {}),
    boards: offline ? 'skipped' : status,
    critic,
    project: added?.name ?? null,
    links: { made: links.made.map((l) => l.path), kept: links.kept.map((l) => l.path), skipped: links.skipped.map((l) => ({ path: l.path, reason: l.reason })), removed: links.removed.map((l) => l.path) },
    doctor: { ok: passed(checks), checks },
  };
}

// Names are saved exactly as Linear returned them, since doctor and the board skill compare them
// exactly. A name typed in another case takes Linear's spelling.
const sameName = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

function findTeam(teams, name) {
  return (teams ?? []).find((t) => t.key === name || t.name === name) ?? (teams ?? []).find((t) => sameName(t.key, name) || sameName(t.name, name)) ?? null;
}

async function askTeam({ io, tell, key, question, teams, def }) {
  const names = (teams ?? []).map((t) => t.key ?? t.name);
  const picked = names.length
    ? await io.pick(key, question, names, names.includes(def) ? def : names[0], { allowOther: true })
    : await io.text(key, `${question} Its key, such as ACME:`, def, { required: false });
  const info = findTeam(teams, picked);
  const team = !info || info.key === picked || info.name === picked ? picked : sameName(info.key, picked) ? info.key : info.name;
  if (team !== picked) tell(`Saved the team as ${team}, the way Linear spells it.`);
  return { team, info };
}

// A Linear project of the team. When Linear was read and the project is not in it, init offers to
// pick another, to create it from the person's own Claude Code or Codex session, or to create it in
// Linear by hand. Init never creates it. After a create it reads Linear again, up to three times,
// and continues only once the project is there.
async function askLinearProject({ io, tell, reread, canRead, key, question, team, info, def }) {
  const ask = async (k, q, d) => {
    const projects = info?.projects ?? [];
    // A team with no projects gets a text question that says a project is not the team.
    if (!projects.length && info) tell(`${team} has no Linear projects yet. A project groups tickets inside the team. Type a name for a new one, such as Acme Shop, and init helps you create it.`);
    const picked = projects.length
      ? await io.pick(k, `${q} Pick one, or type the name of a new one.`, projects, projects.includes(d) ? d : projects[0], { allowOther: true })
      : await io.text(k, `${q} The name of a project in ${team || 'the team'}, not the team's key. Leave it empty to choose later:`, d, { required: false });
    const project = projects.find((p) => p === picked) ?? projects.find((p) => sameName(p, picked)) ?? picked;
    if (project !== picked) tell(`Saved the project as ${project}, the way Linear spells it.`);
    return project;
  };
  let project = await ask(key, question, def);
  const asked = new Set();
  const inTeam = () => (info?.projects ?? []).find((p) => p === project) ?? (info?.projects ?? []).find((p) => sameName(p, project));
  while (project && info && !inTeam()) {
    // An answers file that names the same missing project again would ask forever.
    if (io.scripted && asked.has(project)) fail('usage', `otherProject names ${project} again, which is not a project of ${team} in Linear`);
    asked.add(project);
    tell(`${project} is not a project of ${team} in Linear. Bollplank never creates one on its own. You can:`);
    tell('  other: pick another project');
    tell('  session: create it from a new Claude Code or Codex session');
    tell('  linear: create it in Linear yourself');
    const choice = await io.pick(['missingProject', team, project], 'Which one?', ['other', 'session', 'linear'], canRead() ? 'session' : 'other');
    if (choice === 'other') {
      project = await ask(['otherProject', team, project], 'Which Linear project instead?', '');
      continue;
    }
    if (choice === 'session') tell(`Start a new Claude Code or Codex session, in any folder, and ask this:\n  Create the Linear project ${project} in team ${team}\nIf the session asks you to allow the call, check that it names the team ${team} and the project ${project}. Otherwise check that its reply names them. Come back here once the project exists, and init reads Linear again.`);
    else tell(`Open Linear, go to Projects, and create a project named "${project}" exactly, with ${team} as its team. Come back here once it is done.`);
    for (let tries = 1; ; tries++) {
      await io.pause('Press Enter to read Linear again.');
      const fresh = reread(team);
      if (fresh) info = fresh;
      const found = inTeam();
      if (found) {
        tell(`Found the project ${found} in ${team} now.`);
        project = found;
        break;
      }
      tell(`Still no project named ${project} in ${team}.`);
      if (tries >= 3) fail('missing-project', `Linear still has no project named ${project} in ${team} after three reads, so init stopped and saved nothing. Create the project, then run \`bollplank init\` again.`);
    }
  }
  return { project, info };
}

// The board fields a Jira board answer replaces.
const JIRA_FIELDS = ['team', 'project', 'statuses', 'teamId', 'projectId', 'space'];

// The Jira site and project. The site is picked from those the probe read, and the project from
// that site's projects. Once the project is chosen, Jira is read again for its statuses with the
// same read only probe. The cloud id and project id come from what the tools returned, never from
// an answer. rereadStatuses reads Jira again for askStatuses.
async function askJira({ io, tell, reread, canRead, keys, whose, def = {}, sites }) {
  const hosts = (sites ?? []).map((s) => s.site);
  const q = `Which Jira site holds ${whose}?`;
  // An answer that is not a Jira site is asked again, and with an answers file it stops init here.
  let site;
  let siteDef = def.team;
  for (;;) {
    const answer = hosts.length
      ? await io.pick(keys.team, q, hosts, hosts.includes(siteDef) ? siteDef : hosts[0], { allowOther: true })
      : await io.text(keys.team, `${q} Its host, such as acme.atlassian.net. Leave it empty to choose later:`, siteDef, { required: false });
    site = answer ? (siteHost(answer) ?? answer) : '';
    if (!site || JIRA_SITE.test(site)) {
      if (site !== answer) tell(`Saved the site as ${site}.`);
      io.saved(keys.team, site);
      break;
    }
    const why = `${answer} is not a Jira site. Give its host, such as acme.atlassian.net`;
    if (io.scripted) fail('usage', `${keyName(keys.team)}: ${why}.`);
    tell(`${why}.`);
    siteDef = undefined;
  }
  let siteInfo = (sites ?? []).find((s) => s.site === site) ?? null;
  if (site && hosts.length && !siteInfo) tell(`${site} is not a site the Atlassian tools returned. \`bollplank doctor\` fails until a client can read it.`);
  const listed = (siteInfo?.projects ?? []).map((p) => p.key);
  const pq = `Which Jira project holds ${whose}?`;
  // A typed key in another case, or a listed project's name, becomes its key. Any other key is
  // saved in capitals, and one that is still not a Jira project key is asked again.
  let project;
  let projectDef = def.project;
  for (;;) {
    const typed = listed.length
      ? await io.pick(keys.project, `${pq} Pick its key, or type another.`, listed, listed.includes(projectDef) ? projectDef : listed[0], { allowOther: true })
      : await io.text(keys.project, `${pq} Its key, such as ACME. Leave it empty to choose later:`, projectDef, { required: false });
    const byKey = listed.find((k) => k === typed) ?? listed.find((k) => sameName(k, typed));
    const named = byKey ? undefined : (siteInfo?.projects ?? []).find((p) => sameName(p.name, typed))?.key;
    project = byKey ?? named ?? (typed ? typed.trim().toUpperCase() : '');
    if (!project || JIRA_PROJECT_KEY.test(project)) {
      io.saved(keys.project, project);
      if (project !== typed) tell(named ? `${typed} is the Jira project ${project}, so its key ${project} is saved.` : `Saved the project key as ${project}${listed.includes(project) ? ', the way Jira spells it' : ''}.`);
      break;
    }
    const why = `${typed} is not a Jira project key. A key is 2 to 10 capital letters, digits or underscores that starts with a letter, such as ACME. It is the prefix of the project's issue keys`;
    if (io.scripted) fail('usage', `${keyName(keys.project)}: ${why}.`);
    tell(`${why}.`);
    projectDef = undefined;
  }
  let projectInfo = siteInfo?.projects.find((p) => p.key === project) ?? null;
  const again = () => {
    const fresh = reread({ projects: [project] });
    if (fresh) {
      siteInfo = fresh.find((s) => s.site === site) ?? null;
      projectInfo = siteInfo?.projects.find((p) => p.key === project) ?? null;
    }
    return fresh;
  };
  if (site && project && canRead()) again();
  if (site && project && siteInfo && !projectInfo) tell(`${project} is not a Jira project on ${site} that the Atlassian tools returned. Check the key. \`bollplank doctor\` fails until a client can read it.`);
  const info = () => (projectInfo ? { name: project, statuses: projectInfo.statuses ?? [] } : null);
  return {
    team: site,
    project,
    teamId: siteInfo?.cloudId,
    projectId: projectInfo?.id,
    info: info(),
    rereadStatuses: () => {
      const fresh = again();
      return fresh ? info() : fresh;
    },
  };
}

// The optional Confluence space for the Release notes page. It is looked up with the same read
// only probe, client by client (findSpace). A space typed by its name is saved as its key. One no
// client finds while a list of the site's spaces was read is asked again. When no client can read
// the site's spaces, the answer is kept as typed, so doctor names it. inherit is the board's space
// a project of the same kind uses when it names none.
async function askSpace({ io, tell, canRead, findSpace, key, def, site, project, inherit = null }) {
  let spaceDef = def ?? '';
  for (;;) {
    const space = (await io.text(key, `The Confluence space key for the Release notes page. ${inherit ? `Leave it empty to use the board's space ${inherit}` : 'Leave it empty for none'}:`, spaceDef, { required: false })).trim();
    spaceDef = '';
    if (!space) return space;
    const isKey = CONFLUENCE_SPACE_KEY.test(space);
    let why;
    // A space is looked up before its form is checked, so a name such as "Acme space" is found too.
    if (site && canRead()) {
      const found = findSpace({ site, space });
      if (found.state === 'found') {
        tell(found.name ? `${space} is the name of the space ${found.key} on ${site}, so its key ${found.key} is saved.` : `Found the space ${found.key} on ${site}.`);
        io.saved(key, found.key);
        return found.key;
      }
      if (found.state === 'missing') why = `${space} is neither the key nor the name of a Confluence space on ${site} that ${found.client} can read`;
      else if (isKey) {
        tell(`No client could read the Confluence spaces of ${site}, so ${space} is kept as typed. \`bollplank doctor\` fails until a client can read it.`);
        io.saved(key, space);
        return space;
      } else why = `No client could read the Confluence spaces of ${site}, and ${space} is not a Confluence space key, such as ACME`;
    } else if (isKey) return space;
    else why = `${space} is not a Confluence space key, such as ACME`;
    if (io.scripted) fail('usage', `${keyName(key)}: ${why}.`);
    tell(`${why}. Type its key, or leave it empty for none.`);
  }
}

// Each of the five statuses is mapped to a name that exists in the team (the project on Jira), when
// the probe could list them. A missing one is never created: the steps to create it are shown, and
// the board is read again. Each default is the earlier answer, then fallback (the board's mapping,
// for a project), then the board kind's suggestion.
async function askStatuses({ io, tell, reread, canRead, keys, prev, fallback = {}, teamInfo, team, kind = 'linear' }) {
  const out = {};
  const suggested = suggestedStatuses(kind);
  const { label, noun, statusSteps, statusesSteps } = PROBES[kind];
  let options = teamInfo?.statuses ?? [];
  if (options.length) tell(`The statuses of ${team} in ${label}: ${options.join(', ')}.`);
  else tell(`Bollplank could not list the statuses of this ${noun}, so the names below are not checked against ${label}.`);
  tell(`Bollplank moves each ticket through five workflow states. Map each one to a status of the ${noun}:`);
  for (const k of STATUS_KEYS) tell(`  ${k}: ${STATUS_MEANING[k]}.`);
  // Name only the suggested statuses this team lacks. A team that has them all needs no advice.
  const has = (v) => options.some((o) => o.toLowerCase() === v.toLowerCase());
  const lacking = options.length ? Object.values(suggested).filter((v) => !has(v)) : missingInNewTeam(kind);
  if (!options.length) tell(`A new ${label} ${noun} has ${BOARDS[kind].newTeam.join(', ')}. It lacks ${lacking.join(', ')}, so add those in ${label}'s settings or map their states to statuses the ${noun} has.`);
  else if (lacking.length) {
    const one = lacking.length === 1;
    tell(`${team} lacks ${lacking.join(', ')}. ${one ? `Add it now, or map its state to a status the ${noun} has.` : `Add them now, or map their states to statuses the ${noun} has.`}`);
    tell(`To add ${one ? 'it' : 'them'}: ${statusesSteps(teamInfo?.name ?? team, STATUS_KEYS.filter((k) => lacking.includes(suggested[k])).map((k) => [k, suggested[k]]))}`);
  }
  for (const k of STATUS_KEYS) {
    const question = `Which status means ${STATUS_MEANING[k]}?`;
    const match = (v) => options.find((o) => o.toLowerCase() === String(v ?? '').toLowerCase());
    const def = prev[k] ?? fallback[k] ?? suggested[k];
    if (!options.length) {
      out[k] = await io.text(keys.status(k), question, def);
      continue;
    }
    let v = await io.pick(keys.status(k), question, options, match(prev[k]) ?? match(fallback[k]) ?? match(suggested[k]) ?? def, { allowOther: true });
    for (let tries = 0; !match(v); tries++) {
      if (!tries) tell(lacking.includes(v) && options.length ? `"${v}" is not a status of ${team} in ${label} yet. Add it as above, then check again.` : `"${v}" is not a status of ${team} in ${label}. Bollplank never creates one on its own. To add it: ${statusSteps(teamInfo?.name ?? team, k, v)}`);
      if (tries >= 3 || !canRead() || !(await io.yes(keys.recheck(k), `Check ${label} again now?`, false))) {
        tell(`Kept "${v}". \`bollplank doctor\` fails until a status named "${v}" exists in ${team}, and moving a ticket to it fails too.`);
        break;
      }
      const t = reread(team);
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

async function askProject({ io, tell, linearIo, jiraIo, existing, topKind, board, data, ensure }) {
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
  const name = await io.text('projectName', 'A short name for the project:', slug(basename(given)));
  // Init sets up repository projects only. A consulting or configuration project of the same name
  // is kept as it is unless the person replaces it with a new repository project.
  const was = existing[name];
  const mode = isObject(was) ? (was.mode ?? 'repository') : 'repository';
  if (was !== undefined && mode !== 'repository') {
    tell(`${name} is a ${mode} project. Init sets up repository projects only, so it cannot set ${name} up again. Keeping it leaves it as it is.`);
    if (!(await io.yes('replaceProject', `Replace ${name} with a new repository project? Its ${mode} settings are not kept.`, false))) {
      tell(`Kept the project ${name} as it was.`);
      return null;
    }
  } else if (was !== undefined && !(await io.yes('replaceProject', `A project named ${name} is already configured. Replace it?`, false))) {
    tell(`Kept the project ${name} as it was.`);
    return null;
  }
  // A repository project that is set up again offers every earlier answer as the default, and
  // keeps the settings init does not ask about.
  const prev = isObject(was) && mode === 'repository' ? was : {};
  const prevRepos = isObject(prev.repos) ? prev.repos : {};
  let repoNames = found;
  if (found.length > 1) {
    const kept = found.filter((n) => prevRepos[n]);
    for (;;) {
      repoNames = await io.list('repos', `Which repos belong to the project? Found: ${found.join(', ')}. Names, comma separated:`, kept.length ? kept : found);
      const unknown = repoNames.filter((n) => !found.includes(n));
      if (!unknown.length) break;
      if (io.scripted) fail('usage', `repos names ${unknown.join(', ')}, which are not git repos in ${source}`);
      tell(`${unknown.join(', ')} is not one of the found repos.`);
    }
  }
  const ticketsDefault = typeof prev.tickets === 'string' && prev.tickets ? prev.tickets : tilde(join(source, 'Tickets'));
  const tickets = resolve(expand(await io.text('tickets', 'The folder for ticket work and worktrees:', ticketsDefault)));

  // The project's board kind, then its team and project (its site and project key on Jira), which
  // default to step 3's for the same kind, and its own statuses when it needs them. A team or project
  // other than step 3's maps its own by default. A board of another kind than step 3's takes nothing
  // from it, so it maps its own statuses. A kind not read yet in this run is read now.
  const prevBoard = isObject(prev.board) ? prev.board : {};
  const boardKind = await io.pick(['projects', name, 'kind'], `Which kind of board holds the tickets of ${name}? ${topKind} is the board of step 3.`, BOARD_KINDS, isBoardKind(prevBoard.kind) ? prevBoard.kind : topKind);
  const other = boardKind !== topKind;
  await ensure(boardKind, `${name} uses a ${BOARDS[boardKind].label} board, so init reads ${BOARDS[boardKind].label} now.`);
  const base = other ? { statuses: {} } : board;
  const prevSame = (prevBoard.kind ?? topKind) === boardKind;
  const wasBoard = prevSame ? prevBoard : {};
  const ownKeys = { status: (k) => ['projects', name, 'statuses', k], recheck: (k) => ['projects', name, 'recheck', k] };
  let fields;
  if (boardKind === 'linear') {
    const own = await askTeam({ io, tell, key: ['projects', name, 'team'], question: `Which Linear team holds the tickets of ${name}?`, teams: data('linear'), def: wasBoard.team ?? base.team });
    const picked = await askLinearProject({ ...linearIo, key: ['projects', name, 'project'], question: `Which Linear project holds the tickets of ${name}?`, team: own.team, info: own.info, def: wasBoard.project ?? base.project });
    const differs = Boolean(own.team) && own.team !== base.team;
    const mapping = other ? 'own' : await io.pick(['projects', name, 'mapping'], `Which statuses does ${name} use? board: the ones you mapped in step 3. own: map its own, for a team with other status names.${differs ? ` ${name} is in ${own.team}, not ${base.team || 'step 3\'s team'}, so own is the default.` : ''}`, ['board', 'own'], wasBoard.statuses || differs ? 'own' : 'board');
    const statuses = mapping === 'own' ? await askStatuses({ ...linearIo, keys: ownKeys, prev: wasBoard.statuses ?? {}, fallback: base.statuses, teamInfo: picked.info, team: own.team }) : null;
    fields = { team: own.team, project: picked.project, statuses };
  } else {
    const where = await askJira({ ...jiraIo, keys: { team: ['projects', name, 'team'], project: ['projects', name, 'project'] }, whose: `the tickets of ${name}`, def: { team: wasBoard.team ?? base.team, project: wasBoard.project ?? base.project }, sites: data('jira') });
    const differs = Boolean(where.team) && (where.team !== base.team || where.project !== base.project);
    const mapping = other ? 'own' : await io.pick(['projects', name, 'mapping'], `Which statuses does ${name} use? board: the ones you mapped in step 3. own: map its own, for a project with other status names.${differs ? ` ${name} is in ${where.project || 'another project'} on ${where.team}, not step 3's project, so own is the default.` : ''}`, ['board', 'own'], wasBoard.statuses || differs ? 'own' : 'board');
    const statuses = mapping === 'own' ? await askStatuses({ ...jiraIo, reread: where.rereadStatuses, kind: 'jira', keys: ownKeys, prev: wasBoard.statuses ?? {}, fallback: base.statuses, teamInfo: where.info, team: where.project }) : null;
    const space = await askSpace({ ...jiraIo, key: ['projects', name, 'space'], def: wasBoard.space, site: where.team, project: where.project, inherit: !other && base.space ? base.space : null });
    fields = { team: where.team, project: where.project, statuses, space, teamId: where.teamId, projectId: where.projectId };
  }

  // Each repo's GitHub name and base branch first, then runs. Checks and a deploy matter only to
  // runs, so they are asked only when runs are on. With runs off the earlier ones are kept.
  const repos = {};
  for (const repo of repoNames) {
    const dir = dirOf(repo);
    const was = isObject(prevRepos[repo]) ? prevRepos[repo] : {};
    const detected = githubSlug(tryGit(dir, 'remote', 'get-url', 'origin'));
    const github = await io.text(['github', repo], `The GitHub repo of ${repo}, as owner/name:`, was.github ?? detected ?? undefined);
    const head = tryGit(dir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
    const baseBranch = await io.text(['baseBranch', repo], `The base branch of ${repo}:`, was.baseBranch ?? (head?.startsWith('origin/') ? head.slice('origin/'.length) : 'main'));
    repos[repo] = { ...was, github, baseBranch };
  }
  tell('Runs let an agent take an approved ticket from plan to merge and deploy on its own. A run stops and asks you before anything risky, such as deleting real data or work outside the ticket. They are off unless you turn them on.');
  const runs = await io.yes('runs', `Turn on runs for ${name}?`, prev.runs === true);
  if (!runs) tell('Runs are off, so init does not ask for checks or a deploy. Run `bollplank init` again to turn runs on, and it asks for them then.');
  for (const repo of runs ? repoNames : []) {
    const was = repos[repo];
    const { github } = was;
    const wasDeploy = isObject(was.deploy) ? was.deploy : {};
    const offered = ghChecks(github);
    const wasChecks = Array.isArray(was.checks) && was.checks.length ? was.checks : null;
    if (!wasChecks && !offered.checks.length) tell(`Bollplank could not read check names for ${github} from gh. Type them as GitHub shows them on a pull request.`);
    const checks = await io.list(['checks', repo], `The checks that must pass on a pull request to ${repo}, comma separated:`, wasChecks ?? offered.checks);
    const kind = await io.pick(['deploy', repo], `How does ${repo} deploy after a merge? none means nothing to wait for.`, DEPLOY_KINDS, DEPLOY_KINDS.includes(wasDeploy.kind) ? wasDeploy.kind : 'none');
    // The earlier deploy settings are the defaults only for the same kind.
    const earlier = wasDeploy.kind === kind ? wasDeploy : {};
    const deploy = { kind };
    if (kind === 'command') deploy.command = await io.text(['deployCommand', repo], 'The command that waits for the deploy of {commit} and exits 0 when it is live:', earlier.command);
    if (kind === 'github-actions') deploy.workflow = await io.text(['deployWorkflow', repo], 'The name of the deploy workflow:', earlier.workflow ?? offered.workflows[0]);
    if (kind === 'amplify') {
      deploy.appId = await io.text(['amplify', repo, 'appId'], 'The Amplify app id:', earlier.appId);
      deploy.region = await io.text(['amplify', repo, 'region'], 'The AWS region of the app:', earlier.region);
      const branch = await io.text(['amplify', repo, 'branch'], 'The Amplify branch, if it differs from the base branch:', earlier.branch ?? '', { required: false });
      const profile = await io.text(['amplify', repo, 'profile'], 'The AWS profile to use, if not the default:', earlier.profile ?? '', { required: false });
      if (branch) deploy.branch = branch;
      if (profile) deploy.profile = profile;
    }
    // Settings init does not ask about, such as cloneNodeModules, are kept.
    repos[repo] = { ...was, checks, deploy };
  }
  // The earlier ship order stays for the repos still in the project, and a new repo ships last.
  const prevOrder = Array.isArray(prev.shipOrder) ? prev.shipOrder.filter((r) => repoNames.includes(r)) : [];
  const shipOrder = [...new Set([...prevOrder, ...repoNames])];
  const project = { ...prev, source: tilde(source), tickets: tilde(tickets), repos, shipOrder, runs };
  if (isObject(prev.validatesAgainst)) {
    project.validatesAgainst = Object.fromEntries(Object.entries(prev.validatesAgainst).filter(([k, v]) => repoNames.includes(k) && Array.isArray(v)).map(([k, v]) => [k, v.filter((r) => repoNames.includes(r))]));
  }
  // The board holds the answers above. Its ids stay only while the kind, team and project are the
  // same. On Jira the ids the probe read replace them. kind is saved only when it differs from the
  // top level one.
  const sameBoard = prevSame && prevBoard.team === fields.team && prevBoard.project === fields.project;
  const dropped = boardKind === 'linear' && !other ? ['team', 'project', 'statuses'] : ['kind', ...JIRA_FIELDS.filter((k) => !['teamId', 'projectId'].includes(k) || fields[k])];
  const projectBoard = {
    ...(sameBoard ? Object.fromEntries(Object.entries(prevBoard).filter(([k]) => !dropped.includes(k))) : {}),
    ...(other ? { kind: boardKind } : {}),
    ...(fields.team ? { team: fields.team } : {}),
    ...(fields.project ? { project: fields.project } : {}),
    ...(fields.teamId ? { teamId: fields.teamId } : {}),
    ...(fields.projectId ? { projectId: fields.projectId } : {}),
    ...(fields.space ? { space: fields.space } : {}),
    ...(fields.statuses ? { statuses: fields.statuses } : {}),
  };
  delete project.board;
  if (Object.keys(projectBoard).length) project.board = projectBoard;
  return { name, project };
}

// An answer key as the answers file names it, such as projects.acme.project.
const keyName = (key) => [key].flat().join('.');

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
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
