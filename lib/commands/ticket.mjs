// bollplank ticket create|refresh|status|remove <project> <TICKET>
// A ticket folder holds one worktree per repo, side by side, so sibling paths between repos
// resolve inside the ticket.
//
//   create  --slug <slug> --change repo,repo [--validate repo,repo]
//   refresh fetch every repo and move validation only checkouts to the base branch
//   status  head and changed files per repo
//   remove  [--force-ignored] refuses anything that could lose work: changes, untracked files,
//           ignored files other than node_modules and the repo's disposable paths (unless
//           --force-ignored), and commits on the worktree or on the ticket branch that are not on
//           origin/<base> and not the merged head. Inside every submodule git folder the worktree
//           holds, also one a deinit left without a checkout, it refuses the same files, a stash,
//           and commits on no remote of the submodule after a pruning fetch
//
// A repo the ticket changes gets branch <ticket>-<slug>. A repo used only for validation is a
// detached checkout of origin/<base branch>. Repos named in validatesAgainst are added on their
// own. node_modules is cloned (cp -c on macOS) or copied, never linked, and only for repos with
// cloneNodeModules. The folder record is .ticket.json. The run record (.run.json) decides removal
// after a squash merge, because squashed commits never become ancestors of the base branch.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { parse } from '../args.mjs';
import { loadConfig, loadProject } from '../config.mjs';
import { writeJsonAtomic } from '../fsx.mjs';
import { emit, Exit, fail } from '../out.mjs';
import { baseBranch, firstLine, git, ticketId, tryGit } from '../git.mjs';
import { copyNodeModules } from '../checkout.mjs';
import { disposableMatcher } from '../disposable.mjs';

export const usage = 'bollplank ticket create|refresh|status|remove <project> <TICKET> [--slug <slug> --change repo,repo] [--validate repo,repo] [--force-ignored]';

const spec = { slug: 'value', change: 'list', validate: 'list', 'force-ignored': 'bool' };

export function run(argv) {
  const { opts, positional, error } = parse(argv, spec);
  const [cmd, projectName, ticketArg, ...extra] = positional ?? [];
  if (error || !cmd || !projectName || !ticketArg || extra.length) fail('usage', error ?? usage);
  if (!['create', 'refresh', 'status', 'remove'].includes(cmd)) fail('usage', `unknown ticket command ${cmd}. ${usage}`);
  const ticket = ticketId(ticketArg);
  if (!ticket) fail('usage', `${ticketArg} is not a ticket id like ACME-1`);
  const project = loadProject(loadConfig(), projectName);
  if (project.mode !== 'repository') fail('usage', `${projectName} is a ${project.mode} project, which has no ticket worktrees`);
  const folder = join(project.tickets, ticket);
  const ctx = { project, ticket, folder, recordPath: join(folder, '.ticket.json') };
  try {
    if (cmd === 'create') create(ctx, opts);
    if (cmd === 'refresh') refresh(ctx);
    if (cmd === 'status') status(ctx);
    remove(ctx, opts);
  } catch (e) {
    if (e instanceof Exit) throw e;
    fail('git-failed', firstLine(e));
  }
}

function readRecord({ recordPath, folder, ticket }) {
  if (!existsSync(recordPath)) fail('no-ticket-folder', `no ticket folder for ${ticket} at ${folder}`);
  const r = readJson(recordPath);
  if (!r || typeof r !== 'object' || typeof r.repos !== 'object' || r.repos === null) fail('corrupt', `${recordPath} does not hold a ticket folder record`, { file: recordPath });
  return r;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    fail('corrupt', `${file} is not valid JSON: ${e.message}. Fix it by hand before removing or refreshing the ticket.`, { file });
  }
}

function create({ project, ticket, folder, recordPath }, opts) {
  if (existsSync(recordPath)) fail('exists', `${ticket} already has a ticket folder at ${folder}`);
  const slug = (opts.slug ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!slug) fail('usage', '--slug is required');
  const change = opts.change ?? [];
  if (!change.length) fail('usage', '--change needs at least one repo');
  const validate = new Set(opts.validate ?? []);
  for (const r of change) for (const dep of project.validatesAgainst?.[r] ?? []) validate.add(dep);
  for (const r of change) validate.delete(r);
  const all = [...change, ...validate];
  const unknown = all.filter((r) => !Object.hasOwn(project.repos, r));
  if (unknown.length) fail('usage', `unknown repo ${unknown.join(', ')} in ${project.name}`);

  const branch = `${ticket.toLowerCase()}-${slug}`;
  const folderExisted = existsSync(folder);
  mkdirSync(folder, { recursive: true });
  const record = { project: project.name, ticket, branch, created: new Date().toISOString(), repos: {} };
  const made = [];
  const report = {};
  try {
    for (const repo of all) {
      const src = join(project.source, repo);
      const dest = join(folder, repo);
      const kind = change.includes(repo) ? 'change' : 'validate';
      git(src, 'fetch', '--quiet', 'origin');
      const baseName = baseBranch(project.repos[repo], src);
      const base = git(src, 'rev-parse', `origin/${baseName}`);
      if (kind === 'change') git(src, 'worktree', 'add', '--quiet', '-b', branch, dest, `origin/${baseName}`);
      else git(src, 'worktree', 'add', '--quiet', '--detach', dest, `origin/${baseName}`);
      made.push({ repo, src, dest, kind });
      const nodeModules = project.repos[repo].cloneNodeModules ? copyNodeModules(src, dest) : null;
      record.repos[repo] = { kind, base, baseBranch: baseName };
      report[repo] = { kind, base, baseBranch: baseName, ...(kind === 'change' ? { branch } : {}), nodeModules };
    }
    writeJsonAtomic(recordPath, record);
  } catch (e) {
    const rolledBack = rollback(made, branch, folder, folderExisted);
    fail('create-failed', `${firstLine(e)}. Worktrees made before the failure were removed.`, { rolledBack });
  }
  emit({ ok: true, ticket, folder, branch, repos: report });
}

function rollback(made, branch, folder, folderExisted) {
  const done = [];
  for (const { repo, src, dest, kind } of made.reverse()) {
    tryGit(src, 'worktree', 'remove', '--force', dest);
    if (kind === 'change') tryGit(src, 'branch', '-D', branch);
    done.push(repo);
  }
  if (!folderExisted && existsSync(folder) && readdirSync(folder).length === 0) rmdirSync(folder);
  return done;
}

function refresh(ctx) {
  const record = readRecord(ctx);
  const entries = Object.entries(record.repos).map(([repo, info]) => ({ repo, info, dest: join(ctx.folder, repo), base: info.baseBranch ?? baseBranch(ctx.project.repos[repo], join(ctx.folder, repo)) }));
  // Check every validation checkout before moving any, so a refusal leaves nothing half done.
  const dirty = entries.filter((e) => e.info.kind === 'validate' && git(e.dest, 'status', '--porcelain', '--untracked-files=no'));
  if (dirty.length) fail('refused', `validation only checkouts with local changes: ${dirty.map((e) => e.repo).join(', ')}`);
  const repos = {};
  for (const { repo, info, dest, base } of entries) {
    git(dest, 'fetch', '--quiet', 'origin');
    if (info.kind === 'validate') {
      git(dest, 'checkout', '--quiet', '--detach', `origin/${base}`);
      repos[repo] = { kind: 'validate', baseBranch: base, head: git(dest, 'rev-parse', 'HEAD') };
    } else {
      repos[repo] = { kind: 'change', baseBranch: base, head: git(dest, 'rev-parse', 'HEAD'), behind: Number(git(dest, 'rev-list', '--count', `HEAD..origin/${base}`)) };
    }
  }
  emit({ ok: true, ticket: ctx.ticket, folder: ctx.folder, repos });
}

function status(ctx) {
  const record = readRecord(ctx);
  const repos = {};
  for (const [repo, info] of Object.entries(record.repos)) {
    const dest = join(ctx.folder, repo);
    if (!existsSync(dest)) {
      repos[repo] = { kind: info.kind, exists: false };
      continue;
    }
    const changedFiles = git(dest, 'status', '--porcelain').split('\n').filter(Boolean).length;
    repos[repo] = { kind: info.kind, exists: true, head: git(dest, 'rev-parse', 'HEAD'), changedFiles };
  }
  emit({ ok: true, ticket: ctx.ticket, folder: ctx.folder, branch: record.branch, repos });
}

function remove(ctx, opts) {
  const { project, ticket, folder } = ctx;
  const record = readRecord(ctx);
  const runPath = join(folder, '.run.json');
  const runRecord = existsSync(runPath) ? readJson(runPath) : null;
  const refusals = [];
  const ignored = {};
  const disposable = {};
  for (const [repo, info] of Object.entries(record.repos)) {
    const src = join(project.source, repo);
    const dest = join(folder, repo);
    const present = existsSync(dest);
    if (present) {
      // Git shows little of what is inside a submodule, so each one is checked on its own first.
      const subs = submoduleChecks(repo, dest);
      refusals.push(...subs.refusals);
      // Untracked files count too. Ignored files other than node_modules and the repo's
      // disposable paths count unless forced.
      // --untracked-files=normal, since status.showUntrackedFiles=no would hide untracked work.
      const own = [];
      for (const e of statusEntries(dest)) {
        const kind = submoduleEntry(e, subs.top);
        if (kind === 'moved') refusals.push(`${repo}: ${e.path}: checkout is not the commit ${repo} records`);
        else if (kind !== 'content') own.push(e.path);
      }
      if (own.length) {
        refusals.push(`${repo}: uncommitted or untracked changes`);
        continue;
      }
      const isDisposable = disposableMatcher(project.repos[repo]?.disposable);
      const all = [...ignoredFiles(dest), ...subs.ignored];
      const files = all.filter((p) => !isDisposable(p));
      const gone = all.filter(isDisposable);
      if (gone.length) disposable[repo] = gone;
      if (files.length && !opts['force-ignored']) {
        ignored[repo] = files;
        refusals.push(`${repo}: ignored files that removal would delete: ${files.slice(0, 20).join(', ')}${files.length > 20 ? ` and ${files.length - 20} more` : ''}. Move them away, or pass --force-ignored to delete them.`);
      }
    }
    const base = info.baseBranch ?? baseBranch(project.repos[repo], present ? dest : src);
    git(src, 'fetch', '--quiet', 'origin');
    // The worktree's HEAD and the ticket branch itself, which outlives a missing worktree folder.
    const tips = new Map();
    if (present) tips.set(git(dest, 'rev-parse', 'HEAD'), '');
    const branchTip = info.kind === 'change' ? tryGit(src, 'rev-parse', '--verify', '--quiet', `refs/heads/${record.branch}`) : null;
    if (branchTip && !tips.has(branchTip)) tips.set(branchTip, ` branch ${record.branch}`);
    const pr = runRecord?.repos?.[repo];
    for (const [tip, label] of tips) {
      const unlanded = Number(git(src, 'rev-list', '--count', `origin/${base}..${tip}`));
      if (unlanded === 0) continue;
      if (pr?.merged && typeof pr.finalHead === 'string' && pr.finalHead.toLowerCase() === tip.toLowerCase()) continue;
      if (pr?.merged) refusals.push(`${repo}${label}: commits after the merged head ${pr.finalHead?.slice(0, 7)}`);
      else refusals.push(`${repo}${label}: ${unlanded} commits not on ${base} and no merged PR in the run record`);
    }
  }
  if (refusals.length) fail('refused', `not removing ${ticket}`, { refusals, ...(Object.keys(ignored).length ? { ignored } : {}) });
  const removed = [];
  for (const [repo, info] of Object.entries(record.repos)) {
    const src = join(project.source, repo);
    const dest = join(folder, repo);
    // node_modules is untracked, so worktree remove needs --force once the checks above passed.
    if (existsSync(dest)) git(src, 'worktree', 'remove', '--force', dest);
    else tryGit(src, 'worktree', 'prune');
    if (info.kind === 'change' && tryGit(src, 'rev-parse', '--verify', '--quiet', `refs/heads/${record.branch}`)) git(src, 'branch', '-D', record.branch);
    removed.push(repo);
  }
  for (const f of ['.ticket.json', '.run.json']) rmSync(join(folder, f), { force: true });
  const folderRemoved = existsSync(folder) && readdirSync(folder).length === 0;
  if (folderRemoved) rmdirSync(folder);
  emit({ ok: true, ticket, folder, removed, folderRemoved, ...(Object.keys(disposable).length ? { disposable } : {}) });
}

// The ignored files and folders in a worktree, other than node_modules, which a create copies in
// and a remove may delete.
function ignoredFiles(dir) {
  return git(dir, 'status', '--porcelain', '-z', '--untracked-files=normal', '--ignored')
    .split('\0')
    .filter((e) => e.startsWith('!! '))
    .map((e) => e.slice(3))
    .filter((p) => p && !p.split('/').includes('node_modules'));
}

// What git status reports in a checkout, as { path, index, sub }. index is the staged status
// letter, or '.' for none. sub is git's submodule state: 'N...' for a plain path, or 'S' and
// whether the commit changed (C), tracked content changed (M) and untracked files exist (U).
// --ignore-submodules=none, so no ignore setting hides a submodule or an embedded repo.
// --untracked-files=normal, since status.showUntrackedFiles=no would hide untracked work.
function statusEntries(dir) {
  const parts = git(dir, 'status', '--porcelain=v2', '-z', '--untracked-files=normal', '--ignore-submodules=none').split('\0');
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e) continue;
    const f = e.split(' ');
    if (e[0] === '1') entries.push({ path: f.slice(8).join(' '), index: f[1][0], sub: f[2] });
    else if (e[0] === '2') {
      entries.push({ path: f.slice(9).join(' '), index: f[1][0], sub: f[2] });
      i++; // The original path of a rename or copy follows as its own entry.
    } else if (e[0] === 'u') entries.push({ path: f.slice(10).join(' '), index: 'U', sub: f[2] });
    else entries.push({ path: e.slice(2), index: '?', sub: 'N...' });
  }
  return entries;
}

// How a status entry for a checked out submodule whose checks cover it counts: 'moved' when its
// checkout is not the recorded commit, 'content' when only its content changed, which its own
// checks report. Anything else, a staged change included, is the checkout's own change (null).
function submoduleEntry(e, covered) {
  if (!covered.has(e.path) || e.index !== '.' || !e.sub.startsWith('S')) return null;
  return e.sub[1] === 'C' ? 'moved' : 'content';
}

// Every submodule of a worktree that removal would lose work in, nested ones included. A checked
// out submodule gets the same checks as the repo: changes, untracked and ignored files. Every git
// folder removal deletes, also one a deinit left without a checkout, gets the stash and commit
// checks. A check that cannot run refuses, so remove never deletes on doubt.
// Returns { refusals, ignored (paths from the worktree root), top (top level checkout paths) }.
function submoduleChecks(repo, dest) {
  const refusals = [];
  const ignored = [];
  const top = new Set();
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const checkouts = [];
  let gitDir;
  // Every gitlink in the index whose folder holds a checkout, nested ones included. The index,
  // not .gitmodules, so an embedded repo someone added without a .gitmodules entry counts too.
  const discover = (dir, prefix) => {
    const seen = new Set();
    for (const entry of git(dir, 'ls-files', '--stage', '-z').split('\0')) {
      if (!entry.startsWith('160000 ')) continue;
      const p = entry.slice(entry.indexOf('\t') + 1);
      const abs = join(dir, p);
      if (seen.has(p) || !existsSync(join(abs, '.git'))) continue;
      seen.add(p);
      checkouts.push({ path: prefix + p, gitDir: real(git(abs, 'rev-parse', '--absolute-git-dir')) });
      discover(abs, `${prefix}${p}/`);
    }
  };
  try {
    gitDir = real(git(dest, 'rev-parse', '--absolute-git-dir'));
    discover(dest, '');
  } catch (e) {
    refusals.push(`${repo}: could not list its submodules: ${firstLine(e)}`);
    return { refusals, ignored, top };
  }
  const area = [gitDir, real(dest)];
  const inArea = (p) => area.some((a) => p === a || p.startsWith(a + sep));
  const byGitDir = new Map(checkouts.map((c) => [c.gitDir, c]));
  const paths = new Set(checkouts.map((c) => c.path));

  for (const c of checkouts) {
    if (![...paths].some((p) => c.path.startsWith(p + '/'))) top.add(c.path);
    const dir = join(dest, c.path);
    try {
      // Nested checked out submodules, whose recorded commit this checkout's status reports.
      const children = new Set([...paths].filter((p) => p.startsWith(c.path + '/')).map((p) => p.slice(c.path.length + 1)));
      let changed = false;
      for (const e of statusEntries(dir)) {
        const kind = submoduleEntry(e, children);
        if (kind === 'moved') refusals.push(`${repo}: ${c.path}/${e.path}: checkout is not the commit ${c.path} records`);
        else if (kind !== 'content') changed = true;
      }
      if (changed) refusals.push(`${repo}: ${c.path}: uncommitted or untracked changes`);
      for (const p of ignoredFiles(dir)) ignored.push(`${c.path}/${p}`);
    } catch (e) {
      refusals.push(`${repo}: ${c.path}: could not check the submodule: ${firstLine(e)}`);
    }
  }

  // Git folders under modules/ of the worktree and of each checked out submodule. A folder with a
  // HEAD file and an objects folder is a git folder. Any other is part of a name with slashes.
  const found = new Map();
  // The path a submodule name has in its owner's .gitmodules, or the name when there is none.
  const labelFor = (owner, name) => {
    const path = owner.checkout ? tryGit(owner.checkout, 'config', '-f', '.gitmodules', '--get', `submodule.${name}.path`) : null;
    return owner.path ? `${owner.path}/${path || name}` : path || name;
  };
  // A folder that holds any git storage counts as a git folder, also a damaged one, so its checks
  // run and refuse when git cannot read it. Storage is a HEAD, config or packed-refs file, or an
  // objects or refs folder that is not itself a git folder. A folder that is only part of a name
  // with slashes holds folders alone, such as vendor/ for a submodule named vendor/config.
  const isFile = (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  const hasStorageFile = (dir) => ['HEAD', 'config', 'packed-refs'].some((f) => isFile(join(dir, f)));
  const isGitFolder = (dir) => hasStorageFile(dir) || ['objects', 'refs'].some((f) => existsSync(join(dir, f)) && !isFile(join(dir, f)) && !hasStorageFile(join(dir, f)));
  const walk = (modules, owner, prefix) => {
    let entries;
    try {
      entries = readdirSync(modules, { withFileTypes: true });
    } catch (e) {
      if (e.code !== 'ENOENT') refusals.push(`${repo}: could not read ${modules}: ${e.message}`);
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = join(modules, e.name);
      const name = prefix ? `${prefix}/${e.name}` : e.name;
      if (isGitFolder(dir)) {
        const key = real(dir);
        if (found.has(key)) continue;
        const known = byGitDir.get(key);
        const path = known ? known.path : labelFor(owner, name);
        found.set(key, known ? path : `${path} (no checkout)`);
        walk(join(dir, 'modules'), { path, checkout: known ? join(dest, path) : null }, '');
      } else {
        walk(dir, owner, name);
      }
    }
  };
  walk(join(gitDir, 'modules'), { path: '', checkout: dest }, '');
  for (const c of checkouts) {
    if (found.has(c.gitDir)) continue;
    found.set(c.gitDir, c.path);
    walk(join(c.gitDir, 'modules'), { path: c.path, checkout: join(dest, c.path) }, '');
  }

  for (const [dir, label] of found) {
    if (!inArea(dir)) continue;
    // A git folder without a checkout can keep a core.worktree that points at a folder that is
    // gone, which git would chdir to. None of these commands reads a work tree.
    const where = [`--git-dir=${dir}`, ...(byGitDir.has(dir) ? [] : [`--work-tree=${dir}`])];
    const g = (...args) => git(dest, ...where, ...args);
    try {
      if (g('for-each-ref', '--format=%(refname)', 'refs/stash')) refusals.push(`${repo}: ${label}: a stash that removal would delete`);
      // Linked worktrees of the submodule itself lose their admin folder, and their HEAD with it.
      if (existsSync(join(dir, 'worktrees')) && readdirSync(join(dir, 'worktrees')).length) refusals.push(`${repo}: ${label}: has linked worktrees that removal would break`);
      // The fetch brings in what the remotes hold now. A shallow clone is completed, since its
      // boundary hides whether a commit is in a remote's history, and a boundary commit that is
      // in none stays a boundary and counts as on no remote.
      g('fetch', '--quiet', '--prune', '--all', '--no-recurse-submodules', ...(existsSync(join(dir, 'shallow')) ? ['--unshallow'] : []));
      const tips = g('for-each-ref', '--format=%(objectname)', 'refs/heads').split('\n').filter(Boolean);
      const head = tryGit(dest, ...where, 'rev-parse', '--verify', '--quiet', 'HEAD');
      if (head) tips.push(head);
      const copies = tips.length ? remoteCopies(dest, where) : [];
      const unpushed = tips.length ? Number(gitIn(dest, [...where, 'rev-list', '--count', '--stdin', ...new Set(tips)], copies.map((s) => `^${s}\n`).join(''))) : 0;
      if (unpushed > 0) refusals.push(`${repo}: ${label}: ${unpushed} commits on no remote of the submodule`);
    } catch (e) {
      refusals.push(`${repo}: ${label}: could not check the submodule: ${firstLine(e)}`);
    }
  }
  return { refusals, ignored, top };
}

// git with text on stdin, for lists too long for the command line.
function gitIn(dir, args, input) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 28 }).trim();
}

// The commits the remotes of a submodule git folder advertise now, on a branch or a tag, that the
// folder holds, so rev-list can exclude them and their history. Asked of each remote, not read
// from remote tracking refs, which a narrowed fetch refspec can leave stale after any prune.
function remoteCopies(dest, where) {
  const shas = new Set();
  for (const remote of git(dest, ...where, 'remote').split('\n').filter(Boolean)) {
    for (const line of git(dest, ...where, 'ls-remote', '--heads', '--tags', remote).split('\n')) {
      const sha = line.split('\t')[0];
      if (sha) shas.add(sha);
    }
  }
  if (!shas.size) return [];
  const types = gitIn(dest, [...where, 'cat-file', '--batch-check=%(objectname) %(objecttype)'], [...shas].join('\n') + '\n');
  return types.split('\n').filter((l) => l.endsWith(' commit')).map((l) => l.split(' ')[0]);
}
