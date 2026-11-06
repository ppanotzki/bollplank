import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, globToRegExp, readPushTrigger } from '../lib/workflow-filter.mjs';

const read = (text) => readPushTrigger(text);
const matches = (pattern, value) => globToRegExp(pattern).test(value);

test('the reader takes the on key as a scalar, a flow list, a block list or a map', () => {
  assert.deepEqual(read('on: push\n'), { events: ['push'], push: null });
  assert.deepEqual(read("'on': [push, \"workflow_dispatch\"] # both\n"), { events: ['push', 'workflow_dispatch'], push: null });
  assert.deepEqual(read('on:\n  - push\n  - workflow_dispatch\n'), { events: ['push', 'workflow_dispatch'], push: null });
  assert.deepEqual(read('on:\n- push\n'), { events: ['push'], push: null });
  assert.deepEqual(read('name: x\non:\n  push:\n  workflow_dispatch:\n    inputs:\n      why:\n        type: string\njobs:\n  a:\n    runs-on: x\n'), { events: ['push', 'workflow_dispatch'], push: null });
  assert.deepEqual(read('on:\n  push: {}\n'), { events: ['push'], push: null });
});

test('the reader takes the push filters as flow or block lists, quoted or plain', () => {
  const text = [
    '# deploy',
    'on:',
    '  push:',
    '    branches: [ main, "release/**" ]',
    '    paths:',
    "      - 'src/**'",
    '      - "!src/**/*.md"   # not docs',
    '      - infra/*.tf',
    '',
    '  workflow_dispatch:',
    'jobs: {}',
  ].join('\n');
  assert.deepEqual(read(text), { events: ['push', 'workflow_dispatch'], push: { branches: ['main', 'release/**'], paths: ['src/**', '!src/**/*.md', 'infra/*.tf'] } });
  assert.deepEqual(read("on:\n  push:\n    paths-ignore:\n    - 'docs/**'\n    - 'it''s.md'\n"), { events: ['push'], push: { 'paths-ignore': ['docs/**', "it's.md"] } });
  assert.deepEqual(read('on:\r\n  push:\r\n    paths: [a]\r\n'), { events: ['push'], push: { paths: ['a'] } });
});

test('the reader gives unknown for every shape it cannot read with certainty', () => {
  for (const [text, reason] of [
    ['name: x\n', /no on key/],
    ['on: push\non: pull_request\n', /twice/],
    ['on:\n\tpush:\n', /tabs/],
    ["x: &p ['a']\non:\n  push:\n    paths: *p\n", /cannot read/],
    ['on:\n  push:\n    paths: |\n      a\n', /a value and lines under it/],
    ['on:\n  push:\n    paths: >-\n', /cannot read/],
    ['on: {push: {paths: [a]}}\n', /cannot read/],
    ['on:\n  push:\n    paths: [a, [b]]\n', /cannot read/],
    ["on:\n  push:\n    paths: ['a,b']\n", /cannot read/],
    ['on:\n  push:\n    <<: *defaults\n', /does not know/],
    ['on:\n  push:\n    types: [x]\n', /does not know/],
    ['on:\n  push:\n    paths: [a]\n    paths: [b]\n', /twice/],
    ['on:\n  push:\n    paths:\n', /empty list/],
    ['on:\n  push:\n      paths: [a]\n    branches: [b]\n', /unevenly/],
    ['on:\n  push: x\n', /value/],
    ['on: push\n---\non: pull_request\n', /more than one YAML document/],
    ['on:\n  push:\n    paths:\n      - !tag x\n', /cannot read/],
  ]) {
    const r = read(text);
    assert.ok(r.unknown, `${JSON.stringify(text)} gave ${JSON.stringify(r)}`);
    assert.match(r.unknown, reason, JSON.stringify(text));
  }
});

test('patterns follow the cases of GitHub filter pattern cheat sheet', () => {
  const cases = [
    ['feature/*', ['feature/my-branch', 'feature/your-branch'], ['feature/a/b']],
    ['feature/**', ['feature/beta-a/my-branch', 'feature/your-branch', 'feature/mona/the/octocat'], ['features/x']],
    ['main', ['main'], ['main2', 'releases/main']],
    ['v2*', ['v2', 'v2.0', 'v2.9'], ['v1']],
    ['v[12].[0-9]+.[0-9]+', ['v1.10.1', 'v2.0.0'], ['v3.0.0', 'v1.x.1']],
    ['*', ['README.md', 'server.rb'], ['docs/README.md']],
    ['*.jsx?', ['page.js', 'page.jsx'], ['page.jsxx', 'src/page.js']],
    ['**', ['all/the/files.md'], []],
    ['*.js', ['app.js', 'index.js'], ['src/app.js']],
    ['**.js', ['index.js', 'js/index.js', 'src/js/app.js'], ['index.ts']],
    ['docs/*', ['docs/README.md', 'docs/file.txt'], ['docs/a/b.md']],
    ['docs/**', ['docs/README.md', 'docs/mona/octocat.txt'], ['README.md']],
    ['docs/**/*.md', ['docs/README.md', 'docs/mona/hello-world.md', 'docs/a/markdown/file.md'], ['docs/a.txt']],
    ['**/docs/**', ['docs/hello.md', 'dir/docs/my-file.txt', 'space/docs/plan/space.doc'], ['documents/x']],
    ['**/README.md', ['README.md', 'js/README.md'], ['README.md.bak']],
    ['**/*src/**', ['a/src/app.js', 'my-src/code/js/app.js'], ['src.txt']],
    ['**/*-post.md', ['my-post.md', 'path/their-post.md'], ['post.md']],
    ['**/migrate-*.sql', ['migrate-10909.sql', 'db/migrate-v1.0.sql', 'db/sept/migrate-v1.sql'], ['migrate.sql']],
    ['a\\*b', ['a*b'], ['axb']],
  ];
  for (const [pattern, yes, no] of cases) {
    for (const v of yes) assert.ok(matches(pattern, v), `${pattern} should match ${v}`);
    for (const v of no) assert.ok(!matches(pattern, v), `${pattern} should not match ${v}`);
  }
});

test('patterns outside the syntax give null', () => {
  for (const p of ['', '?a', '+a', '**?', '*+', '[]', '[^a]', '[a', '[!x]', 'a\\']) assert.equal(globToRegExp(p), null, p);
});

const trigger = (push, events = ['push']) => ({ events, push });

test('decide answers runs, does-not-run or unknown', () => {
  const d = (push, files, o = {}) => decide({ trigger: trigger(push, o.events), baseBranch: o.base === undefined ? 'main' : o.base, files });
  assert.equal(d(null, null).answer, 'runs');
  assert.equal(d({ branches: ['main'] }, null).answer, 'runs');
  assert.equal(d({ branches: ['release/**'] }, null).answer, 'does-not-run');
  assert.equal(d({ branches: ['*', '!main'] }, null).answer, 'does-not-run');
  assert.equal(d({ 'branches-ignore': ['main'] }, null).answer, 'does-not-run');
  assert.equal(d({ 'branches-ignore': ['dev'] }, null).answer, 'runs');
  assert.equal(d({ branches: ['main'] }, null, { base: null }).answer, 'unknown');
  assert.equal(d({ paths: ['src/**'] }, ['src/a.js']).answer, 'runs');
  assert.equal(d({ paths: ['src/**'] }, ['docs/a.md']).answer, 'does-not-run');
  assert.equal(d({ paths: ['src/**', '!src/*.md'] }, ['src/a.md']).answer, 'does-not-run');
  assert.equal(d({ paths: ['src/**', '!src/*.md', 'src/keep.md'] }, ['src/keep.md']).answer, 'runs');
  assert.equal(d({ 'paths-ignore': ['docs/**'] }, ['docs/a.md']).answer, 'does-not-run');
  assert.equal(d({ 'paths-ignore': ['docs/**'] }, ['docs/a.md', 'b']).answer, 'runs');
  // Branches and paths must both pass, so a branch exclusion needs no files.
  assert.equal(d({ branches: ['dev'], paths: ['src/**'] }, () => assert.fail('files read')).answer, 'does-not-run');
  for (const [push, files, o, reason] of [
    [null, null, { events: ['push', 'workflow_run'] }, /also runs on workflow_run/],
    [null, null, { events: ['pull_request', 'push', 'schedule'] }, /also runs on pull_request, schedule/],
    [null, null, { events: ['workflow_dispatch'] }, /no push trigger/],
    [{ tags: ['v*'] }, null, {}, /tag filter/],
    [{ branches: ['a'], 'branches-ignore': ['b'] }, null, {}, /both branches/],
    [{ paths: ['a'], 'paths-ignore': ['b'] }, ['a'], {}, /both paths/],
    [{ paths: ['!a'] }, ['b'], {}, /only ! patterns/],
    [{ 'paths-ignore': ['docs/**', '!docs/x'] }, ['docs/x'], {}, /paths-ignore with a !/],
    [{ paths: ['[^a]'] }, ['b'], {}, /outside the syntax/],
    [{ paths: ['a'] }, null, {}, /not known/],
    [{ paths: ['a'] }, [], {}, /no file/],
    [{ paths: ['a'] }, Array.from({ length: 301 }, (_, i) => `f${i}`), {}, /more than 300/],
  ]) {
    const r = d(push, files, o);
    assert.equal(r.answer, 'unknown', JSON.stringify(push));
    assert.match(r.reason, reason);
  }
  assert.equal(decide({ trigger: { unknown: 'no on key' } }).reason, 'no on key');
});
