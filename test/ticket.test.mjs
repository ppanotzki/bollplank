import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, gitRepo, acmeConfig, isWindows } from './helpers.mjs';

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
