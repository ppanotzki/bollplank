// A repo's disposable patterns: the ignored paths `ticket remove` deletes without asking, such as
// build output. A pattern is matched against the path from the repo root. * is any run of
// characters but /, and ** is a whole folder name that stands for zero or more folders. A trailing
// / names a folder only, and a pattern without one names a file or a folder. Every other
// character is literal, and the characters other glob dialects give a meaning are refused.

const REFUSED = /[?[\]{}!\\]/;

// What is wrong with one pattern, or null when it is usable.
export function disposableProblem(pattern) {
  if (typeof pattern !== 'string' || pattern.trim() === '') return 'must be a pattern, not empty';
  if (pattern !== pattern.trim()) return 'must not start or end with a space';
  if (pattern.startsWith('/') || pattern.startsWith('~')) return 'must be relative to the repo root';
  if (REFUSED.test(pattern)) return 'only * and ** are wildcards, so ? [ ] { } ! and \\ are refused';
  const segments = pattern.replace(/\/$/, '').split('/');
  if (segments.some((s) => s === '')) return 'must not hold an empty folder name';
  if (segments.some((s) => s === '.' || s === '..')) return 'must not hold a . or .. folder';
  if (segments.some((s) => s.includes('**') && s !== '**')) return '** must be a whole folder name, as in **/x or x/**';
  if (segments.every((s) => s === '*' || s === '**')) return 'matches whole folders of anything, so name the build output instead';
  return null;
}

function compile(pattern) {
  const folderOnly = pattern.endsWith('/');
  const segments = pattern.replace(/\/$/, '').split('/');
  let re = '';
  segments.forEach((s, i) => {
    const last = i === segments.length - 1;
    if (s === '**') {
      // Zero or more folders before the next name, or anything at all at the end.
      re += last ? '.+' : '(?:.+/)?';
      return;
    }
    re += s.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('[^/]*');
    if (!last) re += '/';
  });
  // The s flag lets a wildcard cross a line break too, which a Git file name may hold.
  return { re: new RegExp(`^${re}$`, 's'), folderOnly };
}

// A function that says whether one entry of `git status --porcelain --ignored` is disposable. A
// folder entry ends in /. An entry is disposable when it, or a folder it is in, matches a pattern.
// So a folder git reports as one entry is disposable only when that folder or a parent matches,
// never because of a file it holds. Call it only with patterns that validation accepted.
export function disposableMatcher(patterns = []) {
  const compiled = patterns.map(compile);
  const matches = (name, isFolder) => compiled.some((c) => (isFolder || !c.folderOnly) && c.re.test(name));
  return (entry) => {
    const isFolder = entry.endsWith('/');
    const parts = entry.replace(/\/$/, '').split('/');
    if (matches(parts.join('/'), isFolder)) return true;
    for (let i = 1; i < parts.length; i++) if (matches(parts.slice(0, i).join('/'), true)) return true;
    return false;
  };
}
