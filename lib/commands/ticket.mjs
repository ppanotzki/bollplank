// bollplank ticket create|refresh|status|remove <project> <TICKET>
// A ticket folder holds one worktree per repo, side by side, so sibling paths between repos
// resolve inside the ticket.
//
//   create  --slug <slug> --change repo,repo [--validate repo,repo]
//   refresh fetch every repo and move validation only checkouts to the base branch
//   status  head and changed files per repo
//   remove  [--force-ignored] refuses anything that could lose work: changes, untracked files,
//           ignored files other than node_modules (unless --force-ignored), and commits on the
//           worktree or on the ticket branch that are not on origin/<base> and not the merged head
//
// A repo the ticket changes gets branch <ticket>-<slug>. A repo used only for validation is a
// detached checkout of origin/<base branch>. Repos named in validatesAgainst are added on their
// own. node_modules is cloned (cp -c on macOS) or copied, never linked, and only for repos with
// cloneNodeModules. The folder record is .ticket.json. The run record (.run.json) decides removal
// after a squash merge, because squashed commits never become ancestors of the base branch.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../args.mjs';
import { loadConfig, loadProject } from '../config.mjs';
import { writeJsonAtomic } from '../fsx.mjs';
import { emit, Exit, fail } from '../out.mjs';
import { baseBranch, firstLine, git, ticketId, tryGit } from '../git.mjs';
import { copyNodeModules } from '../checkout.mjs';

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
  for (const [repo, info] of Object.entries(record.repos)) {
    const src = join(project.source, repo);
    const dest = join(folder, repo);
    const present = existsSync(dest);
    if (present) {
      // Untracked files count too. Ignored files other than node_modules count unless forced.
      if (git(dest, 'status', '--porcelain')) {
        refusals.push(`${repo}: uncommitted or untracked changes`);
        continue;
      }
      const files = ignoredFiles(dest);
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
  emit({ ok: true, ticket, folder, removed, folderRemoved });
}

// The ignored files and folders in a worktree, other than node_modules, which a create copies in
// and a remove may delete.
function ignoredFiles(dir) {
  return git(dir, 'status', '--porcelain', '-z', '--ignored')
    .split('\0')
    .filter((e) => e.startsWith('!! '))
    .map((e) => e.slice(3))
    .filter((p) => p && !p.split('/').includes('node_modules'));
}
