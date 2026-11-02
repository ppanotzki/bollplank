// bollplank ticket create|refresh|status|remove <project> <TICKET>
// A ticket folder holds one worktree per repo, side by side, so sibling paths between repos
// resolve inside the ticket.
//
//   create  --slug <slug> --change repo,repo [--validate repo,repo]
//   refresh fetch every repo and move validation only checkouts to the base branch
//   status  head and changed files per repo
//   remove  refuses anything that could lose work
//
// A repo the ticket changes gets branch <ticket>-<slug>. A repo used only for validation is a
// detached checkout of origin/<base branch>. Repos named in validatesAgainst are added on their
// own. node_modules is cloned (cp -c on macOS) or copied, never linked, and only for repos with
// cloneNodeModules. The folder record is .ticket.json. The run record (.run.json) decides removal
// after a squash merge, because squashed commits never become ancestors of the base branch.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../args.mjs';
import { loadConfig, loadProject } from '../config.mjs';
import { emit, Exit, fail } from '../out.mjs';
import { baseBranch, firstLine, git, ticketId, tryGit } from '../git.mjs';

export const usage = 'bollplank ticket create|refresh|status|remove <project> <TICKET> [--slug <slug> --change repo,repo] [--validate repo,repo]';

const spec = { slug: 'value', change: 'list', validate: 'list' };

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
    remove(ctx);
  } catch (e) {
    if (e instanceof Exit) throw e;
    fail('git-failed', firstLine(e));
  }
}

function readRecord({ recordPath, folder, ticket }) {
  if (!existsSync(recordPath)) fail('no-ticket-folder', `no ticket folder for ${ticket} at ${folder}`);
  return JSON.parse(readFileSync(recordPath, 'utf8'));
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
    writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n');
  } catch (e) {
    const rolledBack = rollback(made, branch, folder, folderExisted);
    fail('create-failed', `${firstLine(e)}. Worktrees made before the failure were removed.`, { rolledBack });
  }
  emit({ ok: true, ticket, folder, branch, repos: report });
}

// node_modules is ignored by git, so a worktree starts without it. An APFS clone costs no space.
// Elsewhere, or when the clone fails, Node copies it and keeps links as they are.
function copyNodeModules(src, dest) {
  const from = join(src, 'node_modules');
  const to = join(dest, 'node_modules');
  if (!existsSync(from)) return null;
  if (process.platform === 'darwin') {
    try {
      execFileSync('cp', ['-c', '-R', from, to], { stdio: ['ignore', 'pipe', 'pipe'] });
      return 'cloned';
    } catch {
      rmSync(to, { recursive: true, force: true });
    }
  }
  cpSync(from, to, { recursive: true, verbatimSymlinks: true });
  return 'copied';
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

function remove(ctx) {
  const { project, ticket, folder } = ctx;
  const record = readRecord(ctx);
  const runPath = join(folder, '.run.json');
  const runRecord = existsSync(runPath) ? JSON.parse(readFileSync(runPath, 'utf8')) : null;
  const refusals = [];
  for (const [repo, info] of Object.entries(record.repos)) {
    const dest = join(folder, repo);
    if (!existsSync(dest)) continue;
    // Untracked files count too. Ignored files such as node_modules do not.
    if (git(dest, 'status', '--porcelain')) {
      refusals.push(`${repo}: uncommitted or untracked changes`);
      continue;
    }
    const base = info.baseBranch ?? baseBranch(project.repos[repo], dest);
    git(dest, 'fetch', '--quiet', 'origin');
    const head = git(dest, 'rev-parse', 'HEAD');
    const unlanded = Number(git(dest, 'rev-list', '--count', `origin/${base}..HEAD`));
    if (unlanded === 0) continue;
    const pr = runRecord?.repos?.[repo];
    if (pr?.merged && pr.finalHead === head) continue;
    if (pr?.merged) refusals.push(`${repo}: commits after the merged head ${pr.finalHead?.slice(0, 7)}`);
    else refusals.push(`${repo}: ${unlanded} commits not on ${base} and no merged PR in the run record`);
  }
  if (refusals.length) fail('refused', `not removing ${ticket}`, { refusals });
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
