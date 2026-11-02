// bollplank update, run from a copy of the kit in a temporary git checkout with a local origin.
// The worktree's own git is never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, fakesSkip, kit } from './helpers.mjs';
import { compare, changelog } from '../lib/commands/update.mjs';

const FAKE_CLAUDE = `
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2.1.312 (Claude Code)'); process.exit(0); }
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'pro' })); process.exit(0); }
process.exit(2);
`;

const CHANGELOG = (versions) => `# Changelog\n\n${versions.map((v) => `## ${v}\n\n- Acme release ${v}.\n`).join('\n')}`;

function box(t) {
  const s = sandbox();
  t.after(s.clean);
  const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'advice.detachedHead=false', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const origin = join(s.root, 'bollplank.git');
  const dev = join(s.root, 'dev');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  mkdirSync(dev);
  for (const p of ['bin', 'lib', 'skills', 'package.json']) cpSync(join(kit, p), join(dev, p), { recursive: true });
  git(dev, 'init', '-q', '-b', 'main');
  git(dev, 'remote', 'add', 'origin', origin);
  // Each release sets the version in package.json, as a real release does. tag false commits
  // the version without a release tag, as work after a release does.
  const release = (v, versions, tag = true) => {
    writeFileSync(join(dev, 'CHANGELOG.md'), CHANGELOG(versions));
    writeFileSync(join(dev, 'package.json'), JSON.stringify({ name: 'bollplank', version: v.slice(1), private: true, type: 'module' }) + '\n');
    git(dev, 'add', '-A');
    git(dev, 'commit', '-q', '-m', `release ${v}`);
    if (tag) git(dev, 'tag', v);
    git(dev, 'push', '-q', 'origin', 'main', '--tags');
  };
  release('v0.1.0', ['0.1.0']);
  const copy = join(s.root, 'home', '.bollplank', 'kit');
  execFileSync('git', ['clone', '-q', origin, copy]);
  git(copy, 'checkout', '-q', '--detach', 'v0.1.0');
  s.fake('claude', FAKE_CLAUDE);
  const update = (args = ['--json'], at = copy) => {
    const r = spawnSync(process.execPath, [join(at, 'bin', 'bollplank'), 'update', ...args], { env: s.env, encoding: 'utf8', timeout: 60000 });
    let json = null;
    try {
      json = JSON.parse(r.stdout);
    } catch {}
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
  };
  return { s, git, dev, copy, release, update };
}

test('tags sort by semantic version, with a pre-release before its release', () => {
  assert.deepEqual(['v0.9.0', 'v0.10.0', 'v0.2.0', 'v0.10.0-rc.2', 'v0.10.0-rc.10', 'v1.0.0-alpha'].sort(compare), ['v0.2.0', 'v0.9.0', 'v0.10.0-rc.2', 'v0.10.0-rc.10', 'v0.10.0', 'v1.0.0-alpha']);
});

test('update checks out the newest tag, relinks the skills and prints that changelog section', { skip: fakesSkip }, (t) => {
  const b = box(t);
  // v0.9.0 is tagged after v0.10.0, so only a semantic sort picks the right one.
  b.release('v0.10.0', ['0.10.0', '0.1.0']);
  b.release('v0.9.0', ['0.10.0', '0.9.0', '0.1.0']);
  const r = b.update();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.json.tag, 'v0.10.0');
  assert.equal(r.json.already, false);
  assert.equal(b.git(b.copy, 'rev-parse', 'HEAD'), b.git(b.copy, 'rev-parse', 'v0.10.0^{commit}'));
  assert.equal(b.git(b.copy, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD');
  assert.equal(r.json.changelog, '## 0.10.0\n\n- Acme release 0.10.0.');
  const link = join(b.s.claude, 'skills', 'bollplank-brief');
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(readlinkSync(link), join(realpathSync(b.copy), 'skills', 'bollplank-brief'));
  const again = b.update([]);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /already on the newest release, v0\.10\.0/);
  assert.match(again.stdout, /- Acme release 0\.10\.0\./);
});

test('update refuses a kit with local changes and says when the changelog has no section', { skip: fakesSkip }, (t) => {
  const b = box(t);
  writeFileSync(join(b.copy, 'lib', 'acme-local.mjs'), '// a local change\n');
  const r = b.update();
  assert.equal(r.status, 1);
  assert.equal(r.json.failure, 'local-changes');
  assert.match(r.json.detail, /has local changes, so update leaves it as it is/);
  assert.equal(b.git(b.copy, 'rev-parse', 'HEAD'), b.git(b.copy, 'rev-parse', 'v0.1.0^{commit}'));
  assert.equal(existsSync(join(b.s.claude, 'skills')), false);
  assert.equal(changelog(b.copy, 'v9.9.9'), null);
});

test('update never goes back from a kit ahead of the newest release, and skips pre-releases unless --pre', { skip: fakesSkip }, (t) => {
  const b = box(t);
  b.release('v0.2.0', ['0.2.0', '0.1.0']);
  b.release('v0.3.0', ['0.3.0', '0.2.0', '0.1.0'], false);
  b.git(b.copy, 'fetch', '-q', 'origin');
  b.git(b.copy, 'checkout', '-q', '--detach', 'origin/main');
  const head = b.git(b.copy, 'rev-parse', 'HEAD');
  let r = b.update();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.json.installed, '0.3.0');
  assert.equal(r.json.tag, 'v0.2.0');
  assert.equal(r.json.ahead, true);
  assert.equal(r.json.already, true);
  assert.equal(r.json.to, head);
  assert.equal(b.git(b.copy, 'rev-parse', 'HEAD'), head);
  assert.match(b.update([]).stdout, /Bollplank 0\.3\.0 is ahead of the newest release, v0\.2\.0, so update left it where it is\./);

  // A pre-release is newer, and taken only with --pre.
  b.release('v0.4.0-rc.1', ['0.4.0-rc.1', '0.3.0']);
  r = b.update();
  assert.equal(r.json.tag, 'v0.2.0');
  assert.equal(b.git(b.copy, 'rev-parse', 'HEAD'), head);
  r = b.update(['--pre', '--json']);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.tag, 'v0.4.0-rc.1');
  assert.equal(r.json.already, false);
  assert.equal(b.git(b.copy, 'rev-parse', 'HEAD'), b.git(b.copy, 'rev-parse', 'v0.4.0-rc.1^{commit}'));
});

test('update refuses a kit folder inside another repo instead of moving that repo', { skip: fakesSkip }, (t) => {
  const b = box(t);
  const outer = join(b.s.root, 'acme-monorepo');
  const inner = join(outer, 'tools', 'bollplank');
  mkdirSync(inner, { recursive: true });
  for (const p of ['bin', 'lib', 'skills', 'package.json']) cpSync(join(kit, p), join(inner, p), { recursive: true });
  b.git(outer, 'init', '-q', '-b', 'main');
  b.git(outer, 'add', '-A');
  b.git(outer, 'commit', '-q', '-m', 'vendored kit');
  b.git(outer, 'tag', 'v9.0.0');
  const before = b.git(outer, 'rev-parse', 'HEAD');
  const r = b.update(['--json'], inner);
  assert.equal(r.status, 1, r.stdout);
  assert.equal(r.json.failure, 'not-a-checkout');
  assert.match(r.json.detail, /is inside the git checkout .*acme-monorepo, not a checkout of its own/);
  assert.equal(b.git(outer, 'rev-parse', 'HEAD'), before);
  assert.equal(b.git(outer, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
});
