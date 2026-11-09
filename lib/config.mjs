import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { BOARD_KINDS, isBoardKind, suggestedStatuses } from './boards.mjs';
import { expand, paths } from './paths.mjs';
import { fail } from './out.mjs';
import { disposableProblem } from './disposable.mjs';

// The person's settings in ~/.bollplank/config.json. schema/config.schema.json documents the same
// shape for editors. validate() is what Bollplank itself trusts, since it has no dependencies.
export const MODES = ['repository', 'consulting', 'configuration'];
export const CRITICS = ['other', 'same', 'claude', 'codex'];
export const DEPLOY_KINDS = ['none', 'command', 'amplify', 'github-actions'];
export const STATUS_KEYS = ['draft', 'ready', 'inProgress', 'acceptance', 'done'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const isStrList = (v) => Array.isArray(v) && v.every(isStr);

// Formats a Jira board checks: team is the Atlassian site host, project the Jira project key, and
// space the Confluence space key that holds the Release notes page.
export const JIRA_SITE = /^[a-z0-9][a-z0-9-]*\.atlassian\.net$/;
export const JIRA_PROJECT_KEY = /^[A-Z][A-Z0-9_]{1,9}$/;
export const CONFLUENCE_SPACE_KEY = /^[A-Za-z0-9~][A-Za-z0-9_~-]{0,254}$/;

export function validate(c) {
  const p = [];
  if (!isObj(c)) return ['config: must be an object'];
  if (!isObj(c.approver) || !isStr(c.approver.name)) p.push('approver.name: required');
  if (c.copyStyle !== undefined && typeof c.copyStyle !== 'string') p.push('copyStyle: must be text');
  const topKind = isObj(c.board) && isBoardKind(c.board.kind) ? c.board.kind : null;
  if (!topKind) p.push(`board.kind: one of ${BOARD_KINDS.map((k) => `"${k}"`).join(', ')}`);
  else p.push(...validateBoardFields('board', topKind, c.board));
  if (isObj(c.board)) p.push(...validateStatuses('board.statuses', c.board.statuses));
  if (c.critic !== undefined) {
    if (!isObj(c.critic)) p.push('critic: must be an object');
    else {
      if (c.critic.default !== undefined && !CRITICS.includes(c.critic.default)) p.push(`critic.default: one of ${CRITICS.join(', ')}`);
      for (const group of ['providers', 'same']) {
        const g = c.critic[group];
        if (g === undefined) continue;
        if (!isObj(g)) p.push(`critic.${group}: must be an object`);
        else for (const [name, v] of Object.entries(g)) {
          if (!['claude', 'codex'].includes(name)) p.push(`critic.${group}.${name}: unknown provider`);
          else if (!isObj(v) || (v.model !== undefined && !isStr(v.model)) || (v.effort !== undefined && !isStr(v.effort))) p.push(`critic.${group}.${name}: model and effort must be names`);
        }
      }
    }
  }
  if (c.shipLock !== undefined && !isStr(c.shipLock)) p.push('shipLock: must be a path');
  if (!isObj(c.projects)) p.push('projects: required, an object');
  else for (const [name, pr] of Object.entries(c.projects)) p.push(...validateProject(name, pr, topKind));
  return p;
}

// A board's team, project and space, for its kind. A Jira team is a site host and its project a
// project key. Only a Jira board has a space. A value left out is not checked here.
function validateBoardFields(at, kind, b) {
  const p = [];
  for (const k of ['team', 'project']) if (b[k] !== undefined && !isStr(b[k])) p.push(`${at}.${k}: must be a name`);
  if (kind === 'jira') {
    if (isStr(b.team) && !JIRA_SITE.test(b.team)) p.push(`${at}.team: a Jira site, such as acme.atlassian.net`);
    if (isStr(b.project) && !JIRA_PROJECT_KEY.test(b.project)) p.push(`${at}.project: a Jira project key, such as ACME`);
    if (b.space !== undefined && !(typeof b.space === 'string' && CONFLUENCE_SPACE_KEY.test(b.space))) p.push(`${at}.space: a Confluence space key, such as ACME`);
  } else if (b.space !== undefined) p.push(`${at}.space: only a Jira board has a space`);
  return p;
}

function validateProject(name, pr, topKind) {
  const p = [];
  const at = (k) => `projects.${name}.${k}`;
  if (!isObj(pr)) return [`projects.${name}: must be an object`];
  const mode = pr.mode ?? 'repository';
  if (!MODES.includes(mode)) p.push(`${at('mode')}: one of ${MODES.join(', ')}`);
  for (const k of ['source', 'tickets']) if (!isStr(pr[k])) p.push(`${at(k)}: required`);
  const repos = pr.repos ?? {};
  if (!isObj(repos)) p.push(`${at('repos')}: must be an object`);
  else {
    if (mode === 'repository' && !Object.keys(repos).length) p.push(`${at('repos')}: a repository project needs at least one repo`);
    if (mode === 'configuration' && Object.keys(repos).length) p.push(`${at('repos')}: configuration mode cannot select repositories`);
    for (const [repo, r] of Object.entries(repos)) p.push(...validateRepo(at(`repos.${repo}`), r, pr.runs === true));
  }
  const repoNames = isObj(repos) ? Object.keys(repos) : [];
  if (pr.validatesAgainst !== undefined) {
    if (!isObj(pr.validatesAgainst)) p.push(`${at('validatesAgainst')}: must be an object`);
    else for (const [k, v] of Object.entries(pr.validatesAgainst)) {
      if (!repoNames.includes(k) || !isStrList(v) || v.some((r) => !repoNames.includes(r))) p.push(`${at(`validatesAgainst.${k}`)}: must name configured repos`);
    }
  }
  // A ship order names every repo exactly once, so no changed repo can be left out of a ship.
  if (pr.shipOrder !== undefined) {
    const order = pr.shipOrder;
    if (!isStrList(order) || order.some((r) => !repoNames.includes(r))) p.push(`${at('shipOrder')}: must list configured repos`);
    else if (new Set(order).size !== order.length || repoNames.some((r) => !order.includes(r))) p.push(`${at('shipOrder')}: must list every configured repo exactly once (${repoNames.join(', ')})`);
  }
  if (pr.critic !== undefined && (!isObj(pr.critic) || (pr.critic.default !== undefined && !CRITICS.includes(pr.critic.default)))) p.push(`${at('critic.default')}: one of ${CRITICS.join(', ')}`);
  for (const k of ['runs', 'privateScan']) if (pr[k] !== undefined && typeof pr[k] !== 'boolean') p.push(`${at(k)}: true or false`);
  if (pr.stopList !== undefined && !isStrList(pr.stopList)) p.push(`${at('stopList')}: a list of text`);
  if (pr.board !== undefined && !isObj(pr.board)) p.push(`${at('board')}: must be an object`);
  if (isObj(pr.board)) {
    const kind = pr.board.kind ?? topKind;
    if (pr.board.kind !== undefined && !isBoardKind(pr.board.kind)) p.push(`${at('board.kind')}: one of ${BOARD_KINDS.map((k) => `"${k}"`).join(', ')}`);
    else if (kind) p.push(...validateBoardFields(at('board'), kind, pr.board));
    p.push(...validateStatuses(at('board.statuses'), pr.board.statuses));
    // A board of another kind shares nothing with the top level one, so it names all of its own.
    if (topKind && isBoardKind(pr.board.kind) && pr.board.kind !== topKind) {
      const s = isObj(pr.board.statuses) ? pr.board.statuses : {};
      const missing = [...['team', 'project'].filter((k) => !isStr(pr.board[k])), ...STATUS_KEYS.filter((k) => !isStr(s[k])).map((k) => `statuses.${k}`)];
      if (missing.length) p.push(`${at('board')}: a ${pr.board.kind} board in a config whose board is ${topKind} must set its own team, project and all five statuses (missing ${missing.join(', ')})`);
    }
  }
  if (mode === 'consulting' || mode === 'configuration') {
    if (!isStr(pr.board?.teamId) || !isStr(pr.board?.projectId)) p.push(`${at('board')}: needs teamId and projectId`);
    if (!isObj(pr.targets) || !Object.keys(pr.targets).length) p.push(`${at('targets')}: required`);
    if (!isStr(pr.runbook)) p.push(`${at('runbook')}: required`);
    const v = pr.verificationChecks;
    if (!isStrList(v) || !v.length || new Set(v).size !== v.length) p.push(`${at('verificationChecks')}: a list of unique names`);
    if (pr.protectedProjects !== undefined && !isStrList(pr.protectedProjects)) p.push(`${at('protectedProjects')}: a list of names`);
  }
  if (mode === 'consulting' && !(typeof pr.ticketPrefix === 'string' && /^[A-Z][A-Z0-9]*$/.test(pr.ticketPrefix))) p.push(`${at('ticketPrefix')}: capital letters and digits`);
  if (mode === 'configuration' && !(isStrList(pr.allowedTickets) && pr.allowedTickets.length && pr.allowedTickets.every((t) => /^[A-Z]+-\d+$/.test(t)))) p.push(`${at('allowedTickets')}: a list of ticket ids`);
  return p;
}

// A status mapping: an object of the five keys, each a name. A key it leaves out falls back. An
// unknown key is refused, since a typo such as in_progress would quietly use the fallback.
function validateStatuses(at, s) {
  if (s === undefined) return [];
  if (!isObj(s)) return [`${at}: must be an object`];
  const unknown = Object.keys(s).filter((k) => !STATUS_KEYS.includes(k)).map((k) => `${at}.${k}: not a workflow state, use one of ${STATUS_KEYS.join(', ')}`);
  return [...unknown, ...STATUS_KEYS.filter((k) => s[k] !== undefined && !isStr(s[k])).map((k) => `${at}.${k}: must be a name`)];
}

// Checks gate every merge, so a project with runs on needs them. With runs off they may wait.
function validateRepo(at, r, runs) {
  const p = [];
  if (!isObj(r)) return [`${at}: must be an object`];
  if (!(typeof r.github === 'string' && /^[\w.-]+\/[\w.-]+$/.test(r.github))) p.push(`${at}.github: owner/name`);
  if ((runs || r.checks !== undefined) && (!isStrList(r.checks) || !r.checks.length)) p.push(`${at}.checks: at least one check name, since nothing else can prove a PR is safe`);
  if (r.baseBranch !== undefined && !isStr(r.baseBranch)) p.push(`${at}.baseBranch: a branch name`);
  if (r.cloneNodeModules !== undefined && typeof r.cloneNodeModules !== 'boolean') p.push(`${at}.cloneNodeModules: true or false`);
  if (r.disposable !== undefined) {
    if (!Array.isArray(r.disposable)) p.push(`${at}.disposable: a list of patterns, such as ["dist/", "**/*.tsbuildinfo"]`);
    else r.disposable.forEach((d, i) => {
      const problem = disposableProblem(d);
      if (problem) p.push(`${at}.disposable[${i}]: ${problem}`);
    });
  }
  const d = r.deploy;
  if (d !== undefined) {
    if (!isObj(d) || !DEPLOY_KINDS.includes(d.kind)) p.push(`${at}.deploy.kind: one of ${DEPLOY_KINDS.join(', ')}`);
    else if (d.kind === 'command' && !isStr(d.command)) p.push(`${at}.deploy.command: required`);
    else if (d.kind === 'amplify' && (!isStr(d.appId) || !isStr(d.region))) p.push(`${at}.deploy: amplify needs appId and region`);
    else if (d.kind === 'amplify' && ((d.branch !== undefined && !isStr(d.branch)) || (d.profile !== undefined && !isStr(d.profile)))) p.push(`${at}.deploy: amplify branch and profile must be names`);
    else if (d.kind === 'github-actions' && !isStr(d.workflow)) p.push(`${at}.deploy.workflow: required`);
  }
  return p;
}

// Each project of withDefaults keeps its board as the config file wrote it, under this symbol. JSON
// leaves a symbol out, so it never shows in context or a run record.
const WRITTEN_BOARD = Symbol('board as written');

// The config with its defaults filled in. Validation runs first, so callers can trust the shape.
// A relative path in the config is resolved against base, the folder the config file is in.
// Each status name comes from the first place that names it: the project's own board.statuses,
// then the top level board.statuses, then the board kind's suggestion. So a project in another
// team can keep its own names. A project whose board.kind differs from the top level one inherits
// nothing from it. Its statuses start from its own kind's suggestion, and validation already
// requires it to name all five.
export function withDefaults(c, base = dirname(paths().config)) {
  const statuses = { ...suggestedStatuses(c.board?.kind), ...(c.board?.statuses ?? {}) };
  return {
    ...c,
    copyStyle: c.copyStyle ?? '',
    board: { ...c.board, statuses },
    critic: { default: 'other', providers: {}, same: {}, ...(c.critic ?? {}) },
    shipLock: expand(c.shipLock, base) ?? paths().shipLock,
    projects: Object.fromEntries(Object.entries(c.projects).map(([n, pr]) => [n, { mode: 'repository', runs: false, privateScan: false, stopList: [], validatesAgainst: {}, repos: {}, ...pr, board: { ...(pr.board ?? {}), statuses: { ...(otherKind(c, pr) ? suggestedStatuses(pr.board.kind) : statuses), ...(pr.board?.statuses ?? {}) } }, [WRITTEN_BOARD]: pr.board, source: expand(pr.source, base), tickets: expand(pr.tickets, base) }])),
  };
}

// True when a project's own board.kind differs from the top level one.
const otherKind = (c, pr) => pr?.board?.kind !== undefined && pr.board.kind !== c?.board?.kind;

// A project of withDefaults with its board as the config file wrote it, so without the statuses
// it inherits. A run hashes this, so its hash changes only when the project's own entry changes,
// and a run started before statuses were filled in per project keeps its hash. A project that
// did not come from withDefaults is returned as it is.
export function asWritten(project) {
  if (!project || !Object.hasOwn(project, WRITTEN_BOARD)) return project;
  const out = { ...project };
  if (project[WRITTEN_BOARD] === undefined) delete out.board;
  else out.board = project[WRITTEN_BOARD];
  return out;
}

// Where the config names a project's status, as the key to change. That is the project's own
// mapping when it names the status or when the project is in another team than the top level
// board, or on a board of another kind, since a change to the shared top level name would break that
// board. Otherwise it is the top level one, which also stands for the board kind's suggestion. raw
// is the config as read.
export function statusKeyOf(raw, project, key) {
  const own = raw?.projects?.[project]?.board;
  const team = own?.team ?? raw?.board?.team;
  return own?.statuses?.[key] !== undefined || team !== raw?.board?.team || otherKind(raw, raw?.projects?.[project]) ? `projects.${project}.board.statuses.${key}` : `board.statuses.${key}`;
}

export function readConfig(file = paths().config) {
  if (!existsSync(file)) return { missing: true, problems: [`no config at ${file}. Run bollplank init.`] };
  let c;
  try {
    c = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return { problems: [`${file}: ${e.message}`] };
  }
  const problems = validate(c);
  return problems.length ? { problems } : { config: withDefaults(c, dirname(file)), raw: c, problems: [] };
}

// For commands: the valid config, or a JSON failure that says what to fix.
export function loadConfig() {
  const r = readConfig();
  if (r.problems.length) fail('config', r.problems.join('. '));
  return r.config;
}

// The critic default for a project: its own critic.default, else the config's.
export function projectCritic(config, project) {
  const own = project?.critic?.default;
  return own ? { default: own, from: 'project' } : { default: config.critic.default, from: 'config' };
}

export function loadProject(config, name) {
  const pr = Object.hasOwn(config.projects, name) ? config.projects[name] : null;
  if (!pr) fail('usage', `no project ${name} in the config`);
  return { name, ...pr };
}
