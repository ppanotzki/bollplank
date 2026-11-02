import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, missing } from '../lib/args.mjs';
import { validate, withDefaults } from '../lib/config.mjs';
import { workflowLine } from '../lib/version.mjs';
import { scan } from '../lib/private-scan.mjs';
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
