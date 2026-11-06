// Would a push of one commit start a GitHub Actions workflow? GitHub starts no run, and records no
// skipped run, for a push its branch or path filters exclude. deploy-wait asks this before it waits
// for a run that may never come.
//
// The answer is runs, does-not-run or unknown. Unknown is the safe answer: deploy-wait then waits as
// it always has. So every shape this file does not read with certainty gives unknown, never a guess.
// No I/O here, so the reader and the matcher are tested on their own.

// The events that cannot start a run on the merge commit by themselves. A person can still start
// workflow_dispatch, but that run is not a deploy of the merge.
const QUIET_EVENTS = new Set(['push', 'workflow_dispatch']);
const PUSH_KEYS = ['branches', 'branches-ignore', 'tags', 'tags-ignore', 'paths', 'paths-ignore'];
// GitHub checks only the first 300 changed files of a push.
export const MAX_FILES = 300;

class Unknown extends Error {}
const unknown = (reason) => {
  throw new Unknown(reason);
};

// One scalar: plain, 'single' or "double" quoted. A comment after it is dropped. Anything YAML
// could read as more than a string (an anchor, an alias, a tag, a block scalar or a flow map) is
// unknown.
function scalar(raw) {
  const s = raw.trim();
  if (s.startsWith("'")) {
    const m = s.match(/^'((?:[^']|'')*)'\s*(?:#.*)?$/);
    if (!m) unknown(`cannot read ${s}`);
    return m[1].replaceAll("''", "'");
  }
  if (s.startsWith('"')) {
    const m = s.match(/^"((?:[^"\\]|\\["\\/])*)"\s*(?:#.*)?$/);
    if (!m) unknown(`cannot read ${s}`);
    return m[1].replace(/\\(["\\/])/g, '$1');
  }
  const plain = s.replace(/\s+#.*$/, '').trim();
  if (!plain || /^[&*!|>{[%@`]/.test(plain) || /^-(\s|$)/.test(plain) || /:(\s|$)/.test(plain)) unknown(`cannot read ${s}`);
  return plain;
}

// A flow list, such as [push, 'a b', "c"]. Items hold no comma, bracket or brace.
function flowList(raw) {
  const m = raw.trim().match(/^\[(.*)\]\s*(?:#.*)?$/);
  if (!m) unknown(`cannot read ${raw.trim()}`);
  if (!m[1].trim()) return [];
  const items = m[1].split(',');
  // YAML allows one comma after the last item.
  if (items.length > 1 && !items[items.length - 1].trim()) items.pop();
  if (items.some((i) => /[[\]{}]/.test(i))) unknown(`cannot read ${raw.trim()}`);
  return items.map((i) => {
    if (!i.trim()) unknown(`cannot read ${raw.trim()}`);
    return scalar(i);
  });
}

const isNull = (v) => ['', 'null', '~', '{}', 'Null', 'NULL'].includes(v.replace(/(^|\s+)#.*$/, '').replace(/^\{\s*\}$/, '{}').trim());
const indentOf = (line) => line.match(/^ */)[0].length;
const content = (line) => line.trim() !== '' && !line.trim().startsWith('#');

// The key of a "key: value" line, quoted or plain, and the rest after the colon.
function keyLine(text) {
  const m = text.match(/^(?:'([^']*)'|"([^"]*)"|([^\s'"#:][^:#]*?))\s*:(?:\s+(.*)|)$/);
  if (!m) return null;
  return { key: m[1] ?? m[2] ?? m[3], rest: m[4] ?? '' };
}

// The lines under the line at index i that are indented more than indent, or that are list items
// at the same indent, as YAML allows for a list under a key.
function childLines(lines, i, indent, listAtSameIndent) {
  const out = [];
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    if (!content(l)) continue;
    const n = indentOf(l);
    if (n > indent || (listAtSameIndent && n === indent && /^ *-(\s|$)/.test(l))) out.push(l);
    else break;
  }
  return out;
}

// A list given as a flow list on the key's line or as "- item" lines under it.
function listValue(rest, children) {
  if (rest.trim() && !rest.trim().startsWith('#')) {
    if (children.length) unknown('a value and lines under it');
    return rest.trim().startsWith('[') ? flowList(rest) : [scalar(rest)];
  }
  if (!children.length) unknown('an empty list');
  const indent = indentOf(children[0]);
  return children.map((l) => {
    const m = l.match(/^( *)-\s+(.*)$/);
    if (!m || m[1].length !== indent) unknown('a list item this reader cannot follow');
    return scalar(m[2]);
  });
}

// Reads the top level on key of a workflow file. Returns { events, push } where push is null when
// the push event has no filters, or { unknown: reason }.
export function readPushTrigger(text) {
  try {
    if (typeof text !== 'string') unknown('no workflow text');
    if (text.includes('\t')) unknown('the workflow has tabs');
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    // A second YAML document would be a second workflow, which GitHub does not read either.
    // Comments and one --- may come before the content.
    const sep = (l) => /^(---|\.\.\.)(\s|$)/.test(l);
    const first = lines.findIndex((l) => content(l) && !sep(l));
    if (first >= 0 && lines.some((l, i) => i > first && sep(l) && lines.slice(i + 1).some(content))) unknown('more than one YAML document');
    let at = -1;
    lines.forEach((l, i) => {
      if (indentOf(l) !== 0 || !content(l)) return;
      const k = keyLine(l);
      if (k?.key === 'on') {
        if (at >= 0) unknown('the on key is there twice');
        at = i;
      }
    });
    if (at < 0) unknown('no on key');
    const { rest } = keyLine(lines[at]);
    const children = childLines(lines, at, 0, true);
    if (rest.trim() && !rest.trim().startsWith('#')) {
      if (children.length) unknown('the on key has a value and lines under it');
      const events = rest.trim().startsWith('[') ? flowList(rest) : [scalar(rest)];
      return { events, push: null };
    }
    if (!children.length) unknown('the on key is empty');
    // A list of events, or a map of events.
    if (/^ *-(\s|$)/.test(children[0])) return { events: listValue('', children), push: null };
    const indent = indentOf(children[0]);
    const events = [];
    let push = null;
    for (let i = at + 1; i < lines.length; i++) {
      const l = lines[i];
      if (!content(l)) continue;
      const n = indentOf(l);
      if (n === 0) break;
      if (n > indent) continue;
      if (n < indent) unknown('the on key is indented unevenly');
      const k = keyLine(l.slice(n));
      if (!k) unknown(`cannot read ${l.trim()}`);
      if (events.includes(k.key)) unknown(`${k.key} is there twice`);
      events.push(k.key);
      if (k.key !== 'push') continue;
      const under = childLines(lines, i, n, false);
      if (!isNull(k.rest)) unknown('push has a value this reader cannot follow');
      if (!under.length) continue;
      push = {};
      const pIndent = indentOf(under[0]);
      for (let j = i + 1; j < lines.length; j++) {
        const pl = lines[j];
        if (!content(pl)) continue;
        const pn = indentOf(pl);
        if (pn <= n) break;
        if (pn > pIndent || (pn === pIndent && /^ *-(\s|$)/.test(pl))) continue;
        if (pn < pIndent) unknown('push is indented unevenly');
        const pk = keyLine(pl.slice(pn));
        if (!pk || !PUSH_KEYS.includes(pk.key)) unknown(`push has ${pk?.key ?? pl.trim()}, which this reader does not know`);
        if (Object.hasOwn(push, pk.key)) unknown(`push has ${pk.key} twice`);
        push[pk.key] = listValue(pk.rest, childLines(lines, j, pn, true));
      }
    }
    return { events, push };
  } catch (e) {
    if (e instanceof Unknown) return { unknown: e.message };
    throw e;
  }
}

// GitHub's filter pattern syntax as a regular expression, or null for anything outside it.
// * is any run of characters but /, ** any run at all, and **/ zero or more folders. ? and + are
// zero or one, and one or more, of the character before. [...] is one character of letters,
// digits and ranges. \ escapes the next character.
export function globToRegExp(pattern) {
  if (typeof pattern !== 'string' || !pattern) return null;
  // A path GitHub might read another way: from the root, from the current folder, or as a folder.
  if (/^\.?\//.test(pattern) || pattern.endsWith('/') || pattern.includes('//')) return null;
  let re = '';
  let atom = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') {
          // **/ is zero or more folders only where a folder name starts.
          if (i > 1 && pattern[i - 2] !== '/') return null;
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
      atom = false;
    } else if (c === '?' || c === '+') {
      if (!atom) return null;
      re += c;
      atom = false;
    } else if (c === '[') {
      const end = pattern.indexOf(']', i + 1);
      const body = end < 0 ? '' : pattern.slice(i + 1, end);
      if (!/^(?:[A-Za-z0-9](?:-[A-Za-z0-9])?)+$/.test(body)) return null;
      re += `[${body}]`;
      i = end;
      atom = true;
    } else if (c === '\\') {
      if (i + 1 >= pattern.length) return null;
      i++;
      re += pattern[i].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      atom = true;
    } else {
      // Only plain characters are literals. Braces, parentheses and the like may mean something
      // to GitHub, so they give null rather than a guess.
      if (!/[A-Za-z0-9._\-/~ ]/.test(c)) return null;
      re += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      atom = true;
    }
  }
  // The s flag lets ** cross a line break too, which a Git file name may hold.
  return new RegExp(`^${re}$`, 's');
}

// The last matching pattern wins, and a pattern starting with ! excludes. Returns true, false, or
// throws Unknown for a list it cannot use.
function matchList(patterns, value) {
  const compiled = patterns.map((p) => {
    const negative = p.startsWith('!');
    const re = globToRegExp(negative ? p.slice(1) : p);
    if (!re) unknown(`the pattern ${p} is outside the syntax this reader knows`);
    return { negative, re };
  });
  if (compiled.every((c) => c.negative)) unknown('a filter with only ! patterns');
  let matched = false;
  for (const c of compiled) if (c.re.test(value)) matched = !c.negative;
  return matched;
}

// Decides from the trigger, the branch the commit was pushed to (null when not known for sure) and
// the commit's changed files (null when not known). Each is only needed with its filter, so a
// caller may pass a function that fetches it, and that may throw Unknown.
export function decide({ trigger, baseBranch, files }) {
  try {
    if (!trigger || trigger.unknown) unknown(trigger?.unknown ?? 'no trigger');
    const others = trigger.events.filter((e) => !QUIET_EVENTS.has(e));
    if (others.length) unknown(`the workflow also runs on ${others.join(', ')}`);
    if (!trigger.events.includes('push')) unknown('the workflow has no push trigger');
    const p = trigger.push;
    if (!p) return { answer: 'runs', reason: 'the push trigger has no filter' };
    if (p.tags || p['tags-ignore']) unknown('the push trigger has a tag filter');
    if (p.branches && p['branches-ignore']) unknown('the push trigger has both branches and branches-ignore');
    if (p.paths && p['paths-ignore']) unknown('the push trigger has both paths and paths-ignore');
    if (p.branches || p['branches-ignore']) {
      const base = typeof baseBranch === 'function' ? baseBranch() : baseBranch;
      if (!base) unknown('the base branch is not known, so the branch filter cannot be checked');
      // A pattern naming the full ref is a form this reader does not follow.
      if ([...(p.branches ?? []), ...(p['branches-ignore'] ?? [])].some((x) => x.replace(/^!/, '').startsWith('refs/'))) unknown('a branch pattern names a full ref');
      if (p.branches && !matchList(p.branches, base)) return { answer: 'does-not-run', reason: `the branch filter excludes ${base}` };
      if (p['branches-ignore']) {
        if (p['branches-ignore'].some((x) => x.startsWith('!'))) unknown('branches-ignore with a ! pattern');
        if (matchList(p['branches-ignore'], base)) return { answer: 'does-not-run', reason: `branches-ignore excludes ${base}` };
      }
    }
    if (!p.paths && !p['paths-ignore']) return { answer: 'runs', reason: 'the push trigger has no path filter' };
    const list = typeof files === 'function' ? files() : files;
    if (!Array.isArray(list)) unknown('the changed files are not known');
    if (!list.length) unknown('the commit changes no file');
    if (list.length > MAX_FILES) unknown(`the commit changes more than ${MAX_FILES} files`);
    if (p.paths) {
      const hit = list.find((f) => matchList(p.paths, f));
      return hit ? { answer: 'runs', reason: `${hit} matches paths` } : { answer: 'does-not-run', reason: 'no changed file matches paths' };
    }
    if (p['paths-ignore'].some((x) => x.startsWith('!'))) unknown('paths-ignore with a ! pattern');
    const kept = list.find((f) => !matchList(p['paths-ignore'], f));
    return kept ? { answer: 'runs', reason: `${kept} is not in paths-ignore` } : { answer: 'does-not-run', reason: 'every changed file matches paths-ignore' };
  } catch (e) {
    if (e instanceof Unknown) return { answer: 'unknown', reason: e.message };
    throw e;
  }
}

export { Unknown };
