import test from 'node:test';
import assert from 'node:assert/strict';
import { disposableMatcher, disposableProblem } from '../lib/disposable.mjs';

test('disposable patterns match from the repo root, with * within a name, ** for folders and / for a folder only', () => {
  const m = disposableMatcher(['dist/', 'packages/*/dist/', '**/*.tsbuildinfo', 'coverage', 'out/**']);
  for (const yes of ['dist/', 'dist/a.js', 'dist/sub/b.js', 'packages/acme-ui/dist/', 'packages/acme-ui/dist/x.js', 'tsconfig.tsbuildinfo', 'packages/acme-ui/tsconfig.tsbuildinfo', 'coverage', 'coverage/', 'coverage/lcov.info', 'out/x', 'out/a/b']) {
    assert.equal(m(yes), true, yes);
  }
  for (const no of ['dist', 'src/dist/', 'packages/a/b/dist/', 'distx/', 'acme.env', 'build/', 'cache/', 'a.tsbuildinfo.bak', 'out/', 'coverage.txt', 'packages/acme-ui/', 'packages/dist/']) {
    assert.equal(m(no), false, no);
  }
  // A file pattern never makes a folder disposable because of what it holds.
  assert.equal(disposableMatcher(['**/*.tsbuildinfo'])('cache/'), false);
  assert.equal(disposableMatcher([])('dist/'), false);
  assert.equal(disposableMatcher()('dist/'), false);
  // Dots and other characters are literal.
  assert.equal(disposableMatcher(['a.b'])('axb'), false);
  assert.equal(disposableMatcher(['a+b(c)'])('a+b(c)'), true);
  // ** in the middle is zero or more folders.
  const mid = disposableMatcher(['src/**/gen/']);
  assert.equal(mid('src/gen/'), true);
  assert.equal(mid('src/a/b/gen/'), true);
  assert.equal(mid('src/a/gen.js'), false);
});

test('a disposable pattern that could match real work or reads another way is refused', () => {
  for (const ok of ['dist/', '**/*.tsbuildinfo', 'packages/*/dist/', 'out/**', 'a b/c', '.cache/']) assert.equal(disposableProblem(ok), null, ok);
  const cases = [
    [undefined, /not empty/], [3, /not empty/], ['', /not empty/], ['  ', /not empty/], [' dist/', /space/],
    ['/dist', /relative/], ['~/dist', /relative/],
    ['dist?', /only \* and \*\*/], ['[ab]', /only/], ['{a,b}', /only/], ['!dist', /only/], ['a\\b', /only/],
    ['a//b', /empty folder name/], ['dist//', /empty folder name/], ['./dist', /\. or \.\./], ['a/../b', /\. or \.\./],
    ['a**', /whole folder name/], ['**.js', /whole folder name/],
    ['*', /anything/], ['**', /anything/], ['**/*', /anything/], ['*/', /anything/], ['**/', /anything/], ['*/*', /anything/], ['**/**', /anything/],
  ];
  for (const [p, want] of cases) assert.match(disposableProblem(p) ?? 'null', want, String(p));
});
