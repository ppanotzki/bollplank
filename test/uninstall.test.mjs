// bollplank uninstall, after an init against a fake claude in a temporary home.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, fakesSkip, kit } from './helpers.mjs';

const FAKE_CLAUDE = `
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2.1.312 (Claude Code)'); process.exit(0); }
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'pro' })); process.exit(0); }
if (args[0] === 'mcp') { console.log('No MCP servers configured.'); process.exit(0); }
process.exit(2);
`;

function box(t) {
  const s = sandbox();
  t.after(s.clean);
  s.fake('claude', FAKE_CLAUDE);
  const answers = join(s.root, 'answers.json');
  writeFileSync(answers, JSON.stringify({ approver: 'Ada', addProject: false }));
  const r = s.run(['init', '--answers', answers, '--offline', '--json']);
  assert.equal(r.status, 0, r.stdout);
  const install = () => JSON.parse(readFileSync(join(s.bollplank, 'install.json'), 'utf8'));
  return { s, install, links: r.json.links.made };
}

test('uninstall removes only recorded links into the kit and keeps the home', { skip: fakesSkip }, (t) => {
  const b = box(t);
  assert.ok(b.links.length >= 8);
  // A recorded path the person replaced with their own folder, and a link into the kit that
  // Bollplank never recorded.
  const replaced = b.links[0];
  unlinkSync(replaced);
  mkdirSync(replaced);
  writeFileSync(join(replaced, 'SKILL.md'), 'mine\n');
  const unrecorded = join(b.s.home, 'acme-link');
  symlinkSync(join(kit, 'skills'), unrecorded);
  const settings = join(b.s.claude, 'settings.json');
  writeFileSync(settings, '{"acme":true}\n');

  const r = b.s.run(['uninstall', '--json']);
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(r.json.removed.sort(), b.links.slice(1).sort());
  assert.deepEqual(r.json.left, [{ path: replaced, reason: 'no longer a link' }]);
  for (const p of b.links.slice(1)) assert.equal(existsSync(p), false, p);
  assert.equal(readFileSync(join(replaced, 'SKILL.md'), 'utf8'), 'mine\n');
  assert.equal(lstatSync(unrecorded).isSymbolicLink(), true);
  assert.equal(readFileSync(settings, 'utf8'), '{"acme":true}\n');
  assert.equal(r.json.purged, false);
  assert.ok(existsSync(join(b.s.bollplank, 'config.json')));
  assert.deepEqual(b.install().links.map((l) => l.path), [replaced]);

  const human = b.s.run(['uninstall']);
  assert.equal(human.status, 0);
  assert.match(human.stdout, /No recorded links were left to remove/);
  assert.match(human.stdout, /Kept .*\.bollplank with your config/);
});

test('uninstall --purge needs a confirmation and refuses while the ship lock is held', { skip: fakesSkip }, (t) => {
  const b = box(t);
  const noTty = b.s.run(['uninstall', '--purge']);
  assert.equal(noTty.status, 2);
  assert.match(noTty.json.detail, /pass --yes/);
  assert.ok(existsSync(join(b.s.bollplank, 'config.json')));
  assert.ok(existsSync(b.links[0]), 'nothing was removed on a refusal');
  mkdirSync(join(b.s.bollplank, 'ship.lock'));
  const held = b.s.run(['uninstall', '--purge', '--yes']);
  assert.equal(held.json.failure, 'lock-held');
  assert.ok(existsSync(join(b.s.bollplank, 'config.json')));
  rmSync(join(b.s.bollplank, 'ship.lock'), { recursive: true });
  const r = b.s.run(['uninstall', '--purge', '--yes', '--json']);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.purged, true);
  assert.equal(existsSync(b.s.bollplank), false);
  for (const p of b.links) assert.equal(existsSync(p), false, p);
  assert.ok(existsSync(b.s.claude), 'the client folder stays');
});
