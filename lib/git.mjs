import { execFileSync } from 'node:child_process';

// Small git helpers shared by ticket, merge and deploy-wait. Every call names its folder with -C,
// so nothing depends on the working folder Bollplank was started from.
export function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 }).trim();
}

// The same call, returning null when git fails instead of throwing.
export function tryGit(dir, ...args) {
  try {
    return git(dir, ...args);
  } catch {
    return null;
  }
}

// The first line git or another program wrote to stderr, for a failure detail.
export function firstLine(e) {
  return String(e?.stderr || e?.message || e).trim().split('\n')[0];
}

// The branch a repo's work starts from and merges into: the configured baseBranch, else the
// remote's default branch (origin/HEAD) in the checkout, else master.
export function baseBranch(repoConfig, checkout) {
  if (repoConfig?.baseBranch) return repoConfig.baseBranch;
  const head = checkout ? tryGit(checkout, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD') : null;
  if (head?.startsWith('origin/')) return head.slice('origin/'.length);
  return 'master';
}

// Ticket ids are capital letters, a dash and a number. Anything else could leave the tickets folder.
export function ticketId(arg) {
  const t = typeof arg === 'string' ? arg.toUpperCase() : '';
  return /^[A-Z][A-Z0-9]*-[0-9]+$/.test(t) ? t : null;
}
