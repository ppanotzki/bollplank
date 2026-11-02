import { existsSync, readFileSync } from 'node:fs';
import { expand, paths } from './paths.mjs';
import { fail } from './out.mjs';

// The person's settings in ~/.bollplank/config.json. schema/config.schema.json documents the same
// shape for editors. validate() is what Bollplank itself trusts, since it has no dependencies.
export const MODES = ['repository', 'consulting', 'configuration'];
export const CRITICS = ['other', 'same', 'claude', 'codex'];
export const DEPLOY_KINDS = ['none', 'command', 'amplify', 'github-actions'];
export const STATUS_KEYS = ['draft', 'ready', 'inProgress', 'acceptance', 'done'];
export const DEFAULT_STATUSES = { draft: 'Draft', ready: 'Ready', inProgress: 'In Progress', acceptance: 'Acceptance', done: 'Done' };

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const isStrList = (v) => Array.isArray(v) && v.every(isStr);

export function validate(c) {
  const p = [];
  if (!isObj(c)) return ['config: must be an object'];
  if (!isObj(c.approver) || !isStr(c.approver.name)) p.push('approver.name: required');
  if (c.copyStyle !== undefined && typeof c.copyStyle !== 'string') p.push('copyStyle: must be text');
  if (!isObj(c.board) || c.board.kind !== 'linear') p.push('board.kind: must be "linear"');
  else if (c.board.statuses !== undefined) {
    if (!isObj(c.board.statuses)) p.push('board.statuses: must be an object');
    else for (const k of STATUS_KEYS) if (c.board.statuses[k] !== undefined && !isStr(c.board.statuses[k])) p.push(`board.statuses.${k}: must be a name`);
  }
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
  else for (const [name, pr] of Object.entries(c.projects)) p.push(...validateProject(name, pr));
  return p;
}

function validateProject(name, pr) {
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
    for (const [repo, r] of Object.entries(repos)) p.push(...validateRepo(at(`repos.${repo}`), r));
  }
  const repoNames = isObj(repos) ? Object.keys(repos) : [];
  if (pr.validatesAgainst !== undefined) {
    if (!isObj(pr.validatesAgainst)) p.push(`${at('validatesAgainst')}: must be an object`);
    else for (const [k, v] of Object.entries(pr.validatesAgainst)) {
      if (!repoNames.includes(k) || !isStrList(v) || v.some((r) => !repoNames.includes(r))) p.push(`${at(`validatesAgainst.${k}`)}: must name configured repos`);
    }
  }
  if (pr.shipOrder !== undefined && (!isStrList(pr.shipOrder) || pr.shipOrder.some((r) => !repoNames.includes(r)))) p.push(`${at('shipOrder')}: must list configured repos`);
  for (const k of ['runs', 'privateScan']) if (pr[k] !== undefined && typeof pr[k] !== 'boolean') p.push(`${at(k)}: true or false`);
  if (pr.stopList !== undefined && !isStrList(pr.stopList)) p.push(`${at('stopList')}: a list of text`);
  if (pr.board !== undefined && !isObj(pr.board)) p.push(`${at('board')}: must be an object`);
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

function validateRepo(at, r) {
  const p = [];
  if (!isObj(r)) return [`${at}: must be an object`];
  if (!(typeof r.github === 'string' && /^[\w.-]+\/[\w.-]+$/.test(r.github))) p.push(`${at}.github: owner/name`);
  if (!isStrList(r.checks) || !r.checks.length) p.push(`${at}.checks: at least one check name, since nothing else can prove a PR is safe`);
  if (r.baseBranch !== undefined && !isStr(r.baseBranch)) p.push(`${at}.baseBranch: a branch name`);
  if (r.cloneNodeModules !== undefined && typeof r.cloneNodeModules !== 'boolean') p.push(`${at}.cloneNodeModules: true or false`);
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

// The config with its defaults filled in. Validation runs first, so callers can trust the shape.
export function withDefaults(c) {
  return {
    ...c,
    copyStyle: c.copyStyle ?? '',
    board: { ...c.board, statuses: { ...DEFAULT_STATUSES, ...(c.board?.statuses ?? {}) } },
    critic: { default: 'other', providers: {}, same: {}, ...(c.critic ?? {}) },
    shipLock: expand(c.shipLock) ?? paths().shipLock,
    projects: Object.fromEntries(Object.entries(c.projects).map(([n, pr]) => [n, { mode: 'repository', runs: false, privateScan: false, stopList: [], validatesAgainst: {}, repos: {}, ...pr, source: expand(pr.source), tickets: expand(pr.tickets) }])),
  };
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
  return problems.length ? { problems } : { config: withDefaults(c), problems: [] };
}

// For commands: the valid config, or a JSON failure that says what to fix.
export function loadConfig() {
  const r = readConfig();
  if (r.problems.length) fail('config', r.problems.join('; '));
  return r.config;
}

export function loadProject(config, name) {
  const pr = config.projects[name];
  if (!pr) fail('usage', `no project ${name} in the config`);
  return { name, ...pr };
}
