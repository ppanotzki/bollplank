import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, gitRepo, acmeConfig, isWindows } from './helpers.mjs';
import { submoduleChecks } from '../lib/commands/ticket.mjs';

const g = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// Three repos under one source folder: acme-api on main (configured), acme-web on trunk (found
// through origin/HEAD) and acme-lib on master (the fallback). acme-web validates against acme-lib.
function setup(t) {
  const s = sandbox();
  t.after(s.clean);
  const source = join(s.root, 'src');
  const tickets = join(s.root, 'tickets');
  mkdirSync(source, { recursive: true });
  const repos = {};
  for (const [name, branch] of [['acme-api', 'main'], ['acme-web', 'trunk'], ['acme-lib', 'master']]) {
    const r = gitRepo(source, name, branch);
    r.commit('.gitignore', 'node_modules\n');
    r.commit('README.md', `${name}\n`);
    r.git('push', '-q', '-u', 'origin', branch);
    repos[name] = r;
  }
  repos['acme-web'].git('remote', 'set-head', 'origin', 'trunk');
  mkdirSync(join(repos['acme-api'].work, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(repos['acme-api'].work, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
  if (!isWindows) {
    mkdirSync(join(repos['acme-api'].work, 'node_modules', '.bin'));
    symlinkSync('../pkg/index.js', join(repos['acme-api'].work, 'node_modules', '.bin', 'pkg'));
  }
  s.config(acmeConfig(source, tickets, {
    'acme-api': { github: 'acme/acme-api', checks: ['checks'], baseBranch: 'main', cloneNodeModules: true },
    'acme-web': { github: 'acme/acme-web', checks: ['checks'] },
    'acme-lib': { github: 'acme/acme-lib', checks: ['checks'] },
  }, { validatesAgainst: { 'acme-web': ['acme-lib'] } }));
  const ticket = (...a) => s.run(['ticket', ...a]);
  return { s, source, tickets, repos, ticket, folder: (id) => join(tickets, id) };
}

test('create makes one worktree per repo from each base branch and adds validation repos', (t) => {
  const f = setup(t);
  const r = f.ticket('create', 'acme-shop', 'acme-1', '--slug', 'Add Thing!', '--change', 'acme-api,acme-web');
  assert.equal(r.status, 0, r.stdout);
  const folder = f.folder('ACME-1');
  assert.equal(r.json.branch, 'acme-1-add-thing');
  assert.deepEqual(Object.keys(r.json.repos), ['acme-api', 'acme-web', 'acme-lib']);
  assert.equal(r.json.repos['acme-api'].baseBranch, 'main');
  assert.equal(r.json.repos['acme-web'].baseBranch, 'trunk');
  assert.equal(r.json.repos['acme-lib'].baseBranch, 'master');
  assert.equal(r.json.repos['acme-lib'].kind, 'validate');
  assert.equal(r.json.repos['acme-api'].nodeModules, process.platform === 'darwin' ? 'cloned' : 'copied');
  assert.equal(r.json.repos['acme-web'].nodeModules, null);
  assert.equal(g(join(folder, 'acme-api'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'acme-1-add-thing');
  assert.equal(g(join(folder, 'acme-web'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'acme-1-add-thing');
  assert.equal(g(join(folder, 'acme-lib'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD');
  const nm = join(folder, 'acme-api', 'node_modules');
  assert.equal(readFileSync(join(nm, 'pkg', 'index.js'), 'utf8'), 'module.exports = 1;\n');
  assert.ok(!lstatSync(nm).isSymbolicLink());
  if (!isWindows) assert.equal(readlinkSync(join(nm, '.bin', 'pkg')), '../pkg/index.js');
  const record = JSON.parse(readFileSync(join(folder, '.ticket.json'), 'utf8'));
  assert.equal(record.repos['acme-web'].baseBranch, 'trunk');
  assert.equal(f.ticket('create', 'acme-shop', 'ACME-1', '--slug', 'again', '--change', 'acme-api').json.failure, 'exists');

  const st = f.ticket('status', 'acme-shop', 'ACME-1').json;
  assert.equal(st.ok, true);
  assert.equal(st.repos['acme-api'].changedFiles, 0);
  writeFileSync(join(folder, 'acme-api', 'new.txt'), 'x\n');
  assert.equal(f.ticket('status', 'acme-shop', 'ACME-1').json.repos['acme-api'].changedFiles, 1);
});

test('create checks its arguments and refuses unknown repos and ticket ids', (t) => {
  const f = setup(t);
  assert.equal(f.ticket('create', 'acme-shop', 'ACME-1', '--change', 'acme-api').status, 2);
  assert.equal(f.ticket('create', 'acme-shop', 'ACME-1', '--slug', 'x').status, 2);
  assert.match(f.ticket('create', 'acme-shop', 'ACME-1', '--slug', 'x', '--change', 'acme-nope').json.detail, /unknown repo acme-nope/);
  assert.equal(f.ticket('create', 'acme-shop', 'ACME/1', '--slug', 'x', '--change', 'acme-api').status, 2);
  assert.equal(f.ticket('fold', 'acme-shop', 'ACME-1').status, 2);
  assert.equal(f.ticket('status', 'acme-shop', 'ACME-1').json.failure, 'no-ticket-folder');
  assert.equal(existsSync(f.folder('ACME-1')), false);
});

test('a create that fails partway rolls back the worktrees it made', (t) => {
  const f = setup(t);
  // acme-web already has the ticket branch, so its worktree add fails after acme-api's succeeded.
  f.repos['acme-web'].git('branch', 'acme-2-thing');
  const r = f.ticket('create', 'acme-shop', 'ACME-2', '--slug', 'thing', '--change', 'acme-api,acme-web');
  assert.equal(r.status, 1, r.stdout);
  assert.equal(r.json.failure, 'create-failed');
  assert.deepEqual(r.json.rolledBack, ['acme-api']);
  assert.equal(existsSync(f.folder('ACME-2')), false);
  assert.equal(g(f.repos['acme-api'].work, 'worktree', 'list').split('\n').length, 1);
  assert.equal(g(f.repos['acme-api'].work, 'branch', '--list', 'acme-2-thing'), '');
  // A branch the create did not make is left alone.
  assert.match(g(f.repos['acme-web'].work, 'branch', '--list', 'acme-2-thing'), /acme-2-thing/);
});

test('refresh moves validation checkouts to the new base and refuses when one has local changes', (t) => {
  const f = setup(t);
  f.ticket('create', 'acme-shop', 'ACME-3', '--slug', 'x', '--change', 'acme-web');
  const lib = f.repos['acme-lib'];
  const newHead = lib.commit('README.md', 'acme-lib v2\n');
  lib.git('push', '-q', 'origin', 'master');
  f.repos['acme-web'].commit('web.txt', 'new\n');
  f.repos['acme-web'].git('push', '-q', 'origin', 'trunk');
  const libCheckout = join(f.folder('ACME-3'), 'acme-lib');
  writeFileSync(join(libCheckout, 'README.md'), 'local edit\n');
  const refused = f.ticket('refresh', 'acme-shop', 'ACME-3');
  assert.equal(refused.json.failure, 'refused');
  assert.match(refused.json.detail, /acme-lib/);
  g(libCheckout, 'checkout', '--', 'README.md');
  const r = f.ticket('refresh', 'acme-shop', 'ACME-3');
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.repos['acme-lib'].head, newHead);
  assert.equal(r.json.repos['acme-web'].behind, 1);
});

test('remove refuses changes or unlanded work, accepts a recorded squash merge, and removes through Node', (t) => {
  const f = setup(t);
  f.ticket('create', 'acme-shop', 'ACME-4', '--slug', 'x', '--change', 'acme-api');
  const folder = f.folder('ACME-4');
  const wt = join(folder, 'acme-api');
  writeFileSync(join(wt, 'feature.txt'), 'feature\n');
  let r = f.ticket('remove', 'acme-shop', 'ACME-4');
  assert.equal(r.json.failure, 'refused');
  assert.match(r.json.refusals[0], /uncommitted or untracked/);
  g(wt, 'add', 'feature.txt');
  g(wt, 'commit', '-q', '-m', 'feature');
  const head = g(wt, 'rev-parse', 'HEAD');
  r = f.ticket('remove', 'acme-shop', 'ACME-4');
  assert.match(r.json.refusals[0], /1 commits not on main and no merged PR/);

  // The PR was squash merged: the same change lands on main as a new commit.
  const api = f.repos['acme-api'];
  api.commit('feature.txt', 'feature\n', 'Feature (#1)');
  api.git('push', '-q', 'origin', 'main');
  writeFileSync(join(folder, '.run.json'), JSON.stringify({ repos: { 'acme-api': { merged: true, pr: 1, finalHead: head } } }));
  writeFileSync(join(wt, 'later.txt'), 'later\n');
  g(wt, 'add', 'later.txt');
  g(wt, 'commit', '-q', '-m', 'after the merge');
  r = f.ticket('remove', 'acme-shop', 'ACME-4');
  assert.match(r.json.refusals[0], /commits after the merged head/);
  g(wt, 'reset', '-q', '--hard', head);

  r = f.ticket('remove', 'acme-shop', 'ACME-4');
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(r.json.removed, ['acme-api']);
  assert.equal(r.json.folderRemoved, true);
  assert.equal(existsSync(folder), false);
  assert.equal(api.git('branch', '--list', 'acme-4-x'), '');
  assert.equal(api.git('worktree', 'list').split('\n').length, 1);
});

test('remove accepts work that landed on the base branch and a worktree that is already gone', (t) => {
  const f = setup(t);
  f.ticket('create', 'acme-shop', 'ACME-5', '--slug', 'x', '--change', 'acme-web');
  const folder = f.folder('ACME-5');
  execFileSync('git', ['-C', f.repos['acme-lib'].work, 'worktree', 'remove', '--force', join(folder, 'acme-lib')]);
  writeFileSync(join(folder, 'notes.md'), 'kept by remove\n');
  const r = f.ticket('remove', 'acme-shop', 'ACME-5');
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.folderRemoved, false);
  assert.ok(existsSync(join(folder, 'notes.md')));
  assert.equal(existsSync(join(folder, '.ticket.json')), false);
  assert.equal(f.repos['acme-web'].git('branch', '--list', 'acme-5-x'), '');
});

test('remove checks the ticket branch itself, also when the worktree is detached or gone', (t) => {
  const f = setup(t);
  f.ticket('create', 'acme-shop', 'ACME-6', '--slug', 'x', '--change', 'acme-web');
  const folder = f.folder('ACME-6');
  const wt = join(folder, 'acme-web');
  writeFileSync(join(wt, 'work.txt'), 'work\n');
  g(wt, 'add', 'work.txt');
  g(wt, 'commit', '-q', '-m', 'work on the branch');
  const tip = g(wt, 'rev-parse', 'HEAD');
  // The worktree moves off the branch, so its HEAD is on the base, but the branch keeps the work.
  g(wt, 'checkout', '-q', '--detach', 'origin/trunk');
  let r = f.ticket('remove', 'acme-shop', 'ACME-6');
  assert.equal(r.status, 1, r.stdout);
  assert.deepEqual(r.json.refusals, ['acme-web branch acme-6-x: 1 commits not on trunk and no merged PR in the run record']);
  // The worktree folder is gone, and the branch is still refused before any branch -D.
  execFileSync('git', ['-C', f.repos['acme-web'].work, 'worktree', 'remove', '--force', wt]);
  r = f.ticket('remove', 'acme-shop', 'ACME-6');
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.json.refusals.join('\n'), /acme-web branch acme-6-x: 1 commits not on trunk/);
  assert.equal(f.repos['acme-web'].git('rev-parse', 'refs/heads/acme-6-x'), tip);
  // A merged head that is not the branch tip is refused. The branch tip itself is accepted.
  writeFileSync(join(folder, '.run.json'), JSON.stringify({ repos: { 'acme-web': { merged: true, pr: 2, finalHead: f.repos['acme-web'].git('rev-parse', 'origin/trunk~0') } } }));
  assert.match(f.ticket('remove', 'acme-shop', 'ACME-6').json.refusals[0], /acme-web branch acme-6-x: commits after the merged head/);
  writeFileSync(join(folder, '.run.json'), JSON.stringify({ repos: { 'acme-web': { merged: true, pr: 2, finalHead: tip.toUpperCase() } } }));
  r = f.ticket('remove', 'acme-shop', 'ACME-6');
  assert.equal(r.status, 0, r.stdout);
  assert.equal(f.repos['acme-web'].git('branch', '--list', 'acme-6-x'), '');
});

test('remove lists ignored files other than node_modules and deletes them only with --force-ignored', (t) => {
  const f = setup(t);
  f.ticket('create', 'acme-shop', 'ACME-7', '--slug', 'x', '--change', 'acme-api');
  const wt = join(f.folder('ACME-7'), 'acme-api');
  assert.ok(existsSync(join(wt, 'node_modules')));
  // info/exclude is shared by every worktree of the repo.
  writeFileSync(join(f.repos['acme-api'].work, '.git', 'info', 'exclude'), 'acme.env\nbuild/\n');
  writeFileSync(join(wt, 'acme.env'), 'ACME_SETTING=1\n');
  mkdirSync(join(wt, 'build'));
  writeFileSync(join(wt, 'build', 'out.txt'), 'out\n');
  let r = f.ticket('remove', 'acme-shop', 'ACME-7');
  assert.equal(r.status, 1, r.stdout);
  assert.deepEqual(r.json.ignored, { 'acme-api': ['acme.env', 'build/'] });
  assert.match(r.json.refusals[0], /^acme-api: ignored files that removal would delete: acme\.env, build\/\. Move them away, or pass --force-ignored to delete them\.$/);
  assert.ok(existsSync(join(wt, 'acme.env')));
  r = f.ticket('remove', 'acme-shop', 'ACME-7', '--force-ignored');
  assert.equal(r.status, 0, r.stdout);
  assert.equal(existsSync(wt), false);
});

test('remove deletes the repo\'s disposable ignored paths without asking, names them, and still refuses the rest', (t) => {
  const f = setup(t);
  // The setup's config with disposable patterns on acme-api.
  const c = JSON.parse(readFileSync(join(f.s.bollplank, 'config.json'), 'utf8'));
  c.projects['acme-shop'].repos['acme-api'].disposable = ['build/', '**/*.tsbuildinfo'];
  f.s.config(c);
  f.ticket('create', 'acme-shop', 'ACME-9', '--slug', 'x', '--change', 'acme-api');
  const wt = join(f.folder('ACME-9'), 'acme-api');
  writeFileSync(join(f.repos['acme-api'].work, '.git', 'info', 'exclude'), 'acme.env\nbuild/\n*.tsbuildinfo\ncache/\n');
  mkdirSync(join(wt, 'build'));
  writeFileSync(join(wt, 'build', 'out.txt'), 'out\n');
  mkdirSync(join(wt, 'pkg'));
  writeFileSync(join(wt, 'pkg', 'keep.txt'), 'tracked\n');
  g(wt, 'add', 'pkg/keep.txt');
  g(wt, 'commit', '-q', '-m', 'pkg');
  g(wt, 'push', '-q', 'origin', 'HEAD:main');
  writeFileSync(join(wt, 'pkg', 'tsconfig.tsbuildinfo'), '{}\n');
  writeFileSync(join(wt, 'tsconfig.tsbuildinfo'), '{}\n');
  // A folder git reports as one entry is not disposable because of a file it holds.
  mkdirSync(join(wt, 'cache'));
  writeFileSync(join(wt, 'cache', 'a.tsbuildinfo'), '{}\n');
  writeFileSync(join(wt, 'acme.env'), 'ACME_SETTING=1\n');
  let r = f.ticket('remove', 'acme-shop', 'ACME-9');
  assert.equal(r.status, 1, r.stdout);
  assert.deepEqual(r.json.ignored, { 'acme-api': ['acme.env', 'cache/'] });
  assert.match(r.json.refusals[0], /^acme-api: ignored files that removal would delete: acme\.env, cache\/\. Move them away/);
  assert.ok(existsSync(join(wt, 'build', 'out.txt')));
  rmSync(join(wt, 'acme.env'));
  rmSync(join(wt, 'cache'), { recursive: true });
  r = f.ticket('remove', 'acme-shop', 'ACME-9');
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(r.json.disposable, { 'acme-api': ['build/', 'pkg/tsconfig.tsbuildinfo', 'tsconfig.tsbuildinfo'] });
  assert.equal(existsSync(wt), false);
  // --force-ignored still deletes every ignored file, and the output names only the disposable ones.
  f.ticket('create', 'acme-shop', 'ACME-12', '--slug', 'x', '--change', 'acme-api');
  const wt2 = join(f.folder('ACME-12'), 'acme-api');
  mkdirSync(join(wt2, 'build'));
  writeFileSync(join(wt2, 'build', 'out.txt'), 'out\n');
  writeFileSync(join(wt2, 'acme.env'), 'ACME_SETTING=1\n');
  r = f.ticket('remove', 'acme-shop', 'ACME-12', '--force-ignored');
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(r.json.disposable, { 'acme-api': ['build/'] });
  assert.equal(existsSync(wt2), false);
});

test('remove sees untracked and ignored files even when status.showUntrackedFiles is no', (t) => {
  const f = setup(t);
  f.ticket('create', 'acme-shop', 'ACME-11', '--slug', 'x', '--change', 'acme-api');
  const wt = join(f.folder('ACME-11'), 'acme-api');
  f.repos['acme-api'].git('config', 'status.showUntrackedFiles', 'no');
  writeFileSync(join(wt, 'draft.md'), 'work\n');
  let r = f.ticket('remove', 'acme-shop', 'ACME-11');
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.json.refusals[0], /acme-api: uncommitted or untracked changes/);
  rmSync(join(wt, 'draft.md'));
  writeFileSync(join(f.repos['acme-api'].work, '.git', 'info', 'exclude'), 'acme.env\n');
  writeFileSync(join(wt, 'acme.env'), 'ACME_SETTING=1\n');
  r = f.ticket('remove', 'acme-shop', 'ACME-11');
  assert.equal(r.status, 1, r.stdout);
  assert.deepEqual(r.json.ignored, { 'acme-api': ['acme.env'] });
});

test('remove without disposable paths gives the same output as before', (t) => {
  const f = setup(t);
  f.ticket('create', 'acme-shop', 'ACME-10', '--slug', 'x', '--change', 'acme-api');
  const r = f.ticket('remove', 'acme-shop', 'ACME-10');
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(Object.keys(r.json).sort(), ['folder', 'folderRemoved', 'ok', 'removed', 'ticket']);
});

test('a ticket or run record that is not valid JSON is a corrupt failure, never a crash', (t) => {
  const f = setup(t);
  f.ticket('create', 'acme-shop', 'ACME-8', '--slug', 'x', '--change', 'acme-api');
  writeFileSync(join(f.folder('ACME-8'), '.run.json'), '{"repos":');
  let r = f.ticket('remove', 'acme-shop', 'ACME-8');
  assert.equal(r.json.failure, 'corrupt');
  assert.equal(r.json.file, join(f.folder('ACME-8'), '.run.json'));
  writeFileSync(join(f.folder('ACME-8'), '.ticket.json'), 'not json');
  r = f.ticket('status', 'acme-shop', 'ACME-8');
  assert.equal(r.json.failure, 'corrupt');
  assert.match(r.json.detail, /\.ticket\.json is not valid JSON/);
});

// acme-api with a submodule lib (its own bare remote), which holds a nested submodule deep. Both
// ignore *.env and dist/. The ticket worktree initializes them as a gate would.
const sub = (dir, ...args) => g(dir, '-c', 'protocol.file.allow=always', ...args);
function withSubmodules(t, ticketId, disposable) {
  const f = setup(t);
  const deep = gitRepo(f.s.root, 'acme-deep', 'main');
  deep.commit('.gitignore', '*.env\ndist/\n');
  deep.git('push', '-q', '-u', 'origin', 'main');
  const lib = gitRepo(f.s.root, 'acme-lib-sub', 'main');
  lib.commit('.gitignore', '*.env\ndist/\n');
  sub(lib.work, 'submodule', 'add', '-q', deep.origin, 'deep');
  lib.git('commit', '-q', '-m', 'deep');
  lib.git('push', '-q', '-u', 'origin', 'main');
  const api = f.repos['acme-api'];
  sub(api.work, 'submodule', 'add', '-q', lib.origin, 'lib');
  api.git('commit', '-q', '-m', 'lib');
  api.git('push', '-q', 'origin', 'main');
  if (disposable) {
    const c = JSON.parse(readFileSync(join(f.s.bollplank, 'config.json'), 'utf8'));
    c.projects['acme-shop'].repos['acme-api'].disposable = disposable;
    f.s.config(c);
  }
  f.ticket('create', 'acme-shop', ticketId, '--slug', 'x', '--change', 'acme-api');
  const wt = join(f.folder(ticketId), 'acme-api');
  return { ...f, lib, deep, wt, libDir: join(wt, 'lib'), deepDir: join(wt, 'lib', 'deep'), init: () => sub(wt, 'submodule', 'update', '-q', '--init', '--recursive') };
}
const remove = (f, id, ...extra) => f.ticket('remove', 'acme-shop', id, ...extra);
// A depth 1 clone of lib. A plain path ignores --depth, so the url is file://.
function shallowInit(f) {
  sub(f.wt, 'submodule', 'init', 'lib');
  g(f.wt, 'config', 'submodule.lib.url', `file://${f.lib.origin}`);
  sub(f.wt, 'submodule', 'update', '-q', '--depth', '1', 'lib');
  assert.equal(g(f.libDir, 'rev-parse', '--is-shallow-repository'), 'true');
}

test('remove lists ignored files inside a submodule from the repo root and deletes them only with --force-ignored', (t) => {
  const f = withSubmodules(t, 'ACME-20');
  f.init();
  writeFileSync(join(f.libDir, 'acme.env'), 'ACME_SETTING=1\n');
  let r = remove(f, 'ACME-20');
  assert.equal(r.status, 1, r.stdout);
  assert.deepEqual(r.json.ignored, { 'acme-api': ['lib/acme.env'] });
  assert.ok(existsSync(join(f.libDir, 'acme.env')));
  r = remove(f, 'ACME-20', '--force-ignored');
  assert.equal(r.status, 0, r.stdout);
  assert.equal(existsSync(f.wt), false);
});

test('remove refuses a stash in a submodule, also with --force-ignored', (t) => {
  const f = withSubmodules(t, 'ACME-21');
  f.init();
  writeFileSync(join(f.libDir, '.gitignore'), '*.env\ndist/\nmore\n');
  g(f.libDir, 'stash', '-q');
  for (const extra of [[], ['--force-ignored']]) {
    const r = remove(f, 'ACME-21', ...extra);
    assert.equal(r.status, 1, r.stdout);
    assert.deepEqual(r.json.refusals, ['acme-api: lib: a stash that removal would delete']);
  }
  assert.ok(existsSync(f.libDir));
});

test('remove refuses submodule commits on no remote, on a side branch or on the commit the pushed repo records', (t) => {
  const f = withSubmodules(t, 'ACME-22');
  f.init();
  const recorded = g(f.libDir, 'rev-parse', 'HEAD');
  g(f.libDir, 'checkout', '-q', '-b', 'side');
  writeFileSync(join(f.libDir, 'side.txt'), 'side\n');
  g(f.libDir, 'add', 'side.txt');
  g(f.libDir, 'commit', '-q', '-m', 'side');
  g(f.libDir, 'checkout', '-q', '--detach', recorded);
  let r = remove(f, 'ACME-22');
  assert.equal(r.status, 1, r.stdout);
  assert.deepEqual(r.json.refusals, ['acme-api: lib: 1 commits on no remote of the submodule']);
  g(f.libDir, 'branch', '-q', '-D', 'side');
  // A commit the repo records and pushes, which the submodule itself never pushed.
  writeFileSync(join(f.libDir, 'fix.txt'), 'fix\n');
  g(f.libDir, 'add', 'fix.txt');
  g(f.libDir, 'commit', '-q', '-m', 'fix');
  g(f.wt, 'add', 'lib');
  g(f.wt, 'commit', '-q', '-m', 'lib fix');
  g(f.wt, 'push', '-q', 'origin', 'HEAD:main');
  r = remove(f, 'ACME-22');
  assert.equal(r.status, 1, r.stdout);
  assert.deepEqual(r.json.refusals, ['acme-api: lib: 1 commits on no remote of the submodule']);
  sub(f.libDir, 'push', '-q', 'origin', 'HEAD:main');
  r = remove(f, 'ACME-22');
  assert.equal(r.status, 0, r.stdout);
});

test('remove names the submodule for an untracked file or a local commit in it', (t) => {
  const f = withSubmodules(t, 'ACME-23');
  f.init();
  writeFileSync(join(f.libDir, 'draft.md'), 'work\n');
  let r = remove(f, 'ACME-23');
  assert.equal(r.status, 1, r.stdout);
  assert.deepEqual(r.json.refusals, ['acme-api: lib: uncommitted or untracked changes']);
  g(f.libDir, 'add', 'draft.md');
  g(f.libDir, 'commit', '-q', '-m', 'draft');
  r = remove(f, 'ACME-23');
  assert.equal(r.status, 1, r.stdout);
  assert.deepEqual(r.json.refusals, ['acme-api: lib: 1 commits on no remote of the submodule', 'acme-api: lib: checkout is not the commit acme-api records']);
});

test('remove checks a nested submodule the same way', (t) => {
  const f = withSubmodules(t, 'ACME-24');
  f.init();
  writeFileSync(join(f.deepDir, 'acme.env'), 'ACME_SETTING=1\n');
  writeFileSync(join(f.deepDir, '.gitignore'), '*.env\ndist/\nmore\n');
  g(f.deepDir, 'stash', '-q');
  const r = remove(f, 'ACME-24');
  assert.equal(r.status, 1, r.stdout);
  assert.deepEqual(r.json.ignored, { 'acme-api': ['lib/deep/acme.env'] });
  assert.ok(r.json.refusals.includes('acme-api: lib/deep: a stash that removal would delete'), r.stdout);
});

test('remove checks the git folder a deinitialized submodule leaves, and keeps it on a refusal', (t) => {
  const f = withSubmodules(t, 'ACME-25');
  f.init();
  const recorded = g(f.libDir, 'rev-parse', 'HEAD');
  writeFileSync(join(f.libDir, '.gitignore'), '*.env\ndist/\nmore\n');
  g(f.libDir, 'stash', '-q');
  g(f.libDir, 'checkout', '-q', '-b', 'side');
  writeFileSync(join(f.libDir, 'side.txt'), 'side\n');
  g(f.libDir, 'add', 'side.txt');
  g(f.libDir, 'commit', '-q', '-m', 'side');
  g(f.libDir, 'checkout', '-q', '--detach', recorded);
  g(f.wt, 'submodule', 'deinit', '-q', '-f', 'lib');
  const modules = join(g(f.wt, 'rev-parse', '--absolute-git-dir'), 'modules', 'lib');
  const r = remove(f, 'ACME-25');
  assert.equal(r.status, 1, r.stdout);
  assert.deepEqual(r.json.refusals, ['acme-api: lib (no checkout): a stash that removal would delete', 'acme-api: lib (no checkout): 1 commits on no remote of the submodule']);
  assert.ok(g(f.wt, `--git-dir=${modules}`, 'rev-parse', '--verify', '--quiet', 'refs/stash'));
  assert.ok(g(f.wt, `--git-dir=${modules}`, 'rev-parse', '--verify', '--quiet', 'refs/heads/side'));
});

test('remove refuses a submodule commit whose only remote branch was deleted on the remote', (t) => {
  const f = withSubmodules(t, 'ACME-26');
  f.init();
  const recorded = g(f.libDir, 'rev-parse', 'HEAD');
  g(f.libDir, 'checkout', '-q', '-b', 'topic');
  writeFileSync(join(f.libDir, 'topic.txt'), 'topic\n');
  g(f.libDir, 'add', 'topic.txt');
  g(f.libDir, 'commit', '-q', '-m', 'topic');
  g(f.libDir, 'push', '-q', 'origin', 'topic');
  g(f.libDir, 'checkout', '-q', '--detach', recorded);
  // While origin/topic exists the commit has a copy, so only an ignored file, there to keep the
  // worktree, refuses.
  writeFileSync(join(f.libDir, 'acme.env'), 'ACME_SETTING=1\n');
  let r = remove(f, 'ACME-26');
  assert.equal(r.status, 1, r.stdout);
  assert.deepEqual(r.json.ignored, { 'acme-api': ['lib/acme.env'] });
  assert.deepEqual(r.json.refusals.filter((x) => /commits/.test(x)), []);
  rmSync(join(f.libDir, 'acme.env'));
  // The branch is deleted on the remote. A fetch without pruning would keep origin/topic.
  execFileSync('git', ['--git-dir', f.lib.origin, 'branch', '-q', '-D', 'topic']);
  r = remove(f, 'ACME-26');
  assert.equal(r.status, 1, r.stdout);
  assert.deepEqual(r.json.refusals, ['acme-api: lib: 1 commits on no remote of the submodule']);
});

test('remove deletes disposable paths inside a submodule, matched from the repo root', (t) => {
  const f = withSubmodules(t, 'ACME-27', ['lib/dist/']);
  f.init();
  mkdirSync(join(f.libDir, 'dist'));
  writeFileSync(join(f.libDir, 'dist', 'out.js'), 'out\n');
  const r = remove(f, 'ACME-27');
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(r.json.disposable, { 'acme-api': ['lib/dist/'] });
  assert.equal(existsSync(f.wt), false);
});

test('remove with a submodule that was never initialized gives the same output as before', (t) => {
  const f = withSubmodules(t, 'ACME-28');
  const r = remove(f, 'ACME-28');
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(Object.keys(r.json).sort(), ['folder', 'folderRemoved', 'ok', 'removed', 'ticket']);
});

test('remove refuses changes in an embedded repo that has no .gitmodules entry', (t) => {
  const f = setup(t);
  f.ticket('create', 'acme-shop', 'ACME-29', '--slug', 'x', '--change', 'acme-api');
  const wt = join(f.folder('ACME-29'), 'acme-api');
  const tools = join(wt, 'tools');
  mkdirSync(tools);
  g(tools, 'init', '-q');
  writeFileSync(join(tools, 'a.txt'), 'a\n');
  g(tools, 'add', 'a.txt');
  g(tools, 'commit', '-q', '-m', 'a');
  g(wt, 'add', 'tools');
  g(wt, 'commit', '-q', '-m', 'tools');
  g(wt, 'push', '-q', 'origin', 'HEAD:main');
  writeFileSync(join(tools, 'a.txt'), 'edited\n');
  const r = remove(f, 'ACME-29');
  assert.equal(r.status, 1, r.stdout);
  assert.deepEqual(r.json.refusals, ['acme-api: tools: uncommitted or untracked changes', 'acme-api: tools: 1 commits on no remote of the submodule']);
  assert.ok(existsSync(join(tools, 'a.txt')));
});

test('remove counts a staged new submodule as the repo\'s own change', (t) => {
  const f = withSubmodules(t, 'ACME-30');
  sub(f.wt, 'submodule', 'add', '-q', f.deep.origin, 'extra');
  const r = remove(f, 'ACME-30');
  assert.equal(r.status, 1, r.stdout);
  assert.deepEqual(r.json.refusals, ['acme-api: uncommitted or untracked changes']);
});

test('remove refuses when a submodule check cannot run', (t) => {
  const f = withSubmodules(t, 'ACME-31');
  f.init();
  g(f.libDir, 'remote', 'set-url', 'origin', join(f.s.root, 'gone.git'));
  const r = remove(f, 'ACME-31');
  assert.equal(r.status, 1, r.stdout);
  assert.equal(r.json.refusals.length, 1, r.stdout);
  assert.match(r.json.refusals[0], /^acme-api: lib: could not check the submodule: /);
  assert.ok(existsSync(f.libDir));
});

test('remove checks the git folder of an embedded repo that has no .gitmodules entry', (t) => {
  const f = setup(t);
  const lib = gitRepo(f.s.root, 'acme-emb', 'main');
  lib.commit('a.txt', 'a\n');
  lib.git('push', '-q', '-u', 'origin', 'main');
  f.ticket('create', 'acme-shop', 'ACME-32', '--slug', 'x', '--change', 'acme-api');
  const wt = join(f.folder('ACME-32'), 'acme-api');
  g(wt, 'clone', '-q', lib.origin, 'emb');
  g(wt, 'add', 'emb');
  g(wt, 'commit', '-q', '-m', 'emb');
  g(wt, 'push', '-q', 'origin', 'HEAD:main');
  writeFileSync(join(wt, 'emb', 'a.txt'), 'edited\n');
  g(join(wt, 'emb'), 'stash', '-q');
  const r = remove(f, 'ACME-32');
  assert.equal(r.status, 1, r.stdout);
  assert.deepEqual(r.json.refusals, ['acme-api: emb: a stash that removal would delete']);
});

test('remove counts a shallow submodule\'s boundary and a commit on a remote tag as on the remote', (t) => {
  const f = withSubmodules(t, 'ACME-33');
  // lib's remote moves one commit past what acme-api records, and that commit is only on tag v1.
  const recorded = f.lib.git('rev-parse', 'HEAD');
  f.lib.commit('next.txt', 'next\n');
  f.lib.git('push', '-q', 'origin', 'main');
  shallowInit(f);
  assert.equal(g(f.libDir, 'rev-parse', 'HEAD'), recorded);
  writeFileSync(join(f.libDir, 'acme.env'), 'ACME_SETTING=1\n');
  let r = remove(f, 'ACME-33');
  assert.deepEqual(r.json.refusals.filter((x) => /commits/.test(x)), [], r.stdout);
  rmSync(join(f.libDir, 'acme.env'));
  // A tag-only commit the submodule checks out.
  g(f.libDir, 'checkout', '-q', '--detach');
  writeFileSync(join(f.libDir, 'rel.txt'), 'rel\n');
  g(f.libDir, 'add', 'rel.txt');
  g(f.libDir, 'commit', '-q', '-m', 'release');
  r = remove(f, 'ACME-33');
  assert.ok(r.json.refusals.includes('acme-api: lib: 1 commits on no remote of the submodule'), r.stdout);
  g(f.libDir, 'tag', 'v1');
  g(f.libDir, 'push', '-q', 'origin', 'v1');
  g(f.wt, 'add', 'lib');
  g(f.wt, 'commit', '-q', '-m', 'lib v1');
  g(f.wt, 'push', '-q', 'origin', 'HEAD:main');
  r = remove(f, 'ACME-33');
  assert.equal(r.status, 0, r.stdout);
});

test('remove refuses a submodule that has linked worktrees of its own', (t) => {
  const f = withSubmodules(t, 'ACME-34');
  f.init();
  g(f.libDir, 'worktree', 'add', '-q', '--detach', join(f.s.root, 'lib-side'));
  const r = remove(f, 'ACME-34');
  assert.equal(r.status, 1, r.stdout);
  assert.deepEqual(r.json.refusals, ['acme-api: lib: has linked worktrees that removal would break']);
});

test('remove refuses a shallow boundary commit that upstream rewrote away', (t) => {
  const f = withSubmodules(t, 'ACME-35');
  shallowInit(f);
  // Upstream replaces main with a new history that does not hold the recorded commit.
  f.lib.git('checkout', '-q', '--orphan', 'fresh');
  f.lib.commit('fresh.txt', 'fresh\n');
  f.lib.git('push', '-q', '-f', 'origin', 'fresh:main');
  const r = remove(f, 'ACME-35');
  assert.equal(r.status, 1, r.stdout);
  assert.equal(r.json.refusals.length, 1, r.stdout);
  assert.match(r.json.refusals[0], /^acme-api: lib: (\d+ commits on no remote of the submodule|could not check the submodule: )/);
  assert.ok(existsSync(f.libDir));
});

test('remove refuses commits only a stale remote branch outside a narrowed fetch refspec holds', (t) => {
  const f = withSubmodules(t, 'ACME-36');
  f.init();
  const recorded = g(f.libDir, 'rev-parse', 'HEAD');
  g(f.libDir, 'checkout', '-q', '-b', 'topic');
  writeFileSync(join(f.libDir, 'topic.txt'), 'topic\n');
  g(f.libDir, 'add', 'topic.txt');
  g(f.libDir, 'commit', '-q', '-m', 'topic');
  g(f.libDir, 'push', '-q', 'origin', 'topic');
  g(f.libDir, 'checkout', '-q', '--detach', recorded);
  g(f.libDir, 'config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main');
  execFileSync('git', ['--git-dir', f.lib.origin, 'branch', '-q', '-D', 'topic']);
  const r = remove(f, 'ACME-36');
  assert.equal(r.status, 1, r.stdout);
  assert.ok(g(f.libDir, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/topic'));
  assert.deepEqual(r.json.refusals, ['acme-api: lib: 1 commits on no remote of the submodule']);
});

test('remove refuses a deinitialized submodule git folder that git cannot read', (t) => {
  const f = withSubmodules(t, 'ACME-37');
  f.init();
  g(f.libDir, 'checkout', '-q', '-b', 'side');
  writeFileSync(join(f.libDir, 'side.txt'), 'side\n');
  g(f.libDir, 'add', 'side.txt');
  g(f.libDir, 'commit', '-q', '-m', 'side');
  g(f.wt, 'submodule', 'deinit', '-q', '-f', 'lib');
  const modules = join(g(f.wt, 'rev-parse', '--absolute-git-dir'), 'modules', 'lib');
  rmSync(join(modules, 'HEAD'));
  const r = remove(f, 'ACME-37');
  assert.equal(r.status, 1, r.stdout);
  assert.ok(r.json.refusals.some((x) => x.startsWith('acme-api: lib (no checkout): could not check the submodule: ')), r.stdout);
  assert.ok(existsSync(join(modules, 'refs', 'heads', 'side')));
});

test('remove tells names with slashes from git storage, such as vendor/config and vendor/objects/lib', (t) => {
  const f = withSubmodules(t, 'ACME-38');
  const names = { 'vendor/config': 'vc', 'vendor/objects/lib': 'vo', 'vendor/refs/lib': 'vr' };
  for (const [name, path] of Object.entries(names)) sub(f.wt, 'submodule', 'add', '-q', '--name', name, f.deep.origin, path);
  g(f.wt, 'commit', '-q', '-m', 'vendor');
  g(f.wt, 'push', '-q', 'origin', 'HEAD:main');
  const modules = join(g(f.wt, 'rev-parse', '--absolute-git-dir'), 'modules');
  for (const name of Object.keys(names)) assert.ok(existsSync(join(modules, ...name.split('/'), 'HEAD')), name);
  let r = remove(f, 'ACME-38');
  assert.equal(r.status, 0, r.stdout);
  // The same submodules deinitialized in a new ticket.
  f.ticket('create', 'acme-shop', 'ACME-39', '--slug', 'x', '--change', 'acme-api');
  const wt = join(f.folder('ACME-39'), 'acme-api');
  sub(wt, 'submodule', 'update', '-q', '--init', ...Object.values(names));
  g(wt, 'submodule', 'deinit', '-q', '-f', ...Object.values(names));
  r = remove(f, 'ACME-39');
  assert.equal(r.status, 0, r.stdout);
});

test('a path that cannot be resolved refuses rather than skipping a submodule check', (t) => {
  const s = sandbox();
  t.after(s.clean);
  const app = gitRepo(s.root, 'acme-app', 'main');
  app.commit('README.md', 'app\n');
  const emb = join(app.work, 'emb');
  mkdirSync(emb);
  g(emb, 'init', '-q');
  writeFileSync(join(emb, 'a.txt'), 'a\n');
  g(emb, 'add', 'a.txt');
  g(emb, 'commit', '-q', '-m', 'a');
  app.git('add', 'emb');
  app.git('commit', '-q', '-m', 'emb');
  writeFileSync(join(emb, 'a.txt'), 'edited\n');
  g(emb, 'stash', '-q');
  const embGit = realpathSync.native(join(emb, '.git'));
  assert.ok(submoduleChecks('acme-app', app.work).refusals.includes('acme-app: emb: a stash that removal would delete'));
  // Resolving the worktree fails while the git folder inside it resolves, or the other way round.
  for (const failing of [realpathSync.native(app.work), embGit]) {
    const realpath = (p) => {
      const r = realpathSync.native(p);
      if (r === failing) throw new Error(`cannot resolve ${p}`);
      return r;
    };
    const { refusals } = submoduleChecks('acme-app', app.work, realpath);
    assert.deepEqual(refusals, ['acme-app: could not list its submodules: cannot resolve ' + (failing === embGit ? g(emb, 'rev-parse', '--absolute-git-dir') : app.work)]);
  }
});
