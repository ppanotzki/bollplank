import test from 'node:test';
import assert from 'node:assert/strict';
import { BOARDS, kindOf, missingInNewTeam, suggestedStatuses } from '../lib/boards.mjs';
import { pinProjects, statusKeyOf, validate, withDefaults } from '../lib/config.mjs';
import { sandbox } from './helpers.mjs';

const repos = { 'acme-api': { github: 'acme/acme-api', checks: ['checks'] } };
const jiraStatuses = { draft: 'Draft', ready: 'Ready', inProgress: 'In Progress', acceptance: 'Acceptance', done: 'Done' };

// A Linear config with a Jira project beside a Linear one.
const mixed = () => ({
  approver: { name: 'Ada' },
  board: { kind: 'linear', team: 'ACME', project: 'Shop', statuses: { acceptance: 'Review' } },
  projects: {
    'acme-shop': { source: '/s', tickets: '/t', repos },
    'acme-portal': { source: '/s', tickets: '/t', repos, board: { kind: 'jira', team: 'acme.atlassian.net', project: 'ACM', space: 'ACME', statuses: { ...jiraStatuses, acceptance: 'In Review' } } },
  },
});

// A Jira config with its own space.
const jira = () => ({
  approver: { name: 'Ada' },
  board: { kind: 'jira', team: 'acme.atlassian.net', project: 'ACME', space: 'ACME' },
  projects: { 'acme-shop': { source: '/s', tickets: '/t', repos } },
});

test('BOARDS knows Linear and Jira, each with its server and a fix per client', () => {
  assert.deepEqual(Object.keys(BOARDS), ['linear', 'jira']);
  assert.equal(BOARDS.jira.label, 'Jira');
  assert.deepEqual(suggestedStatuses('jira'), jiraStatuses);
  assert.deepEqual(BOARDS.jira.newTeam, ['To Do', 'In Progress', 'Done']);
  assert.deepEqual(missingInNewTeam('jira'), ['Draft', 'Ready', 'Acceptance']);
  assert.deepEqual(BOARDS.jira.server.urls, ['https://mcp.atlassian.com/v2/mcp', 'https://mcp.atlassian.com/v1/mcp']);
  assert.deepEqual(BOARDS.linear.server.urls, ['https://mcp.linear.app/mcp']);
  for (const kind of ['linear', 'jira']) for (const client of ['claude', 'codex']) assert.match(BOARDS[kind].fix[client], new RegExp(`${client} mcp add .*${BOARDS[kind].server.urls[0]}`));
  // An unknown kind, including one inherited from Object, falls back to Linear.
  assert.deepEqual(suggestedStatuses('toString'), suggestedStatuses('linear'));
});

test('kindOf is the project\'s own kind, else the top level one', () => {
  const c = mixed();
  assert.equal(kindOf(c, 'acme-portal'), 'jira');
  assert.equal(kindOf(c, 'acme-shop'), 'linear');
  assert.equal(kindOf(c), 'linear');
  assert.equal(kindOf(c, 'globex'), 'linear');
  assert.equal(kindOf(withDefaults(c), 'acme-portal'), 'jira');
});

test('mixed kinds pass, and a project of another kind inherits nothing from the top level', () => {
  const c = mixed();
  assert.deepEqual(validate(c), []);
  assert.deepEqual(validate(jira()), []);
  const d = withDefaults(c);
  assert.deepEqual(d.projects['acme-portal'].board.statuses, { ...jiraStatuses, acceptance: 'In Review' });
  // The same kind keeps today's inheritance.
  assert.deepEqual(d.projects['acme-shop'].board.statuses, { ...jiraStatuses, acceptance: 'Review' });
  // A project that names the top level kind is the same board kind.
  const same = mixed();
  same.projects['acme-shop'].board = { kind: 'linear' };
  assert.deepEqual(validate(same), []);
  assert.equal(withDefaults(same).projects['acme-shop'].board.statuses.acceptance, 'Review');
  assert.equal(statusKeyOf(same, 'acme-shop', 'acceptance'), 'board.statuses.acceptance');
  // A different kind counts as a different board, even with the same team name.
  const sameTeam = mixed();
  sameTeam.board.team = 'acme.atlassian.net';
  assert.equal(statusKeyOf(sameTeam, 'acme-portal', 'draft'), 'projects.acme-portal.board.statuses.draft');
});

test('a project that only changes the kind fails with a clear message', () => {
  const c = mixed();
  c.projects['acme-portal'].board = { kind: 'jira' };
  assert.ok(validate(c).includes('projects.acme-portal.board: a jira board in a config whose board is linear must set its own team, project and all five statuses (missing team, project, statuses.draft, statuses.ready, statuses.inProgress, statuses.acceptance, statuses.done)'), validate(c).join('\n'));
  const partial = mixed();
  delete partial.projects['acme-portal'].board.statuses.done;
  assert.match(validate(partial).join('\n'), /projects\.acme-portal\.board: .*\(missing statuses\.done\)/);
  // A Linear project in a Jira config needs the same.
  const back = jira();
  back.projects['acme-shop'].board = { kind: 'linear', team: 'ACME' };
  assert.match(validate(back).join('\n'), /projects\.acme-shop\.board: a linear board in a config whose board is jira .*\(missing project, statuses\.draft/);
  const unknown = mixed();
  unknown.projects['acme-portal'].board.kind = 'trello';
  assert.ok(validate(unknown).includes('projects.acme-portal.board.kind: one of "linear", "jira"'));
  assert.ok(validate({ ...mixed(), board: { kind: 'trello' } }).includes('board.kind: one of "linear", "jira"'));
});

test('a Jira board checks the site, the project key and the space', () => {
  for (const [field, value, message] of [
    ['team', 'acme', 'a Jira site, such as acme.atlassian.net'],
    ['team', 'Acme.atlassian.net', 'a Jira site, such as acme.atlassian.net'],
    ['team', 'acme.atlassian.net.example.com', 'a Jira site, such as acme.atlassian.net'],
    ['project', 'acm', 'a Jira project key, such as ACME'],
    ['project', 'A', 'a Jira project key, such as ACME'],
    ['project', 'ACMEACMEACM', 'a Jira project key, such as ACME'],
    ['space', 'AC ME', 'a Confluence space key, such as ACME'],
    ['space', '-ACME', 'a Confluence space key, such as ACME'],
    ['space', 7, 'a Confluence space key, such as ACME'],
  ]) {
    const top = jira();
    top.board[field] = value;
    assert.ok(validate(top).includes(`board.${field}: ${message}`), `${field} ${value}: ${validate(top).join('\n')}`);
    const own = mixed();
    own.projects['acme-portal'].board[field] = value;
    assert.ok(validate(own).includes(`projects.acme-portal.board.${field}: ${message}`), `${field} ${value}: ${validate(own).join('\n')}`);
  }
  const ok = jira();
  Object.assign(ok.board, { team: 'acme-2.atlassian.net', project: 'AC_1', space: '~ada' });
  assert.deepEqual(validate(ok), []);
  // A same kind project's own values are checked too.
  const sameKind = jira();
  sameKind.projects['acme-shop'].board = { project: 'acme' };
  assert.ok(validate(sameKind).includes('projects.acme-shop.board.project: a Jira project key, such as ACME'));
});

test('a space is refused on a Linear board', () => {
  const top = mixed();
  top.board.space = 'ACME';
  assert.ok(validate(top).includes('board.space: only a Jira board has a space'));
  const own = mixed();
  own.projects['acme-shop'].board = { space: 'ACME' };
  assert.ok(validate(own).includes('projects.acme-shop.board.space: only a Jira board has a space'));
  const inJira = jira();
  inJira.projects['acme-shop'].board = { kind: 'linear', team: 'ACME', project: 'Shop', statuses: jiraStatuses, space: 'ACME' };
  assert.ok(validate(inJira).includes('projects.acme-shop.board.space: only a Jira board has a space'));
});

test('context gives each project its resolved kind and board', (t) => {
  const s = sandbox();
  t.after(s.clean);
  s.config(mixed());
  const top = s.run(['context']).json;
  assert.equal(top.board.kind, 'linear');
  assert.deepEqual(top.boards['acme-portal'], { kind: 'jira', team: 'acme.atlassian.net', project: 'ACM', space: 'ACME', statuses: { ...jiraStatuses, acceptance: 'In Review' } });
  assert.deepEqual(top.boards['acme-shop'], { kind: 'linear', team: 'ACME', project: 'Shop', statuses: { ...jiraStatuses, acceptance: 'Review' } });
  const portal = s.run(['context', 'acme-portal']).json;
  assert.deepEqual(portal.board, top.boards['acme-portal']);
  assert.equal(portal.project.board.kind, 'jira');
  assert.equal(portal.project.board.space, 'ACME');
  const shop = s.run(['context', 'acme-shop']).json;
  assert.equal(shop.board.kind, 'linear');
  assert.equal(shop.board.space, undefined);
  // In a Jira config a same kind project inherits the top level site, key and space.
  const j = jira();
  j.projects['acme-web'] = { source: '/s', tickets: '/t', repos, board: { kind: 'linear', team: 'WEB', project: 'Web', statuses: jiraStatuses } };
  s.config(j);
  const both = s.run(['context']).json;
  assert.deepEqual(both.boards['acme-shop'], { kind: 'jira', team: 'acme.atlassian.net', project: 'ACME', space: 'ACME', statuses: jiraStatuses });
  assert.deepEqual(both.boards['acme-web'], { kind: 'linear', team: 'WEB', project: 'Web', statuses: jiraStatuses });
  assert.deepEqual(s.run(['context', 'acme-web']).json.board, both.boards['acme-web']);
});

test('two boards that would give tickets the same key are refused', () => {
  // The same Jira project key on two sites.
  const c = jira();
  c.projects['acme-beta'] = { source: '/s', tickets: '/t', repos, board: { team: 'beta.atlassian.net', project: 'ACME' } };
  const twice = validate(c);
  assert.ok(twice.some((m) => m.includes('projects.acme-shop, projects.acme-beta: the Jira project key ACME is on more than one site (acme.atlassian.net, beta.atlassian.net)')), twice.join('\n'));
  // A Jira project key that is also a Linear team key.
  const d = jira();
  d.projects['acme-web'] = { source: '/s', tickets: '/t', repos, board: { kind: 'linear', team: 'ACME', project: 'Web', statuses: jiraStatuses } };
  const both = validate(d);
  assert.ok(both.some((m) => m.includes('ACME is both a Jira project key and a Linear team key')), both.join('\n'));
  // The same key on the same site, another key on another site, and a Linear team given by its name all pass.
  const e = jira();
  e.projects['acme-docs'] = { source: '/s', tickets: '/t', repos, board: { team: 'ACME.atlassian.net', project: 'ACME' } };
  e.projects['acme-beta'] = { source: '/s', tickets: '/t', repos, board: { team: 'beta.atlassian.net', project: 'BETA' } };
  e.projects['acme-web'] = { source: '/s', tickets: '/t', repos, board: { kind: 'linear', team: 'Acme Web', project: 'Web', statuses: jiraStatuses } };
  assert.deepEqual(validate(e).filter((m) => /share one key/.test(m)), []);
});

// A Jira config with a cloud id, project id and space, and a Jira project on another site.
const twoSites = () => {
  const c = jira();
  c.board = { ...c.board, teamId: 'cloud-acme', projectId: '10001' };
  c.projects['acme-beta'] = { source: '/s', tickets: '/t', repos, board: { team: 'beta.atlassian.net', project: 'BETA' } };
  return c;
};

test('a Jira project on another site takes no teamId, projectId or space from the top level', async (t) => {
  const { sharesTopBoard } = await import('../lib/boards.mjs');
  const c = twoSites();
  assert.equal(sharesTopBoard(c, 'acme-shop'), true);
  assert.equal(sharesTopBoard(c, 'acme-beta'), false);
  c.projects['acme-shop'].board = { team: 'acme.atlassian.net' };
  assert.equal(sharesTopBoard(c, 'acme-shop'), true);
  const s = sandbox();
  t.after(s.clean);
  s.config(twoSites());
  const top = s.run(['context']).json;
  assert.equal(top.boards['acme-beta'].space, undefined);
  assert.equal(top.boards['acme-shop'].space, 'ACME');
  const beta = s.run(['context', 'acme-beta']).json;
  assert.equal(beta.board.team, 'beta.atlassian.net');
  for (const k of ['teamId', 'projectId', 'space']) {
    assert.equal(beta.board[k], undefined, k);
    assert.equal(beta.project.board[k], undefined, k);
  }
  // Same kind and same site keeps today's inheritance.
  const shop = s.run(['context', 'acme-shop']).json;
  assert.equal(shop.board.teamId, 'cloud-acme');
  assert.equal(shop.board.projectId, '10001');
  assert.equal(shop.board.space, 'ACME');
});

test('doctor checks a Jira project on another site without the top level cloud id, project id or space', async () => {
  const { jiraBoardChecks } = await import('../lib/commands/doctor.mjs');
  const raw = twoSites();
  const config = withDefaults(raw, '/');
  const reads = [{ client: { label: 'Claude Code' }, sites: [{ site: 'acme.atlassian.net', cloudId: 'cloud-acme', projects: [{ key: 'ACME', id: '10001', statuses: Object.values(jiraStatuses) }], spaces: ['ACME'] }, { site: 'beta.atlassian.net', cloudId: 'cloud-beta', projects: [{ key: 'BETA', id: '20001', statuses: Object.values(jiraStatuses) }], spaces: [] }] }];
  const checks = Object.fromEntries(jiraBoardChecks(config, reads, raw).map((c) => [c.id, c]));
  assert.equal(checks['board.jira.cloudId.acme.atlassian.net'].ok, true);
  const beta = checks['board.jira.cloudId.beta.atlassian.net'];
  assert.equal(beta.ok, false);
  assert.match(beta.detail, /projects\.acme-beta\.board\.teamId is not set/);
  assert.equal(Object.keys(checks).some((id) => id.startsWith('board.jira.space.beta')), false);
  assert.equal(checks['board.jira.space.acme.atlassian.net.ACME'].ok, true);
});

test('a project on the top level site but another project takes the teamId, never the projectId', async (t) => {
  const { boardIds } = await import('../lib/boards.mjs');
  const c = twoSites();
  c.projects['acme-acm'] = { source: '/s', tickets: '/t', repos, board: { project: 'ACM' } };
  assert.deepEqual(boardIds(c, 'acme-acm'), { teamId: 'cloud-acme' });
  assert.deepEqual(boardIds(c, 'acme-shop'), { teamId: 'cloud-acme', projectId: '10001' });
  assert.deepEqual(boardIds(c, 'acme-beta'), {});
  const s = sandbox();
  t.after(s.clean);
  s.config(c);
  const acm = s.run(['context', 'acme-acm']).json;
  assert.equal(acm.board.project, 'ACM');
  assert.equal(acm.board.teamId, 'cloud-acme');
  assert.equal(acm.board.projectId, undefined);
  // Doctor names the project's own key for its missing project id.
  const { jiraBoardChecks } = await import('../lib/commands/doctor.mjs');
  const reads = [{ client: { label: 'Claude Code' }, sites: [{ site: 'acme.atlassian.net', cloudId: 'cloud-acme', projects: [{ key: 'ACME', id: '10001', statuses: Object.values(jiraStatuses) }, { key: 'ACM', id: '10002', statuses: Object.values(jiraStatuses) }], spaces: ['ACME'] }, { site: 'beta.atlassian.net', cloudId: 'cloud-beta', projects: [], spaces: [] }] }];
  const checks = Object.fromEntries(jiraBoardChecks(withDefaults(c, '/'), reads, c).map((x) => [x.id, x]));
  const acmId = Object.values(checks).find((x) => x.id.startsWith('board.jira.projectId.acme.atlassian.net.ACM') && !x.id.includes('ACME'));
  assert.equal(acmId.ok, false);
  assert.match(acmId.detail, /projects\.acme-acm\.board\.projectId is not set/);
});

test('a Jira project with its own ids in a Linear config keeps them in context', (t) => {
  const s = sandbox();
  t.after(s.clean);
  const c = mixed();
  Object.assign(c.projects['acme-portal'].board, { teamId: 'cloud-acme', projectId: '10001' });
  c.board.teamId = 'linear-team';
  c.board.projectId = 'linear-project';
  s.config(c);
  const portal = s.run(['context', 'acme-portal']).json;
  assert.equal(portal.board.kind, 'jira');
  assert.equal(portal.board.teamId, 'cloud-acme');
  assert.equal(portal.board.projectId, '10001');
  // The Linear project takes the top level ids, as before.
  const shop = s.run(['context', 'acme-shop']).json;
  assert.equal(shop.board.teamId, 'linear-team');
  assert.equal(shop.board.projectId, 'linear-project');
});

// A Linear config whose projects inherit from the top level board in each way: everything, the
// statuses only, nothing but the ids, and one that already sets its own kind.
const linearWithIds = () => ({
  approver: { name: 'Ada' },
  board: { kind: 'linear', team: 'ACME', project: 'Shop', teamId: 't1', projectId: 'p1', statuses: { acceptance: 'Review' } },
  projects: {
    'acme-shop': { source: '/s', tickets: '/t', repos },
    'acme-web': { source: '/s', tickets: '/t', repos, board: { team: 'ACME', project: 'Widgets' } },
    'acme-ops': { source: '/s', tickets: '/t', repos, board: { team: 'OPS', project: 'Ops', statuses: { draft: 'Idea' } } },
    'acme-portal': { source: '/s', tickets: '/t', repos, board: { kind: 'jira', team: 'acme.atlassian.net', project: 'ACM', statuses: jiraStatuses } },
  },
});

test('pinProjects writes out the board each project resolved to, when the top level kind changes', () => {
  const prev = linearWithIds();
  const linearFive = { ...suggestedStatuses('linear'), acceptance: 'Review' };
  const { projects, pinned } = pinProjects(prev, 'jira');
  assert.deepEqual(projects['acme-shop'].board, { kind: 'linear', team: 'ACME', project: 'Shop', teamId: 't1', projectId: 'p1', statuses: linearFive });
  // Another project on the same team takes the teamId, never the projectId.
  assert.deepEqual(projects['acme-web'].board, { kind: 'linear', team: 'ACME', project: 'Widgets', teamId: 't1', statuses: linearFive });
  // Another team takes no id, and its own status names stay over the top level ones.
  assert.deepEqual(projects['acme-ops'].board, { kind: 'linear', team: 'OPS', project: 'Ops', statuses: { ...linearFive, draft: 'Idea' } });
  // A project the new kind fits is untouched.
  assert.equal(projects['acme-portal'], prev.projects['acme-portal']);
  assert.deepEqual(pinned.map((p) => p.name), ['acme-shop', 'acme-web', 'acme-ops']);
  // Everything else on the project is kept.
  assert.equal(projects['acme-shop'].source, '/s');
  // With a Jira top level board the pinned config validates, and each project resolves as before.
  const next = { ...prev, board: { kind: 'jira', team: 'acme.atlassian.net', project: 'ACME' }, projects };
  assert.deepEqual(validate(next), []);
  const before = withDefaults(prev, '/');
  const after = withDefaults(next, '/');
  for (const n of ['acme-shop', 'acme-web', 'acme-ops']) assert.deepEqual(after.projects[n].board.statuses, before.projects[n].board.statuses, n);
});

test('pinProjects changes nothing when the kind stays, and keeps the shared space of a Jira project', () => {
  const prev = linearWithIds();
  const same = pinProjects(prev, 'linear');
  assert.deepEqual(same.pinned, []);
  assert.deepEqual(same.projects, prev.projects);
  // Jira to Linear: the Jira project keeps the site's ids and the space it shared.
  const j = { ...jira(), board: { ...jira().board, teamId: 'cloud-acme', projectId: '10001' } };
  const { projects, pinned } = pinProjects(j, 'linear');
  assert.deepEqual(projects['acme-shop'].board, { kind: 'jira', team: 'acme.atlassian.net', project: 'ACME', teamId: 'cloud-acme', projectId: '10001', space: 'ACME', statuses: jiraStatuses });
  assert.deepEqual(pinned, [{ name: 'acme-shop', kind: 'jira', team: 'acme.atlassian.net', project: 'ACME' }]);
  assert.deepEqual(validate({ ...j, board: { kind: 'linear', team: 'ACME', project: 'Shop' }, projects }), []);
  // No config, or no projects, pins nothing.
  assert.deepEqual(pinProjects(null, 'jira'), { projects: {}, pinned: [] });
});
