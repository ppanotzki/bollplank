// What Jira does to text on the way through Atlassian's MCP server, checked against the v2 server on
// 11 November 2026 (NEO-198).
//
// A markdown readback returns every single newline as two trailing spaces and a newline (a hard
// break), writes "- " bullets as "* ", and adds a trailing newline. jiraCanonical undoes only those
// rewrites, on both sides of a compare, so nothing else can hide a change.
//
// A description that holds what markdown cannot represent comes back as HTML. htmlUnsupported reads
// that HTML and names what a markdown write would lose.

// Line endings as LF, trailing spaces and tabs off each line, the list marker at the start of a line
// ("*", "+" or "-" and a space, after any indent) as "- ", and trailing newlines off.
export function jiraCanonical(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, '').replace(/^([ \t]*)[*+-] /, '$1- '))
    .join('\n')
    .replace(/\n+$/, '');
}

// The first line, counted from 1, where the canonical texts differ, with both lines, or null when
// they are equal.
export function firstDifference(sent, got) {
  const a = jiraCanonical(sent).split('\n');
  const b = jiraCanonical(got).split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return { line: i + 1, sent: a[i] ?? null, got: b[i] ?? null };
  }
  return null;
}

// The HTML tags that markdown round trips on Jira, and the attributes each may carry. Everything else
// is refused, so a tag or attribute Atlassian adds later fails closed.
const TAGS = {
  p: [], br: [], h1: [], h2: [], h3: [], h4: [], h5: [], h6: [],
  ul: [], ol: ['start'], li: [], pre: ['data-unique-id'], code: ['class'], blockquote: [], hr: [],
  strong: [], em: [], a: ['href'],
};
const TABLE_TAGS = ['table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col'];

// What in the HTML markdown would lose: an element with a data-type by that value alone (such as
// panel-info, status or mention), "table" for any table tag, any other tag by its name, an attribute
// that is not allowed as "<tag> <attr>", "comment" for an HTML comment, and "unparsed tag" for
// anything that opens like a tag but does not read as one, such as "<img/src=x>", "<![CDATA[",
// "<?x" or a tag with no closing ">". Each once, in the order first met. A "<" followed by anything
// else, such as a space or a digit, is text, as HTML reads it. The scan reads each character once.
export function htmlUnsupported(html) {
  const found = [];
  const add = (what) => {
    if (!found.includes(what)) found.push(what);
  };
  const text = String(html ?? '');
  const n = text.length;
  const space = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
  const letter = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
  const nameChar = (c) => letter(c) || (c >= '0' && c <= '9') || c === '-';
  let i = 0;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt === -1) break;
    const next = text[lt + 1];
    if (text.startsWith('<!--', lt)) {
      add('comment');
      const close = text.indexOf('-->', lt + 4);
      i = close === -1 ? n : close + 3;
      continue;
    }
    if (next === '!' || next === '?') {
      add('unparsed tag');
      const close = text.indexOf('>', lt + 2);
      i = close === -1 ? n : close + 1;
      continue;
    }
    if (next === '/') {
      // A closing tag adds nothing: its opening tag is reported, or allowed. One that does not read
      // as a tag name and a ">" is refused.
      let j = lt + 2;
      while (j < n && nameChar(text[j])) j++;
      const named = j > lt + 2 && letter(text[lt + 2]);
      while (j < n && space(text[j])) j++;
      if (!named || text[j] !== '>') {
        add('unparsed tag');
        const close = text.indexOf('>', lt + 2);
        i = close === -1 ? n : close + 1;
        continue;
      }
      i = j + 1;
      continue;
    }
    if (!letter(next)) {
      i = lt + 1;
      continue;
    }
    // An opening tag: a name, then attributes, then ">" or "/>".
    let j = lt + 1;
    while (j < n && nameChar(text[j])) j++;
    const tag = text.slice(lt + 1, j).toLowerCase();
    const attrs = [];
    let ok = j < n && (space(text[j]) || text[j] === '>' || text[j] === '/');
    while (ok) {
      while (j < n && space(text[j])) j++;
      if (j >= n) {
        ok = false;
        break;
      }
      if (text[j] === '>') break;
      if (text[j] === '/') {
        if (text[j + 1] === '>') {
          j++;
          break;
        }
        ok = false;
        break;
      }
      const from = j;
      while (j < n && !space(text[j]) && !'=>/"\'<'.includes(text[j])) j++;
      if (j === from) {
        ok = false;
        break;
      }
      const name = text.slice(from, j).toLowerCase();
      let value = '';
      let k = j;
      while (k < n && space(text[k])) k++;
      if (text[k] === '=') {
        k++;
        while (k < n && space(text[k])) k++;
        const q = text[k];
        if (q === '"' || q === "'") {
          const close = text.indexOf(q, k + 1);
          if (close === -1) {
            ok = false;
            break;
          }
          value = text.slice(k + 1, close);
          j = close + 1;
        } else {
          const v = k;
          while (k < n && !space(text[k]) && text[k] !== '>' && !'"\'<=`'.includes(text[k])) k++;
          if (k === v || (k < n && !space(text[k]) && text[k] !== '>')) {
            ok = false;
            break;
          }
          value = text.slice(v, k);
          j = k;
        }
        // An attribute must be followed by a space, ">" or "/".
        if (j < n && !space(text[j]) && text[j] !== '>' && text[j] !== '/') {
          ok = false;
          break;
        }
      }
      attrs.push({ name, value });
    }
    if (!ok) {
      add('unparsed tag');
      const close = text.indexOf('>', lt + 1);
      i = close === -1 ? n : close + 1;
      continue;
    }
    i = j + 1;
    const type = attrs.find((a) => a.name === 'data-type');
    if (type) {
      add(type.value || 'data-type');
      continue;
    }
    if (TABLE_TAGS.includes(tag)) {
      add('table');
      continue;
    }
    if (!Object.hasOwn(TAGS, tag)) {
      add(tag);
      continue;
    }
    for (const a of attrs) {
      const allowed = TAGS[tag].includes(a.name) && (tag !== 'code' || a.name !== 'class' || /^language-[\w+#.-]+$/.test(a.value));
      if (!allowed) add(`${tag} ${a.name}`);
    }
  }
  return found;
}
