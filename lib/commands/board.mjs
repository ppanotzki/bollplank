// bollplank board safe-write jira --html <file> | --adf <file>
// bollplank board compare jira --sent <file> --got <file>
//
// safe-write checks a Jira description before the board skill replaces it with markdown, and exits 0
// only when markdown would keep all of it. With --html the file holds the description as getJiraIssue
// returns it with responseContentFormat "html", either the raw result or the description itself.
// Atlassian's v2 server returns only markdown or HTML, and HTML is lossless. With --adf the file holds
// the description in ADF, for a server that returns it. An empty or missing description passes.
//
// compare checks a readback: what the lead sent against what Jira returned, after Jira's known
// markdown rewrites on both sides (lib/jira-text.mjs). Both read local files only and never touch the
// network.
import { readFileSync } from 'node:fs';
import { parse } from '../args.mjs';
import { emit, fail } from '../out.mjs';
import { firstDifference, htmlUnsupported } from '../jira-text.mjs';

export const usage = 'bollplank board safe-write jira --html <file> | --adf <file>, or bollplank board compare jira --sent <file> --got <file>';

// The ADF types that survive a markdown write and read on Jira.
export const ROUND_TRIP_NODES = ['doc', 'paragraph', 'text', 'heading', 'bulletList', 'orderedList', 'listItem', 'codeBlock', 'rule', 'hardBreak', 'blockquote'];
export const ROUND_TRIP_MARKS = ['strong', 'em', 'code', 'link'];

export function run(argv) {
  const { opts, positional, error } = parse(argv, { adf: 'value', html: 'value', sent: 'value', got: 'value' });
  const [cmd, kind, ...extra] = positional ?? [];
  if (error || !cmd || !kind || extra.length) fail('usage', error ?? usage);
  if (cmd !== 'safe-write' && cmd !== 'compare') fail('usage', `unknown board command ${cmd}. ${usage}`);
  if (kind !== 'jira') fail('usage', `${cmd} is for jira only, not ${kind}. ${usage}`);
  if (cmd === 'compare') return compare(opts);
  if ((opts.adf === undefined) === (opts.html === undefined)) fail('usage', `give one of --html and --adf. ${usage}`);
  if (opts.html !== undefined) return safeHtml(opts.html);

  const text = readText(opts.adf);
  if (text.trim() === '') emit({ ok: true, unsupported: [], empty: true });
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    fail('not-adf', `${opts.adf} is not valid JSON: ${e.message}`, { unsupported: [] });
  }
  if (doc === null || doc === '') emit({ ok: true, unsupported: [], empty: true });
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || doc.type !== 'doc') {
    fail('not-adf', `${opts.adf} is not an ADF document: its root has no type "doc"`, { unsupported: [] });
  }
  const found = unsupportedTypes(doc);
  if (found.problem) fail('not-adf', `${opts.adf} is not an ADF document: ${found.problem}`, { unsupported: [] });
  if (found.unsupported.length) {
    fail('unsupported', `markdown does not round trip ${found.unsupported.join(', ')}, so the description must not be written`, { unsupported: found.unsupported });
  }
  emit({ ok: true, unsupported: [] });
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    fail('usage', `cannot read ${file}: ${e.code ?? e.message}`);
  }
}

// The description in an HTML file: the file itself, or from a getJiraIssue result in JSON, the
// issue's fields.description. A result must say appliedContentFormat "html", since a result read as
// markdown, or with no format named, is not the lossless HTML the check needs. HTML never starts with
// "{" or "[", so a file that does is read as JSON.
function safeHtml(file) {
  const text = readText(file);
  let html = text;
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    let result;
    try {
      result = JSON.parse(t);
    } catch (e) {
      fail('not-html', `${file} starts like JSON but is not valid JSON: ${e.message}`, { unsupported: [] });
    }
    const issue = issueOf(result);
    if (!issue) fail('not-html', `${file} holds JSON that is not a getJiraIssue result with fields`, { unsupported: [] });
    if (issue.applied !== 'html') fail('not-html', `${file} ${typeof issue.applied === 'string' ? `was read as ${issue.applied.slice(0, 40)}` : 'names no appliedContentFormat'}, not html. Read the description again with responseContentFormat "html".`, { unsupported: [] });
    html = issue.description;
    // A result with no description field shows nothing about the description: the default view leaves
    // it out, and so does the server for an empty one even when it is asked for. So it is refused. A
    // first write onto an issue the lead created empty needs no check, as the board reference says.
    if (html === undefined) fail('no-description', `${file} holds no description field, so the description was not checked. Read the issue again with fields ["description"] and fieldsByKeys true. If it still has none, the description is empty.`, { unsupported: [] });
    if (html === null) emit({ ok: true, unsupported: [], empty: true });
    if (typeof html !== 'string') fail('not-html', `the description in ${file} is not text`, { unsupported: [] });
  }
  if (html.trim() === '') emit({ ok: true, unsupported: [], empty: true });
  // Jira's HTML holds at least one tag, such as <p>, so text with none is not that HTML, such as a
  // markdown read saved by mistake.
  if (!/<[A-Za-z]/.test(html)) fail('not-html', `${file} holds text with no HTML tag. Read the description again with responseContentFormat "html".`, { unsupported: [] });
  const unsupported = htmlUnsupported(html);
  if (unsupported.length) fail('unsupported', `markdown does not round trip ${unsupported.join(', ')}, so the description must not be written`, { unsupported });
  emit({ ok: true, unsupported: [] });
}

// The issue in a getJiraIssue result: the object with fields, at the top or under data,
// structuredContent or issue, with the appliedContentFormat found on the way.
function issueOf(v, depth = 0, applied) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || depth > 4) return null;
  const here = v.appliedContentFormat !== undefined ? v.appliedContentFormat : applied;
  if (v.fields && typeof v.fields === 'object' && !Array.isArray(v.fields)) return { description: v.fields.description, applied: here };
  for (const k of ['data', 'structuredContent', 'issue']) {
    const found = issueOf(v[k], depth + 1, here);
    if (found) return found;
  }
  return null;
}

function compare(opts) {
  if (opts.sent === undefined || opts.got === undefined) fail('usage', `compare needs --sent and --got. ${usage}`);
  const diff = firstDifference(readText(opts.sent), readText(opts.got));
  if (diff) {
    const cut = (l) => (l === null ? null : l.slice(0, 200));
    fail('differs', `line ${diff.line} differs after Jira's known rewrites`, { line: diff.line, sent: cut(diff.sent), got: cut(diff.got) });
  }
  emit({ ok: true });
}

// Every node and mark type outside the round trip lists, in the order first met, each once. A
// heading whose attrs.level is not a whole number from 1 to 6 is listed as "heading level <level>",
// since markdown has no such heading. Other attrs, such as a codeBlock language, are fine. A node or
// mark without a string type makes the document not ADF. The walk is breadth first through a list
// and an index, with no recursion and no spread, so a very wide or deep document is read in one pass.
export function unsupportedTypes(doc) {
  const unsupported = [];
  const add = (type) => {
    if (!unsupported.includes(type)) unsupported.push(type);
  };
  const queue = [doc];
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i];
    queue[i] = undefined;
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return { problem: 'a node has no type', unsupported };
    if (!ROUND_TRIP_NODES.includes(node.type)) add(node.type);
    if (node.type === 'heading') {
      const level = node.attrs?.level;
      if (!(Number.isInteger(level) && level >= 1 && level <= 6)) add(`heading level ${level === undefined ? 'missing' : String(level).slice(0, 20)}`);
    }
    if (node.marks !== undefined) {
      if (!Array.isArray(node.marks)) return { problem: `the marks of a ${node.type} node are not a list`, unsupported };
      for (const mark of node.marks) {
        if (!mark || typeof mark !== 'object' || typeof mark.type !== 'string') return { problem: 'a mark has no type', unsupported };
        if (!ROUND_TRIP_MARKS.includes(mark.type)) add(mark.type);
      }
    }
    if (node.content !== undefined) {
      if (!Array.isArray(node.content)) return { problem: `the content of a ${node.type} node is not a list`, unsupported };
      for (const child of node.content) queue.push(child);
    }
  }
  return { unsupported };
}
