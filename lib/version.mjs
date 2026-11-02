import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { kitDir } from './paths.mjs';

// The Workflow line every brief and comment carries, for example "Bollplank 0.1.0, build 12".
// The version is package.json's and equals the release tag. The build is the number of commits on
// the repo's base branch, which grows by one per squash merge. A copy with commits not on that
// branch, or with local changes, says so, since it then matches no build.
export function workflowLine(kit = kitDir) {
  const git = (...args) => execFileSync('git', ['-C', kit, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let version = 'unknown';
  try {
    version = JSON.parse(readFileSync(join(kit, 'package.json'), 'utf8')).version ?? 'unknown';
  } catch {}
  try {
    const head = git('rev-parse', 'HEAD');
    let base = head;
    for (const ref of [remoteDefault(git), 'origin/master', 'origin/main']) {
      if (!ref) continue;
      try {
        base = git('merge-base', 'HEAD', ref);
        break;
      } catch {}
    }
    let line = `Bollplank ${version}, build ${git('rev-list', '--count', base)}`;
    if (base !== head) line += ' plus unmerged commits';
    if (git('status', '--porcelain')) line += ', with uncommitted changes';
    return line;
  } catch {
    return `Bollplank ${version}, build unknown`;
  }
}

function remoteDefault(git) {
  try {
    return git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
  } catch {
    return null;
  }
}
