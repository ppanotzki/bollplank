// install.sh with --no-init, in a temporary home. It links the command, records the link, prints
// the PATH line, is safe to run again, and never replaces a file or a link that is not its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, fakesSkip, kit, isWindows } from './helpers.mjs';

const skip = isWindows ? 'install.sh is a bash script, and Windows support is outside it' : fakesSkip;

function box(t) {
  const s = sandbox();
  t.after(s.clean);
  const link = join(s.home, '.local', 'bin', 'bollplank');
  const install = (args = ['--no-init'], extra = {}) => spawnSync('bash', [join(kit, 'install.sh'), ...args], { env: { ...s.env, SHELL: '/bin/bash', ...extra }, encoding: 'utf8', timeout: 60000 });
  return { s, link, install };
}

test('install.sh --no-init links the command, records it and prints the PATH line', { skip }, (t) => {
  const b = box(t);
  const r = b.install();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(lstatSync(b.link).isSymbolicLink(), true);
  assert.equal(readlinkSync(b.link), join(realpathSync(kit), 'bin', 'bollplank'));
  assert.match(r.stdout, /The kit is at .*\. The recommended place is ~\/\.bollplank\/kit/);
  assert.match(r.stdout, /\.local\/bin is not on your PATH\. Add this line to ~\/\.bashrc, then open a new terminal:/);
  assert.match(r.stdout, /^ {2}export PATH="\$HOME\/\.local\/bin:\$PATH"$/m);
  assert.match(r.stdout, /Installed\. Run bollplank init/);
  const record = JSON.parse(readFileSync(join(b.s.bollplank, 'install.json'), 'utf8'));
  assert.deepEqual(record.links, [{ path: b.link, target: join(realpathSync(kit), 'bin', 'bollplank'), kind: 'bin' }]);

  // Safe to run again, and quiet about PATH once the folder is on it.
  const again = b.install(['--no-init'], { PATH: `${join(b.s.home, '.local', 'bin')}:${b.s.env.PATH}`, SHELL: '/bin/zsh' });
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /already links to this kit/);
  assert.doesNotMatch(again.stdout, /not on your PATH/);
  assert.equal(JSON.parse(readFileSync(join(b.s.bollplank, 'install.json'), 'utf8')).links.length, 1);
  // The linked command runs.
  const v = spawnSync(b.link, ['version', '--json'], { env: b.s.env, encoding: 'utf8' });
  assert.equal(JSON.parse(v.stdout).ok, true);
});

test('install.sh refuses to replace a foreign link or a file', { skip }, (t) => {
  const b = box(t);
  mkdirSync(join(b.s.home, '.local', 'bin'), { recursive: true });
  const other = join(b.s.root, 'acme-tool');
  writeFileSync(other, '#!/bin/sh\n');
  symlinkSync(other, b.link);
  const r = b.install();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /already links to .*acme-tool, which is not this kit\. Bollplank left it alone/);
  assert.equal(readlinkSync(b.link), other);

  const c = box(t);
  mkdirSync(join(c.s.home, '.local', 'bin'), { recursive: true });
  writeFileSync(c.link, 'my own script\n');
  const f = c.install();
  assert.equal(f.status, 1);
  assert.match(f.stderr, /already exists and is not a link\. Bollplank left it alone\. Move it away/);
  assert.equal(readFileSync(c.link, 'utf8'), 'my own script\n');
});

test('install.sh stops with the fix when Node is older than 20, and rejects an unknown option', { skip }, (t) => {
  const b = box(t);
  const node = join(b.s.fakes, 'node');
  writeFileSync(node, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo v18.20.0; else echo 18; fi\n');
  chmodSync(node, 0o755);
  const r = b.install();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /needs Node 20 or later, and this is Node v18\.20\.0\. Install a newer one from https:\/\/nodejs\.org/);
  const u = b.install(['--acme']);
  assert.equal(u.status, 2);
  assert.match(u.stderr, /Unknown option --acme/);
});

test('install.sh runs init with the command folder on PATH, so the first doctor finds bollplank', { skip }, (t) => {
  const b = box(t);
  b.s.fake('claude', `
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2.1.312 (Claude Code)'); process.exit(0); }
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'pro' })); process.exit(0); }
process.exit(2);
`);
  const answers = join(b.s.root, 'answers.json');
  writeFileSync(answers, JSON.stringify({ approver: 'Ada', addProject: false, critic: 'claude' }));
  const r = b.install(['--', '--answers', answers, '--offline', '--json']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // The PATH line is still printed for the person's own shell.
  assert.match(r.stdout, /\.local\/bin is not on your PATH/);
  const result = JSON.parse(r.stdout.slice(r.stdout.indexOf('\n{') + 1));
  const path = result.doctor.checks.find((c) => c.id === 'path');
  assert.equal(path.ok, true, path.detail);
  assert.equal(path.detail, `${b.link}, a link into this kit`);
  assert.equal(result.doctor.ok, true, JSON.stringify(result.doctor.checks.filter((c) => c.ok === false)));
});
