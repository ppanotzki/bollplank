import test from 'node:test';
import assert from 'node:assert/strict';
import { BOARDS, kindOf, missingInNewTeam, suggestedStatuses } from '../lib/boards.mjs';
import { statusKeyOf, validate, withDefaults } from '../lib/config.mjs';
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
  j.projects['acme-web'] = { source: '/s', tickets: '/t', repos, board: { kind: 'linear', team: 'ACME', project: 'Web', statuses: jiraStatuses } };
  s.config(j);
  const both = s.run(['context']).json;
  assert.deepEqual(both.boards['acme-shop'], { kind: 'jira', team: 'acme.atlassian.net', project: 'ACME', space: 'ACME', statuses: jiraStatuses });
  assert.deepEqual(both.boards['acme-web'], { kind: 'linear', team: 'ACME', project: 'Web', statuses: jiraStatuses });
  assert.deepEqual(s.run(['context', 'acme-web']).json.board, both.boards['acme-web']);
});
