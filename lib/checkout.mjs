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
    } catch (e) {
      rmSync(to, { recursive: true, force: true });
      // A clone stopped by a signal, such as Ctrl-C, is a stop, not a reason to copy everything.
      if (e.signal) throw e;
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

// The commit's full id when it is on origin/<base>, else null. A branch or tag whose name looks like
// the id does not count: the id found must start with the id given.
function onBase(src, commit, base) {
  const full = tryGit(src, 'rev-parse', '--verify', '--quiet', `${commit}^{commit}`);
  if (!full || !full.toLowerCase().startsWith(commit.toLowerCase())) return null;
  return tryGit(src, 'merge-base', '--is-ancestor', full, `origin/${base}`) === null ? null : full;
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Checks that the commit is on origin/<base>, fetching origin first when it is not there yet, and
// adds a detached worktree of it in a new temporary folder. Two calls on one repo can fetch at
// once, and one then fails to lock a ref, so a failed fetch is tried twice more. No prune runs:
// a call never touches a worktree entry it did not make. Hooks are off for the add, so the
// checkout is the commit and nothing else.
export function makeCheckout({ src, repo, commit, base }) {
  let full = onBase(src, commit, base);
  if (!full) {
    let fetchError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) pause(1000);
      try {
        execFileSync('git', ['-C', src, 'fetch', '--quiet', 'origin'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
        fetchError = null;
        break;
      } catch (e) {
        fetchError = e;
      }
    }
    full = onBase(src, commit, base);
    if (!full && fetchError) throw new CheckoutError('commit-missing', `git fetch origin failed: ${fetchError.signal ? 'it did not finish in 120 seconds' : firstLine(fetchError)}`);
    if (!full) throw new CheckoutError('commit-missing', `${commit} is not on origin/${base}, so it is not a merge commit of ${repo}`);
  }
  const dir = mkdtempSync(`${prefix()}${repo.replace(/[^A-Za-z0-9._-]/g, '_')}-`);
  try {
    git(src, '-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--quiet', '--detach', dir, full);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw new CheckoutError('checkout-failed', `git worktree add failed: ${firstLine(e)}`);
  }
  return { dir, full };
}

// Removes the checkout this call made, by the path makeCheckout returned and nothing else. When
// git refuses, the folder goes only when it is under the deploy prefix, and its worktree entry
// stays until git gc expires it. Returns null when git removed the checkout, or else what went
// wrong, even when the folder itself is gone, since a worktree entry is then left behind.
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
  if (existsSync(dir)) return problem ?? `${dir} is still there`;
  return problem ? `${problem}. The folder was deleted, and its worktree entry is left for git worktree prune` : null;
}
