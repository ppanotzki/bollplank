import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { paths } from './paths.mjs';

// The private name check. The names come from $BOLLPLANK_PRIVATE_NAMES or the local list, never
// from the repo, since listing them in a public repo would publish them. A plain line matches
// anywhere, ignoring case. A line starting with "re:" is a case sensitive regular expression.
// Results name the pattern by its number and never echo the name, because check logs can be public.
export function loadPatterns(env = process.env, file = paths().privateNames) {
  let text = env.BOLLPLANK_PRIVATE_NAMES;
  let source = 'BOLLPLANK_PRIVATE_NAMES';
  if (!text || !text.trim()) {
    if (!existsSync(file)) return null;
    text = readFileSync(file, 'utf8');
    source = file;
  }
  const patterns = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => (l.startsWith('re:') ? new RegExp(l.slice(3)) : new RegExp(l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')));
  return patterns.length ? { source, patterns } : null;
}

// Scan a commit and its whole history: every file version, commit message and author line.
// outcome is passed, failed or skipped. Only passed may let a gate or a merge through.
export function scan(repo, rev = 'HEAD', env = process.env, listFile = paths().privateNames) {
  const loaded = loadPatterns(env, listFile);
  if (!loaded) return { outcome: 'skipped', reason: 'no private names list: set BOLLPLANK_PRIVATE_NAMES or write ~/.bollplank/private-names.txt' };
  const log = execFileSync('git', ['-C', repo, 'log', '-p', '--format=commit %H%nauthor %an <%ae>%n%B', rev], { encoding: 'utf8', maxBuffer: 1 << 30 });
  const hits = [];
  let commit = null;
  let file = null;
  for (const line of log.split('\n')) {
    if (line.startsWith('commit ')) {
      commit = line.slice(7, 19);
      file = null;
    } else if (line.startsWith('+++ b/')) file = line.slice(6);
    // A removed line only repeats content that was caught where it was added.
    if (line.startsWith('-')) continue;
    loaded.patterns.forEach((p, i) => {
      if (p.test(line)) hits.push({ pattern: i + 1, commit, file });
    });
  }
  return hits.length ? { outcome: 'failed', source: loaded.source, hits } : { outcome: 'passed', source: loaded.source, patterns: loaded.patterns.length };
}
