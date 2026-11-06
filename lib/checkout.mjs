// Checkouts shared by ticket and deploy-wait: the node_modules copy a ticket worktree and a deploy
// checkout start with, and the clean, detached checkout of a merge commit a command deploy runs in.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { firstLine, git, tryGit } from './git.mjs';

// node_modules is ignored by git, so a worktree starts without it. An APFS clone costs no space.
// Elsewhere, or when the clone fails, Node copies it and keeps links as they are.
export function copyNodeModules(src, dest) {
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

export class CheckoutError extends Error {
  constructor(failure, detail) {
    super(detail);
    this.failure = failure;
    this.detail = detail;
  }
}

// Every deploy checkout lives in a folder of its own under this prefix.
const prefix = () => join(realpathSync(tmpdir()), 'bollplank-deploy-');

// Fetches origin in the repo's folder, checks that the commit is on origin/<base>, and adds a
// detached worktree of it in a new temporary folder. Only git worktree prune runs first, which
// drops entries whose folder is already gone and never touches a live checkout of another call.
// Hooks are switched off for the add, so the checkout is the commit and nothing else.
export function makeCheckout({ src, repo, commit, base }) {
  try {
    git(src, 'fetch', '--quiet', 'origin');
  } catch (e) {
    throw new CheckoutError('commit-missing', `git fetch origin failed: ${firstLine(e)}`);
  }
  const full = tryGit(src, 'rev-parse', '--verify', '--quiet', `${commit}^{commit}`);
  if (!full) throw new CheckoutError('commit-missing', `${commit} is not a commit in ${repo} after git fetch origin`);
  if (tryGit(src, 'merge-base', '--is-ancestor', full, `origin/${base}`) === null) {
    throw new CheckoutError('commit-missing', `${commit} is not on origin/${base}, so it is not a merge commit of ${repo}`);
  }
  tryGit(src, 'worktree', 'prune');
  const dir = mkdtempSync(`${prefix()}${repo.replace(/[^A-Za-z0-9._-]/g, '_')}-`);
  try {
    git(src, '-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--quiet', '--detach', dir, full);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    tryGit(src, 'worktree', 'prune');
    throw new CheckoutError('checkout-failed', `git worktree add failed: ${firstLine(e)}`);
  }
  return { dir, full };
}

// Removes the checkout this call made, by the path makeCheckout returned and nothing else. When
// git refuses, the folder goes only when it is under the deploy prefix. Returns null when the
// checkout is gone, or the reason it is not.
export function removeCheckout(src, dir) {
  let problem = null;
  try {
    git(src, 'worktree', 'remove', '--force', dir);
  } catch (e) {
    problem = `git worktree remove failed: ${firstLine(e)}`;
    if (dir.startsWith(prefix()) && !dir.slice(prefix().length).includes(sep)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  }
  tryGit(src, 'worktree', 'prune');
  return existsSync(dir) ? (problem ?? `${dir} is still there`) : null;
}
