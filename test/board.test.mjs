import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers.mjs';

// The safe write check reads one local file and needs no config, client or network.
function setup(t) {
  const s = sandbox();
  t.after(s.clean);
  let n = 0;
  const check = (content) => {
    const file = join(s.root, `adf-${++n}.json`);
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
    return s.run(['board', 'safe-write', 'jira', '--adf', file]);
  };
  return { s, check };
}

const text = (t, marks) => ({ type: 'text', text: t, ...(marks ? { marks } : {}) });
const para = (...content) => ({ type: 'paragraph', content });
const doc = (...content) => ({ type: 'doc', version: 1, content });

// A brief as Jira returns it in ADF: headings, lists, a code block, a quote, a rule and marks.
const plainBrief = doc(
  { type: 'heading', attrs: { level: 2 }, content: [text('Brief v1')] },
  para(text('Model: '), text('Claude', [{ type: 'strong' }]), { type: 'hardBreak' }, text('Workflow: Bollplank 0.7.0, build 1', [{ type: 'em' }])),
  { type: 'bulletList', content: [{ type: 'listItem', content: [para(text('ACME-1', [{ type: 'link', attrs: { href: 'https://acme.atlassian.net/browse/ACME-1' } }]))] }] },
  { type: 'orderedList', content: [{ type: 'listItem', content: [para(text('run', [{ type: 'code' }]))] }] },
  { type: 'codeBlock', attrs: { language: 'sh' }, content: [text('bollplank doctor')] },
  { type: 'blockquote', content: [para(text('Raised by: ACM-2'))] },
  { type: 'rule' },
);

test('a plain brief in ADF passes', (t) => {
  const { check } = setup(t);
  const r = check(plainBrief);
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(r.json, { ok: true, unsupported: [] });
});

test('media, a mention and a table each fail and are named', (t) => {
  const { check } = setup(t);
  const cases = {
    media: doc(para(text('See')), { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'x', type: 'file', collection: 'c' } }] }),
    mention: doc(para(text('Ask '), { type: 'mention', attrs: { id: '1', text: '@Acme' } })),
    table: doc({ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [para(text('a'))] }] }] }),
  };
  const r1 = check(cases.media);
  assert.equal(r1.status, 1);
  assert.equal(r1.json.ok, false);
  assert.deepEqual(r1.json.unsupported, ['mediaSingle', 'media']);
  const r2 = check(cases.mention);
  assert.equal(r2.status, 1);
  assert.deepEqual(r2.json.unsupported, ['mention']);
  const r3 = check(cases.table);
  assert.equal(r3.status, 1);
  assert.deepEqual(r3.json.unsupported, ['table', 'tableRow', 'tableCell']);
  assert.match(r3.json.detail, /table/);
});

test('a mark outside the list fails and is named', (t) => {
  const { check } = setup(t);
  const r = check(doc(para(text('red', [{ type: 'textColor', attrs: { color: '#ff0000' } }]))));
  assert.equal(r.status, 1);
  assert.deepEqual(r.json.unsupported, ['textColor']);
});

test('a file that is not ADF fails', (t) => {
  const { check } = setup(t);
  for (const content of ['{ not json', '"plain text"', JSON.stringify({ type: 'paragraph', content: [] }), JSON.stringify([plainBrief]), JSON.stringify(doc({ content: [] }))]) {
    const r = check(content);
    assert.equal(r.status, 1, content);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.failure, 'not-adf');
  }
});

test('an empty doc, an empty file and a null description pass', (t) => {
  const { check } = setup(t);
  for (const content of [JSON.stringify(doc()), JSON.stringify({ type: 'doc', version: 1 }), '', 'null', '""']) {
    const r = check(content);
    assert.equal(r.status, 0, content);
    assert.equal(r.json.ok, true);
    assert.deepEqual(r.json.unsupported, []);
  }
});

test('usage errors exit 2', (t) => {
  const { s, check } = setup(t);
  assert.equal(s.run(['board', 'safe-write', 'jira']).status, 2);
  assert.equal(s.run(['board', 'safe-write', 'linear', '--adf', 'x.json']).status, 2);
  assert.equal(s.run(['board', 'write', 'jira', '--adf', 'x.json']).status, 2);
  assert.equal(s.run(['board', 'safe-write', 'jira', '--adf', join(s.root, 'missing.json')]).status, 2);
  assert.equal(check(plainBrief).status, 0);
});

test('a heading level outside 1 to 6 fails, other attrs are fine, and a very wide or deep document is read', (t) => {
  const { check } = setup(t);
  for (const level of [0, 7, '2', 1.5, undefined]) {
    const r = check(doc({ type: 'heading', attrs: level === undefined ? {} : { level }, content: [text('Brief')] }));
    assert.equal(r.status, 1, `${level} ${r.stdout}`);
    assert.equal(r.json.failure, 'unsupported');
    assert.deepEqual(r.json.unsupported, [`heading level ${level === undefined ? 'missing' : level}`]);
  }
  const attrs = check(doc({ type: 'heading', attrs: { level: 6, localId: 'a' }, content: [text('Brief')] }, { type: 'codeBlock', attrs: { language: 'acme-lang' }, content: [text('x')] }, { type: 'paragraph', attrs: { localId: 'b' }, content: [text('y')] }));
  assert.equal(attrs.status, 0, attrs.stdout);
  const wide = check({ type: 'doc', version: 1, content: Array.from({ length: 200000 }, () => para(text('x'))) });
  assert.equal(wide.status, 0, wide.stdout + wide.stderr);
  assert.deepEqual(wide.json, { ok: true, unsupported: [] });
  // The deep document is written as JSON text, since JSON.stringify of 5000 levels overflows the
  // stack on Node 20 to 24. The command reads it with JSON.parse and no recursion of its own.
  const depth = 5000;
  const deep = `${'{"type":"blockquote","content":['.repeat(depth)}${JSON.stringify(para(text('x')))}${']}'.repeat(depth)}`;
  const d = check(`{"type":"doc","version":1,"content":[${deep},${JSON.stringify({ type: 'heading', attrs: { level: 9 }, content: [] })}]}`);
  assert.deepEqual(d.json.unsupported, ['heading level 9']);
});
