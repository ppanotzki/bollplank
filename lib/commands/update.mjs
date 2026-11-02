// bollplank update [--json]
// Moves the kit to its newest release: fetches the tags, checks out the newest v* tag by semantic
// version (detached), links the skills again as init does, and prints that release's section of
// CHANGELOG.md. A kit with local changes is left as it is.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../args.mjs';
import { firstLine, git, tryGit } from '../git.mjs';
import { emit, fail, say } from '../out.mjs';
import { kitDir } from '../paths.mjs';
import { findClients } from '../setup/clients.mjs';
import { linkSkills, readInstall } from '../setup/links.mjs';

export const usage = 'bollplank update [--json]';

export function run(argv) {
  const { opts, positional, error } = parse(argv, { json: 'bool' });
  if (error || positional.length) fail('usage', error ?? usage);
  const kit = kitDir;
  if (!tryGit(kit, 'rev-parse', '--is-inside-work-tree')) fail('not-a-checkout', `${kit} is not a git checkout, so it cannot update itself. Clone Bollplank again as the setup guide says.`);
  const changes = tryGit(kit, 'status', '--porcelain');
  if (changes) fail('local-changes', `${kit} has local changes, so update leaves it as it is. Commit, stash or discard them, then run bollplank update again.`, { changes: changes.split('\n').slice(0, 20) });
  try {
    git(kit, 'fetch', '--tags', '--quiet');
  } catch (e) {
    fail('fetch', `git fetch --tags failed in ${kit}: ${firstLine(e)}`);
  }
  const tags = (tryGit(kit, 'tag', '--list', 'v*') ?? '').split('\n').filter((t) => semver(t));
  if (!tags.length) fail('no-release', `${kit} has no release tags (v1.2.3).`);
  const newest = tags.sort(compare).pop();
  const head = git(kit, 'rev-parse', 'HEAD');
  const target = git(kit, 'rev-parse', `${newest}^{commit}`);
  const already = head === target;
  if (!already) {
    try {
      git(kit, 'checkout', '--quiet', '--detach', newest);
    } catch (e) {
      fail('checkout', `git checkout ${newest} failed in ${kit}: ${firstLine(e)}`);
    }
  }

  // The clients that were found, and any client folder that already holds a recorded link.
  const dirs = new Map(findClients().filter((c) => c.found).map((c) => [c.name, c.dir]));
  for (const l of readInstall().links) if (l.kind === 'skill' && l.client && !dirs.has(l.client)) dirs.set(l.client, join(l.path, '..', '..'));
  const links = linkSkills([...dirs].map(([name, dir]) => ({ name, dir })), kit);
  const notes = changelog(kit, newest);

  const result = { ok: true, kit, tag: newest, already, from: head, to: target, links: { made: links.made.map((l) => l.path), kept: links.kept.map((l) => l.path), skipped: links.skipped.map((l) => ({ path: l.path, reason: l.reason })), removed: links.removed.map((l) => l.path) }, changelog: notes };
  if (opts.json) emit(result);
  say(already ? `Bollplank is already on the newest release, ${newest}.` : `Bollplank is now on ${newest}.`);
  if (links.made.length) say(`Linked ${links.made.length} skill${links.made.length === 1 ? '' : 's'}.`);
  for (const s of links.skipped) say(`Left ${s.path} alone. It is ${s.reason}.`);
  for (const r of links.removed) say(`Removed ${r.path}, a link to a skill the kit no longer has.`);
  say(notes ? `\n${notes}` : `CHANGELOG.md has no section for ${newest}.`);
}

// The section of CHANGELOG.md whose heading names the version, up to the next heading of its level.
export function changelog(kit, tag) {
  const file = join(kit, 'CHANGELOG.md');
  if (!existsSync(file)) return null;
  const version = tag.replace(/^v/, '').replace(/[.+]/g, (c) => `\\${c}`);
  const lines = readFileSync(file, 'utf8').split('\n');
  const start = lines.findIndex((l) => new RegExp(`^##\\s+\\[?v?${version}\\]?(\\s|$)`).test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^##?\s/.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start, end).join('\n').trim();
}

// v1.2.3 with an optional pre-release such as v1.2.3-rc.1. A pre-release sorts before its release.
export function semver(tag) {
  const m = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(tag);
  return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null } : null;
}

export function compare(a, b) {
  const x = semver(a);
  const y = semver(b);
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  const p = x.pre.split('.');
  const q = y.pre.split('.');
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    const [n, m] = [Number(p[i]), Number(q[i])];
    const numeric = /^\d+$/.test(p[i]) && /^\d+$/.test(q[i]);
    if (numeric && n !== m) return n - m;
    if (!numeric && p[i] !== q[i]) return p[i] < q[i] ? -1 : 1;
  }
  return 0;
}
