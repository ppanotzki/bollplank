import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { paths } from './paths.mjs';

// The private name check. The names come from $BOLLPLANK_PRIVATE_NAMES or the local list, never
// from the repo, since listing them in a public repo would publish them. A plain line matches
// anywhere, ignoring case. A line starting with "re:" is a case sensitive regular expression.
// Results name the pattern by its number and never echo the name, because check logs can be public.
// A pattern that is not a valid regular expression is reported by its number in `invalid`.
export function loadPatterns(env = process.env, file = paths().privateNames) {
  let text = env.BOLLPLANK_PRIVATE_NAMES;
  let source = 'BOLLPLANK_PRIVATE_NAMES';
  if (!text || !text.trim()) {
    if (!existsSync(file)) return null;
    text = readFileSync(file, 'utf8');
    source = file;
  }
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const invalid = [];
  const patterns = lines.map((l, i) => {
    try {
      return l.startsWith('re:') ? new RegExp(l.slice(3)) : new RegExp(l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    } catch {
      invalid.push(i + 1);
      return null;
    }
  });
  if (!patterns.length) return null;
  return invalid.length ? { source, patterns, invalid } : { source, patterns };
}

const NO_LIST = 'no private names list: set BOLLPLANK_PRIVATE_NAMES or write ~/.bollplank/private-names.txt';

// A list with an invalid pattern fails, since that name would go unchecked.
function load(env, listFile) {
  const loaded = loadPatterns(env, listFile);
  if (!loaded) return { result: { outcome: 'skipped', reason: NO_LIST } };
  if (loaded.invalid) return { result: { outcome: 'failed', source: loaded.source, reason: loaded.invalid.map((n) => `pattern ${n} is not a valid regular expression`).join('. ') } };
  return { loaded };
}

const matches = (loaded, line) => loaded.patterns.flatMap((p, i) => (p.test(line) ? [i + 1] : []));

// Scan loose text, such as a pull request's title and body before a squash merge writes them into
// history. Returns the same outcomes as scan(), with hits naming only the pattern and the label.
export function scanText(texts, env = process.env, listFile = paths().privateNames) {
  const { result, loaded } = load(env, listFile);
  if (result) return result;
  const hits = [];
  for (const [label, text] of Object.entries(texts)) {
    for (const line of String(text ?? '').split('\n')) for (const pattern of matches(loaded, line)) hits.push({ pattern, where: label });
  }
  return hits.length ? { outcome: 'failed', source: loaded.source, hits } : { outcome: 'passed', source: loaded.source, patterns: loaded.patterns.length };
}

// Scan a commit and its whole history: every file version, binary and merge changes included,
// every commit message whole, and every author and committer line. A shallow repository fails,
// since part of its history cannot be read. outcome is passed, failed or skipped. Only passed may
// let a gate or a merge through. A hit names its file only when the path itself matches nothing.
export function scan(repo, rev = 'HEAD', env = process.env, listFile = paths().privateNames) {
  const { result, loaded } = load(env, listFile);
  if (result) return result;
  // Replace refs and grafts could hide history, and local config could change how paths and diffs print.
  const git = (...args) => execFileSync('git', ['--no-replace-objects', '-C', repo, '-c', 'core.quotePath=false', '-c', 'color.ui=never', ...args], { encoding: 'utf8', maxBuffer: 1 << 30 });
  if (git('rev-parse', '--is-shallow-repository').trim() === 'true') return { outcome: 'failed', source: loaded.source, reason: 'the repository is a shallow clone, so part of its history cannot be scanned. Fetch the full history first.' };
  const hits = [];
  const hit = (line, commit, file) => {
    for (const pattern of matches(loaded, line)) hits.push({ pattern, commit, file: file === null || !matches(loaded, file).length ? file : '(path withheld)' });
  };

  // Messages, authors and committers, one NUL separated record per commit, scanned line by line.
  for (const record of git('log', '-z', '--format=%H%nauthor %an <%ae>%ncommitter %cn <%ce>%n%B', rev).split('\0')) {
    if (!record.trim()) continue;
    const commit = record.slice(0, 12);
    for (const line of record.split('\n')) hit(line, commit, null);
  }

  // Every change as text, against each parent of a merge. Each commit starts with a \x01 line,
  // which no diff line can start with. A removed line only repeats content caught where it was added.
  const diffs = git('log', '-p', '-m', '--text', '--no-textconv', '--no-ext-diff', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', '--format=%x01%H', rev);
  let commit = null;
  let file = null;
  let header = false;
  for (const line of diffs.split('\n')) {
    if (line.startsWith('\x01')) {
      commit = line.slice(1, 13);
      file = null;
      header = false;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      header = true;
      file = line.slice(line.lastIndexOf(' b/') + 3);
    } else if (header && line.startsWith('+++ b/')) file = line.slice(6);
    else if (header && line.startsWith('@@')) header = false;
    if (!header && line.startsWith('-')) continue;
    hit(line, commit, file);
  }
  return hits.length ? { outcome: 'failed', source: loaded.source, hits } : { outcome: 'passed', source: loaded.source, patterns: loaded.patterns.length };
}
