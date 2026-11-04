import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, missing } from '../lib/args.mjs';
import { validate, withDefaults } from '../lib/config.mjs';
import { workflowLine } from '../lib/version.mjs';
import { scan } from '../lib/private-scan.mjs';
import { docsFiles, docsProblems, textProblems } from '../lib/docs-check.mjs';
import { kit, sandbox, gitRepo, acmeConfig } from './helpers.mjs';

const example = () => JSON.parse(readFileSync(join(kit, 'examples', 'config.example.json'), 'utf8'));

test('the parser takes values, booleans and lists, and refuses a value flag without a value', () => {
  assert.deepEqual(parse(['a', '--x', '1', '--y', '--z', 'p,q'], { x: 'value', y: 'bool', z: 'list' }), { opts: { x: '1', y: true, z: ['p', 'q'] }, positional: ['a'] });
  assert.match(parse(['--x', '--y'], { x: 'value', y: 'bool' }).error, /--x needs a value/);
  assert.match(parse(['--x'], { x: 'value' }).error, /--x needs a value/);
  assert.match(parse(['--nope'], {}).error, /unknown option --nope/);
  assert.equal(missing({ a: '1' }, ['a', 'b']), 'missing --b');
  assert.equal(missing({ a: '1' }, ['a']), null);
});

test('the example config is valid and defaults fill statuses, critic, runs and the lock', () => {
  assert.deepEqual(validate(example()), []);
  const c = withDefaults(acmeConfig('~/src', '~/src/Tickets'));
  assert.equal(c.board.statuses.inProgress, 'In Progress');
  assert.equal(c.critic.default, 'other');
  assert.equal(c.projects['acme-shop'].mode, 'repository');
  assert.equal(c.projects['acme-shop'].privateScan, false);
  assert.ok(!c.projects['acme-shop'].source.startsWith('~'));
});

test('each project has its own statuses: its own names, then the top level ones, then Linear\'s suggestion', (t) => {
  const repos = { 'acme-api': { github: 'acme/acme-api', checks: ['checks'] } };
  const two = {
    approver: { name: 'Ada' },
    board: { kind: 'linear', team: 'ACME', statuses: { acceptance: 'Review' } },
    projects: {
      'acme-shop': { source: '/s', tickets: '/t', repos },
      'globex-portal': { source: '/s', tickets: '/t', repos, board: { team: 'GLOBEX', project: 'Portal', statuses: { ready: 'Todo', acceptance: 'In Review' } } },
    },
  };
  assert.deepEqual(validate(two), []);
  const c = withDefaults(two);
  assert.deepEqual(c.board.statuses, { draft: 'Draft', ready: 'Ready', inProgress: 'In Progress', acceptance: 'Review', done: 'Done' });
  assert.deepEqual(c.projects['acme-shop'].board.statuses, c.board.statuses);
  assert.deepEqual(c.projects['globex-portal'].board.statuses, { draft: 'Draft', ready: 'Todo', inProgress: 'In Progress', acceptance: 'In Review', done: 'Done' });
  assert.equal(c.projects['globex-portal'].board.team, 'GLOBEX');
  // With no mapping anywhere, Linear's suggestion.
  assert.deepEqual(withDefaults(acmeConfig('/s', '/t')).projects['acme-shop'].board.statuses, { draft: 'Draft', ready: 'Ready', inProgress: 'In Progress', acceptance: 'Acceptance', done: 'Done' });
  // A project's mapping is validated like the top level one.
  const bad = structuredClone(two);
  bad.projects['globex-portal'].board.statuses = { ready: '' };
  bad.projects['acme-shop'].board = { statuses: 'Todo' };
  const p = validate(bad).join('\n');
  assert.match(p, /projects\.globex-portal\.board\.statuses\.ready: must be a name/);
  assert.match(p, /projects\.acme-shop\.board\.statuses: must be an object/);
  // A typo in a state name is refused, at the top level and in a project, and so is an empty team
  // or project name.
  const typo = structuredClone(two);
  typo.board.statuses.in_progress = 'Doing';
  typo.projects['globex-portal'].board.statuses.Done = 'Shipped';
  typo.projects['globex-portal'].board.team = ' ';
  typo.projects['acme-shop'].board = { project: '' };
  const q = validate(typo);
  assert.ok(q.includes('board.statuses.in_progress: not a workflow state, use one of draft, ready, inProgress, acceptance, done'), q.join('\n'));
  assert.ok(q.some((x) => x.startsWith('projects.globex-portal.board.statuses.Done: not a workflow state')), q.join('\n'));
  assert.ok(q.includes('projects.globex-portal.board.team: must be a name'), q.join('\n'));
  assert.ok(q.includes('projects.acme-shop.board.project: must be a name'), q.join('\n'));
  // context gives each project its own mapping, and the top level one without a project.
  const s = sandbox();
  t.after(s.clean);
  s.config(two);
  const top = s.run(['context']).json;
  assert.equal(top.board.statuses.acceptance, 'Review');
  assert.deepEqual(top.boards['globex-portal'], { team: 'GLOBEX', project: 'Portal', statuses: c.projects['globex-portal'].board.statuses });
  assert.equal(top.boards['acme-shop'].statuses.ready, 'Ready');
  assert.equal(s.run(['context', 'globex-portal']).json.board.statuses.acceptance, 'In Review');
  assert.equal(s.run(['context', 'acme-shop']).json.board.statuses.acceptance, 'Review');
  // With a project, board names that project's own team and project, the same as boards and
  // project.board, with the top level ones filled in where it sets none.
  const globex = s.run(['context', 'globex-portal']).json;
  assert.deepEqual(globex.board, { kind: 'linear', ...top.boards['globex-portal'] });
  assert.equal(globex.board.team, 'GLOBEX');
  assert.equal(globex.board.project, 'Portal');
  assert.equal(globex.project.board.team, 'GLOBEX');
  assert.equal(globex.project.board.project, 'Portal');
  const acme = s.run(['context', 'acme-shop']).json;
  assert.deepEqual(acme.board, { kind: 'linear', ...top.boards['acme-shop'] });
  assert.equal(acme.board.team, 'ACME');
  assert.equal(acme.board.project, null);
  assert.equal(acme.project.board.team, 'ACME');
});

test('the board skill creates a project and checks statuses only when asked, confirming first and reading back', () => {
  const skill = readFileSync(join(kit, 'skills', 'bollplank-board', 'SKILL.md'), 'utf8');
  const linear = readFileSync(join(kit, 'skills', 'bollplank-board', 'references', 'linear.md'), 'utf8');
  const create = skill.slice(skill.indexOf('**Create a project.**'), skill.indexOf('**Check the statuses.**'));
  assert.match(skill, /## Setup operations, only when the user asks/);
  assert.match(create, /Confirm the team and the exact project name with the user first/);
  assert.match(create, /call the board's create tool once, with no id of an existing project/);
  assert.match(create, /Read the team's projects back/);
  assert.match(create, /Never update, rename or move an existing project/);
  assert.match(skill, /\*\*Check the statuses\.\*\* Run `bollplank context <project>`/);
  assert.match(skill, /cannot create a status, so for each missing one give the steps/);
  assert.match(linear, /\| Create a project \|.*no project id.*list the team's projects again/);
  assert.match(linear, /\| Check the statuses \|.*Linear's MCP server cannot create a status/);
  // Status names come from the project's own context.
  assert.match(skill, /With a project, `board\.statuses` is that project's own mapping/);
});

test('validation names each problem and never accepts a repo without checks', () => {
  const c = example();
  delete c.approver;
  c.critic.default = 'cousin';
  c.projects['acme-shop'].repos['acme-api'].checks = [];
  c.projects['acme-shop'].repos['acme-web'].deploy = { kind: 'amplify' };
  c.projects['acme-shop'].shipOrder = ['acme-api', 'missing'];
  c.projects['acme-advice'].ticketPrefix = 'adv';
  const p = validate(c).join('\n');
  for (const want of ['approver.name', 'critic.default', 'acme-api.checks', 'amplify needs appId and region', 'shipOrder', 'ticketPrefix']) assert.match(p, new RegExp(want.replace('.', '\\.')));
  // A ship order lists every configured repo exactly once.
  for (const [order, want] of [[['acme-api'], /shipOrder: must list every configured repo exactly once \(acme-api, acme-web\)/], [['acme-api', 'acme-web', 'acme-api'], /exactly once/], [['acme-web', 'acme-api'], null]]) {
    const d = example();
    d.projects['acme-shop'].shipOrder = order;
    if (want) assert.match(validate(d).join('\n'), want);
    else assert.deepEqual(validate(d), []);
  }
  const conf = { ...example(), projects: { cfg: { mode: 'configuration', source: '/s', tickets: '/t', repos: { r: { github: 'a/b', checks: ['c'] } } } } };
  assert.match(validate(conf).join('\n'), /configuration mode cannot select repositories/);
});

test('the Workflow line names the version and build, and says when the copy differs', (t) => {
  const s = sandbox();
  t.after(s.clean);
  const r = gitRepo(s.root, 'kit', 'main');
  r.commit('package.json', '{ "version": "0.1.0" }\n');
  r.commit('README.md', 'x\n');
  r.git('push', '-q', '-u', 'origin', 'main');
  r.git('remote', 'set-head', 'origin', 'main');
  assert.equal(workflowLine(r.work), 'Bollplank 0.1.0, build 2');
  writeFileSync(join(r.work, 'README.md'), 'changed\n');
  assert.equal(workflowLine(r.work), 'Bollplank 0.1.0, build 2, with uncommitted changes');
  r.git('commit', '-q', '-am', 'branch work');
  assert.equal(workflowLine(r.work), 'Bollplank 0.1.0, build 2 plus unmerged commits');
  assert.equal(workflowLine(s.home), 'Bollplank unknown, build unknown');
});

test('version and context read the installed kit and the config', (t) => {
  const s = sandbox();
  t.after(s.clean);
  assert.match(s.run(['version']).stdout, /^Bollplank \d+\.\d+\.\d+, build (\d+|unknown)/);
  assert.equal(s.run(['context']).json.failure, 'config');
  s.config(acmeConfig(join(s.root, 'src'), join(s.root, 'tickets'), undefined, { stopList: ['anything outside the ticket'] }));
  const c = s.run(['context', 'acme-shop']).json;
  assert.equal(c.ok, true);
  assert.equal(c.approver, 'Ada');
  assert.deepEqual(c.project.stopList, ['anything outside the ticket']);
  assert.deepEqual(c.project.shipOrder, ['acme-api']);
  assert.equal(s.run(['context', 'nope']).status, 2);
  assert.equal(s.run(['no-such-command']).status, 2);
});

test('the private name scan passes, fails or skips, and never prints a name', (t) => {
  const s = sandbox();
  t.after(s.clean);
  const r = gitRepo(s.root, 'pub', 'main');
  r.commit('README.md', 'public text\n');
  const list = join(s.bollplank, 'private-names.txt');
  const env = { BOLLPLANK_PRIVATE_NAMES: '# list\nsecretclient\nre:\\bACME-[0-9]+\\b\n' };
  assert.equal(scan(r.work, 'HEAD', {}, list).outcome, 'skipped');
  assert.equal(scan(r.work, 'HEAD', env, list).outcome, 'passed');
  writeFileSync(list, 'publictext\n');
  assert.equal(scan(r.work, 'HEAD', {}, list).source, list);
  r.commit('notes.md', 'a word about SecretClient\n');
  r.commit('notes.md', 'removed again\n', 'clean up');
  const inHistory = scan(r.work, 'HEAD', env, list);
  assert.equal(inHistory.outcome, 'failed');
  assert.deepEqual(inHistory.hits.map((h) => [h.pattern, h.file]), [[1, 'notes.md']]);
  assert.ok(!JSON.stringify(inHistory).toLowerCase().includes('secretclient'));
  r.commit('other.md', 'fine\n', 'Fix ACME-12 in the message');
  assert.ok(scan(r.work, 'HEAD', env, list).hits.some((h) => h.pattern === 2 && h.file === null));
});

test('the docs check fails on a real ticket key and an internal name or command, and passes on ACME-1', (t) => {
  assert.deepEqual(textProblems('Run ACME-1, then ACME-12.\nSee ACME-0.', 'README.md'), []);
  assert.deepEqual(textProblems('Fixed in GLOBEX-7 last week.', 'README.md'), ['README.md:1: a ticket key GLOBEX-7']);
  assert.deepEqual(textProblems('one\nThen run aw-merge on it.', 'docs/setup.md'), ['docs/setup.md:2: an internal command aw-merge']);
  assert.deepEqual(textProblems('Copied from agent-workflow.', 'SECURITY.md'), ['SECURITY.md:1: an internal name agent-workflow']);
  // A word that only contains the letters is not a hit, and the line is never echoed.
  assert.deepEqual(textProblems('Draw-in and raw-data are fine. So is UTF8.', 'docs/a.md'), []);
  const [hit] = textProblems('A long private line that names AB2-3 somewhere in it.', 'docs/a.md');
  assert.equal(hit, 'docs/a.md:1: a ticket key AB2-3');
  // Standards are not ticket keys, in any case.
  assert.deepEqual(textProblems('UTF-8, SHA-256, ISO-8601, HTTP-2, RFC-2119, AES-128, CVE-2024-1234, GPT-5, x86-64, sha-1, TLS-1, OAUTH-2, MD-5, CRC-32, ECMA-262, ES-2015, IPV-6 and acme-2.', 'docs/a.md'), []);
  // A key in lower case or with a non-breaking hyphen or an en dash is still a key.
  assert.deepEqual(textProblems('Branch globex-7, then GLOBEX\u20118 and GLOBEX\u20139.', 'docs/a.md'), ['docs/a.md:1: a ticket key globex-7', 'docs/a.md:1: a ticket key GLOBEX\u20118', 'docs/a.md:1: a ticket key GLOBEX\u20139']);
  // The internal name as words, and the internal command with another dash.
  assert.deepEqual(textProblems('From agent_workflow and the agent workflow kit. Run aw\u2011merge.', 'docs/a.md'), ['docs/a.md:1: an internal name agent_workflow', 'docs/a.md:1: an internal name agent workflow', 'docs/a.md:1: an internal command aw\u2011merge']);

  const root = mkdtempSync(join(tmpdir(), 'bollplank-docs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const d of ['docs/plans', 'skills/bollplank-x', 'prompts', 'lib', '.github/workflows']) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, 'README.md'), 'Run ACME-1.\n');
  writeFileSync(join(root, 'docs', 'plans', 'GLOBEX-7.md'), 'GLOBEX-7 and aw-run, while the work runs.\n');
  writeFileSync(join(root, 'skills', 'bollplank-x', 'SKILL.md'), 'ok\nUse aw-ticket.\n');
  writeFileSync(join(root, 'prompts', 'critic.md'), 'Read {ISSUE}.\n');
  writeFileSync(join(root, 'lib', 'turn.mjs'), '// reads the aw-turn lock\n');
  writeFileSync(join(root, 'AGENTS.md'), 'Examples use ACME-1.\nNot globex-4.\n');
  writeFileSync(join(root, '.github', 'workflows', 'checks.yml'), 'name: agent_workflow checks\n');
  assert.ok(!docsFiles(root).some((f) => f.includes('plans')));
  assert.deepEqual(docsProblems(root), ['AGENTS.md:2: a ticket key globex-4', '.github/workflows/checks.yml:1: an internal name agent_workflow', 'skills/bollplank-x/SKILL.md:2: an internal command aw-ticket']);
  // The shipped docs pass.
  assert.deepEqual(docsProblems(kit), []);
});

test('the editor schema needs checks only for a project with runs on, as validate does', () => {
  const schema = JSON.parse(readFileSync(new URL('../schema/config.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(schema.$defs.repo.required, ['github']);
  const p = schema.$defs.project;
  assert.deepEqual(p.if, { properties: { runs: { const: true } }, required: ['runs'] });
  assert.deepEqual(p.then, { properties: { repos: { additionalProperties: { required: ['checks'] } } } });
  const repo = { github: 'acme/acme-shop', baseBranch: 'main' };
  const config = (runs) => ({ approver: { name: 'Ada' }, board: { kind: 'linear' }, projects: { 'acme-shop': { source: '/acme', tickets: '/acme/Tickets', repos: { 'acme-shop': repo }, runs } } });
  assert.deepEqual(validate(config(false)), []);
  assert.match(validate(config(true)).join('\n'), /checks: at least one check name/);
});
