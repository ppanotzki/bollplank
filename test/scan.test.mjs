// The private name scan against synthetic repos. The planted name is SecretClient, matched by the
// plain pattern 1, and no result may contain it in any spelling.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scan, scanText } from '../lib/private-scan.mjs';
import { sandbox, gitRepo } from './helpers.mjs';

const env = { BOLLPLANK_PRIVATE_NAMES: '# list\nsecretclient\nre:\\bACME-[0-9]+\\b\n' };
const clean = (result) => assert.equal(JSON.stringify(result).toLowerCase().includes('secretclient'), false, 'the result names the name');

function repo(t) {
  const s = sandbox();
  t.after(s.clean);
  const r = gitRepo(s.root, 'pub', 'main');
  r.commit('README.md', 'public text\n');
  const list = join(s.bollplank, 'private-names.txt');
  return { s, r, list, check: () => scan(r.work, 'HEAD', env, list) };
}

// One hit for pattern 1, with the given file, and nothing else.
function onlyHit(result, file) {
  assert.equal(result.outcome, 'failed');
  clean(result);
  assert.deepEqual(result.hits.map((h) => [h.pattern, h.file]), [[1, file]]);
  assert.match(result.hits[0].commit, /^[0-9a-f]{12}$/);
}

test('a clean repo with a binary file passes', (t) => {
  const { r, check } = repo(t);
  writeFileSync(join(r.work, 'logo.bin'), Buffer.from([0, 1, 2, 0, 65, 99, 109, 101, 0]));
  r.git('add', 'logo.bin');
  r.git('commit', '-q', '-m', 'Add a logo\n\n- a bullet about Acme');
  assert.equal(check().outcome, 'passed');
});

test('a name in a bullet of a commit message is found', (t) => {
  const { r, check } = repo(t);
  r.commit('notes.md', 'fine\n', 'Tidy the notes\n\n- moved the SecretClient section\n- nothing else');
  onlyHit(check(), null);
});

test('a name in the committer is found', (t) => {
  const { r, check } = repo(t);
  writeFileSync(join(r.work, 'notes.md'), 'fine\n');
  r.git('add', 'notes.md');
  execFileSync('git', ['-C', r.work, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'notes'], { env: { ...process.env, GIT_COMMITTER_NAME: 'Acme', GIT_COMMITTER_EMAIL: 'bot@secretclient.example' } });
  onlyHit(check(), null);
});

test('a name in a binary file is found', (t) => {
  const { r, check } = repo(t);
  writeFileSync(join(r.work, 'data.bin'), Buffer.concat([Buffer.from([0, 0, 1]), Buffer.from('SecretClient'), Buffer.from([0, 2])]));
  r.git('add', 'data.bin');
  r.git('commit', '-q', '-m', 'data');
  onlyHit(check(), 'data.bin');
});

test('a name in a file marked -diff in .gitattributes is found', (t) => {
  const { r, check } = repo(t);
  r.commit('.gitattributes', 'hidden.txt -diff\nother.txt binary\n');
  r.commit('hidden.txt', 'a line about SecretClient\n');
  onlyHit(check(), 'hidden.txt');
  r.commit('hidden.txt', 'gone\n', 'clean up');
  r.commit('other.txt', 'SecretClient again\n');
  assert.deepEqual(check().hits.map((h) => h.file), ['other.txt', 'hidden.txt']);
});

test('a name that only a merge commit adds is found', (t) => {
  const { r, check } = repo(t);
  r.git('checkout', '-q', '-b', 'side');
  r.commit('side.md', 'side work\n');
  r.git('checkout', '-q', 'main');
  r.commit('main.md', 'main work\n');
  r.git('merge', '-q', '--no-ff', '--no-commit', 'side');
  writeFileSync(join(r.work, 'main.md'), 'main work for SecretClient\n');
  r.git('add', 'main.md');
  r.git('commit', '-q', '-m', 'Merge side');
  const result = check();
  assert.equal(result.outcome, 'failed');
  clean(result);
  assert.ok(result.hits.length >= 1);
  assert.ok(result.hits.every((h) => h.pattern === 1 && h.file === 'main.md'));
  assert.equal(result.hits[0].commit, r.git('rev-parse', 'HEAD').slice(0, 12));
});

test('a name in a path withholds the path, and a non ASCII path is matched as written', (t) => {
  const { r, check, list } = repo(t);
  r.commit('docs/secretclient-notes.md', 'nothing here\n', 'Add notes');
  const result = check();
  assert.equal(result.outcome, 'failed');
  clean(result);
  assert.ok(result.hits.length >= 1);
  assert.ok(result.hits.every((h) => h.pattern === 1 && h.file === '(path withheld)'));
  const other = repo(t);
  other.r.commit('docs/Åcme-notes.md', 'nothing here\n', 'Add notes');
  const accented = scan(other.r.work, 'HEAD', { BOLLPLANK_PRIVATE_NAMES: 'åcme-notes\n' }, list);
  assert.equal(accented.outcome, 'failed');
  assert.ok(accented.hits.every((h) => h.file === '(path withheld)'));
});

test('a removed line inside a diff is not a second hit, but a message line starting with - is read', (t) => {
  const { r, check } = repo(t);
  r.commit('notes.md', 'about SecretClient\n');
  r.commit('notes.md', 'clean\n', 'clean up');
  onlyHit(check(), 'notes.md');
});

test('a shallow clone fails with a reason, since part of its history is missing', (t) => {
  const { s, r } = repo(t);
  r.commit('two.md', 'two\n');
  r.git('push', '-q', 'origin', 'main');
  const shallow = join(s.root, 'shallow');
  execFileSync('git', ['clone', '-q', '--depth', '1', `file://${r.origin}`, shallow]);
  const result = scan(shallow, 'HEAD', env, join(s.bollplank, 'private-names.txt'));
  assert.equal(result.outcome, 'failed');
  assert.match(result.reason, /shallow/);
  assert.equal(result.hits, undefined);
});

test('an invalid pattern fails by its number and never shows its text', (t) => {
  const { r, list } = repo(t);
  const bad = { BOLLPLANK_PRIVATE_NAMES: 'acme\nre:SecretClient(\n' };
  for (const result of [scan(r.work, 'HEAD', bad, list), scanText({ title: 'Acme' }, bad, list)]) {
    assert.equal(result.outcome, 'failed');
    assert.equal(result.reason, 'pattern 2 is not a valid regular expression');
    clean(result);
  }
});

test('scanText fails on a name and never echoes it', (t) => {
  const { list } = repo(t);
  const result = scanText({ title: 'Fix', body: 'For SecretClient\nand ACME-7' }, env, list);
  assert.equal(result.outcome, 'failed');
  assert.deepEqual(result.hits, [{ pattern: 1, where: 'body' }, { pattern: 2, where: 'body' }]);
  clean(result);
});
