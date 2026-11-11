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

// The HTML check and the compare, with the shapes Atlassian's v2 server returned on 11 November
// 2026, under made up names.
function files(t) {
  const s = sandbox();
  t.after(s.clean);
  let n = 0;
  const file = (content) => {
    const f = join(s.root, `f-${++n}.txt`);
    writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content));
    return f;
  };
  return { s, file };
}

const issueResult = (description, applied = 'html') => ({ data: { appliedContentFormat: applied, id: '10001', key: 'ACM-1', fields: description === undefined ? {} : { description } } });
const plainHtml = '<p>Brief v1\nResponsible: Claude Code\nApproval: Pending</p><h2>Why</h2><p>Acme&#039;s <strong>board</strong> and <em>notes</em>, see <a href="https://acme.atlassian.net/browse/ACM-2">ACM-2</a> and <code>run</code>.</p><ol start="2"><li><p>One</p></li></ol><ul><li><p>Two</p></li></ul><pre data-unique-id="ab12"><code class="language-sh">bollplank doctor</code></pre><blockquote><p>Quote</p></blockquote><hr><p>Line<br>break</p>';

test('a plain description in HTML passes, as a raw result or as the description string', (t) => {
  const { s, file } = files(t);
  for (const content of [issueResult(plainHtml), plainHtml]) {
    const r = s.run(['board', 'safe-write', 'jira', '--html', file(content)]);
    assert.equal(r.status, 0, r.stdout);
    assert.deepEqual(r.json, { ok: true, unsupported: [] });
  }
});

test('rich HTML fails and names each thing markdown would lose once', (t) => {
  const { s, file } = files(t);
  const rich = '<p>Intro</p><table><thead><tr><th><p>A</p></th></tr></thead><tbody><tr><td><p>1</p></td></tr></tbody></table><div data-type="panel-info"><p>Note</p></div><p><span data-type="status" data-color="blue">OPEN</span> <span data-type="mention" data-user-id="1">@Ada</span> <span data-type="emoji" data-shortname=":smile:">x</span></p><img src="x.png"><p class="lead">Text</p><!-- note --><code class="nope here">x</code>';
  const r = s.run(['board', 'safe-write', 'jira', '--html', file(issueResult(rich))]);
  assert.equal(r.status, 1, r.stdout);
  assert.equal(r.json.failure, 'unsupported');
  assert.deepEqual(r.json.unsupported, ['table', 'panel-info', 'status', 'mention', 'emoji', 'img', 'p class', 'comment', 'code class']);
});

test('an empty description passes, and a result read as markdown is refused', (t) => {
  const { s, file } = files(t);
  for (const content of [issueResult(null), issueResult(''), '']) {
    const r = s.run(['board', 'safe-write', 'jira', '--html', file(content)]);
    assert.equal(r.status, 0, r.stdout);
    assert.equal(r.json.empty, true);
  }
  const md = s.run(['board', 'safe-write', 'jira', '--html', file(issueResult('Brief v1', 'markdown'))]);
  assert.equal(md.status, 1, md.stdout);
  assert.equal(md.json.failure, 'not-html');
  const bad = s.run(['board', 'safe-write', 'jira', '--html', file('{"data":')]);
  assert.equal(bad.json.failure, 'not-html');
  const both = s.run(['board', 'safe-write', 'jira', '--html', file(plainHtml), '--adf', file('')]);
  assert.equal(both.status, 2, both.stdout);
});

test('compare allows only Jira\'s known rewrites', (t) => {
  const { s, file } = files(t);
  const sent = 'Brief v1\nResponsible: Claude Code\n\n## Scope\n\n- One\n  - Two\n1. Three\n';
  const got = 'Brief v1  \r\nResponsible: Claude Code  \n\n## Scope\n\n* One\n  * Two\n1. Three\n\n';
  const ok = s.run(['board', 'compare', 'jira', '--sent', file(sent), '--got', file(got)]);
  assert.equal(ok.status, 0, ok.stdout);
  assert.deepEqual(ok.json, { ok: true });
  for (const [changed, line] of [['Brief v1\nResponsible: Claude Code\n\n## Scope\n\n* One\n  * Too\n1. Three', 7], ['Brief v1\nResponsible:  Claude Code', 2], ['Brief v1', 2], ['Brief v1\nResponsible: Claude Code\n\n## Scope\n\n* One\n  * Two\n2. Three', 8]]) {
    const r = s.run(['board', 'compare', 'jira', '--sent', file(sent), '--got', file(changed)]);
    assert.equal(r.status, 1, r.stdout);
    assert.equal(r.json.failure, 'differs');
    assert.equal(r.json.line, line, changed);
  }
  assert.equal(s.run(['board', 'compare', 'jira', '--sent', file(sent)]).status, 2);
  assert.equal(s.run(['board', 'compare', 'linear', '--sent', file(sent), '--got', file(got)]).status, 2);
});

test('what does not read as a tag is refused, and the scan stays fast', async (t) => {
  const { htmlUnsupported } = await import('../lib/jira-text.mjs');
  for (const html of ['<svg/onload=alert(1)>', '<img/src=x>', '<a/onclick=y>', '<img / >', '<p><img src="x" alt="a b" / ></p>', '<a href="x" / onclick=y>', '<img =x>', '<img:x>', '<x_y>', '<pé>', '<![CDATA[x]]>', '<!x>', '<?x>', '<!DOCTYPE html>', '<p', '</ p>', '</>', '<a href="x>y']) {
    assert.ok(htmlUnsupported(html).length > 0, html);
  }
  for (const html of ['<p>ok</p><br/><br />', '<p>a < b and 3<4</p>', '<a href="https://acme.test/?a=1&b=2">x</a>', '</p >', '<code class="language-python">x</code>']) assert.deepEqual(htmlUnsupported(html), [], html);
  // Inputs that made a regex try every split now take one pass.
  const started = Date.now();
  htmlUnsupported(`<p${' x="1 2"'.repeat(40)} /x`);
  htmlUnsupported('<a x'.repeat(32000));
  htmlUnsupported('<p>x</p>'.repeat(100000));
  assert.ok(Date.now() - started < 2000, `${Date.now() - started} ms`);
  // A JSON result must name appliedContentFormat "html", and a JSON list is never HTML.
  const { s, file } = files(t);
  for (const content of [{ data: { key: 'ACM-1', fields: { description: '| a |\n|---|\n| 1 |' } } }, { appliedContentFormat: 5, data: { fields: { description: '<p>x</p>' } } }, [issueResult('<div data-type="panel-info">x</div>')]]) {
    const r = s.run(['board', 'safe-write', 'jira', '--html', file(content)]);
    assert.equal(r.status, 1, JSON.stringify(content));
    assert.equal(r.json.failure, 'not-html', JSON.stringify(content));
  }
});

test('text with no tag is not HTML, and a result with no description field is refused', (t) => {
  const { s, file } = files(t);
  const md = s.run(['board', 'safe-write', 'jira', '--html', file('| A | B |\n|---|---|\n| 1 | 2 |')]);
  assert.equal(md.status, 1, md.stdout);
  assert.equal(md.json.failure, 'not-html');
  // The default view leaves the description out, so a result without it shows nothing about it.
  const missing = s.run(['board', 'safe-write', 'jira', '--html', file({ data: { appliedContentFormat: 'html', key: 'ACM-1', fields: { summary: 'Brief' } } })]);
  assert.equal(missing.status, 1, missing.stdout);
  assert.equal(missing.json.failure, 'no-description');
  const hidden = s.run(['board', 'safe-write', 'jira', '--html', file('<p>a < b <img src=x></p>')]);
  assert.deepEqual(hidden.json.unsupported, ['img']);
});

test('compare keeps list markers inside code as content', async () => {
  const { firstDifference } = await import('../lib/jira-text.mjs');
  // A fenced diff where a deletion became an addition is a change, and so is the same in indented code.
  assert.deepEqual(firstDifference('Diff:\n\n```\n- old\n+ new\n```\n', 'Diff:\n\n```\n+ old\n+ new\n```\n'), { line: 4, sent: '- old', got: '+ old' });
  assert.notEqual(firstDifference('Diff:\n\n~~~sh\n* a\n~~~', 'Diff:\n\n~~~sh\n- a\n~~~'), null);
  assert.notEqual(firstDifference('Diff:\n\n    - old\n    + new', 'Diff:\n\n    + old\n    + new'), null);
  // A list keeps working around code, and a nested item deeper than 4 is still a list item.
  assert.equal(firstDifference('- a\n    - deep\n\n```\nx\n```\n\n- b', '* a  \n    * deep\n\n```\nx\n```\n\n* b\n'), null);
  // Trailing spaces in a fence are still Jira's to add.
  assert.equal(firstDifference('```\nx\n```', '```  \nx  \n```'), null);
});
