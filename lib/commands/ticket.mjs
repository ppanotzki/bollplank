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
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync } from 'node:fs';
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
      // --ignore-submodules=dirty leaves a submodule's content to its own checks, whatever the
      // ignore settings say, and still reports a submodule whose checkout is not the recorded commit.
      const own = [];
      for (const path of statusPaths(dest)) {
        if (subs.top.has(path)) refusals.push(`${repo}: ${path}: checkout is not the commit ${repo} records`);
        else own.push(path);
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

// The paths git status reports in a checkout, with submodule content left to the submodule's own
// checks. Read without trimming, since a first entry such as " M lib" starts with a space.
function statusPaths(dir) {
  const out = execFileSync('git', ['-C', dir, 'status', '--porcelain', '-z', '--untracked-files=normal', '--ignore-submodules=dirty'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
  return out.split('\0').filter(Boolean).map((e) => (/^[ MTADRCU?!]{2} /.test(e) ? e.slice(3) : e));
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
  let checkouts;
  let gitDir;
  try {
    gitDir = real(git(dest, 'rev-parse', '--absolute-git-dir'));
    if (!existsSync(join(dest, '.gitmodules')) && !existsSync(join(gitDir, 'modules'))) return { refusals, ignored, top };
    const out = git(dest, 'submodule', 'foreach', '--recursive', '--quiet', 'printf "%s\\0%s\\0" "$displaypath" "$(git rev-parse --absolute-git-dir)"');
    const parts = out.split('\0');
    checkouts = [];
    for (let i = 0; i + 1 < parts.length; i += 2) checkouts.push({ path: parts[i], gitDir: real(parts[i + 1]) });
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
      for (const p of statusPaths(dir)) {
        if (children.has(p)) refusals.push(`${repo}: ${c.path}/${p}: checkout is not the commit ${c.path} records`);
        else changed = true;
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
  const walk = (modules, owner, prefix) => {
    let entries;
    try {
      entries = readdirSync(modules, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = join(modules, e.name);
      const name = prefix ? `${prefix}/${e.name}` : e.name;
      if (existsSync(join(dir, 'HEAD')) && existsSync(join(dir, 'objects'))) {
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
      if (tryGit(dest, ...where, 'rev-parse', '--verify', '--quiet', 'refs/stash')) refusals.push(`${repo}: ${label}: a stash that removal would delete`);
      // Pruned, so a remote branch deleted on the remote no longer counts as a copy.
      g('fetch', '--quiet', '--prune', '--all', '--no-recurse-submodules');
      const tips = g('for-each-ref', '--format=%(objectname)', 'refs/heads').split('\n').filter(Boolean);
      const head = tryGit(dest, ...where, 'rev-parse', '--verify', '--quiet', 'HEAD');
      if (head) tips.push(head);
      const unpushed = tips.length ? Number(g('rev-list', '--count', ...new Set(tips), '--not', '--remotes')) : 0;
      if (unpushed > 0) refusals.push(`${repo}: ${label}: ${unpushed} commits on no remote of the submodule`);
    } catch (e) {
      refusals.push(`${repo}: ${label}: could not check the submodule: ${firstLine(e)}`);
    }
  }
  return { refusals, ignored, top };
}
