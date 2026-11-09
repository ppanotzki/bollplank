// bollplank board safe-write jira --adf <file>
// Checks a Jira description before the board skill replaces it with markdown. The file holds the
// description as Jira returns it in ADF (responseContentFormat "adf"). Markdown round trips only
// some ADF node and mark types, so any other type would be lost or changed by the write. The
// command lists those types and exits 0 only when there are none. An empty or missing
// description passes. It reads the one file and never touches the network.
import { readFileSync } from 'node:fs';
import { parse } from '../args.mjs';
import { emit, fail } from '../out.mjs';

export const usage = 'bollplank board safe-write jira --adf <file>';

// The ADF types that survive a markdown write and read on Jira.
export const ROUND_TRIP_NODES = ['doc', 'paragraph', 'text', 'heading', 'bulletList', 'orderedList', 'listItem', 'codeBlock', 'rule', 'hardBreak', 'blockquote'];
export const ROUND_TRIP_MARKS = ['strong', 'em', 'code', 'link'];

export function run(argv) {
  const { opts, positional, error } = parse(argv, { adf: 'value' });
  const [cmd, kind, ...extra] = positional ?? [];
  if (error || !cmd || !kind || extra.length) fail('usage', error ?? usage);
  if (cmd !== 'safe-write') fail('usage', `unknown board command ${cmd}. ${usage}`);
  if (kind !== 'jira') fail('usage', `safe-write is for jira only, not ${kind}. ${usage}`);
  if (opts.adf === undefined) fail('usage', `missing --adf. ${usage}`);

  let text;
  try {
    text = readFileSync(opts.adf, 'utf8');
  } catch (e) {
    fail('usage', `cannot read ${opts.adf}: ${e.code ?? e.message}`);
  }
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

// Every node and mark type outside the round trip lists, in the order first met, each once.
// A node or mark without a string type makes the document not ADF.
export function unsupportedTypes(doc) {
  const unsupported = [];
  const add = (type) => {
    if (!unsupported.includes(type)) unsupported.push(type);
  };
  const stack = [doc];
  while (stack.length) {
    const node = stack.shift();
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return { problem: 'a node has no type', unsupported };
    if (!ROUND_TRIP_NODES.includes(node.type)) add(node.type);
    if (node.marks !== undefined) {
      if (!Array.isArray(node.marks)) return { problem: `the marks of a ${node.type} node are not a list`, unsupported };
      for (const mark of node.marks) {
        if (!mark || typeof mark !== 'object' || typeof mark.type !== 'string') return { problem: 'a mark has no type', unsupported };
        if (!ROUND_TRIP_MARKS.includes(mark.type)) add(mark.type);
      }
    }
    if (node.content !== undefined) {
      if (!Array.isArray(node.content)) return { problem: `the content of a ${node.type} node is not a list`, unsupported };
      stack.push(...node.content);
    }
  }
  return { unsupported };
}
