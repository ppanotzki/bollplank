// The links Bollplank makes on the machine, and the record of them in ~/.bollplank/install.json.
// A path that exists and is not a link into this kit is never replaced. It is reported and left.
// Uninstall removes only recorded links that still point into the kit.
//
// install.sh records the command link with `node lib/setup/links.mjs record-bin <link>`.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from '../fsx.mjs';
import { Exit, fail } from '../out.mjs';
import { kitDir, paths } from '../paths.mjs';

// The install record. A record that is there but cannot be read comes back with corrupt set and
// no links. Doctor reports it, and every step that would rewrite it refuses, so the links it
// lists are never forgotten.
export function readInstall(file = paths().install) {
  if (!existsSync(file)) return { kit: null, links: [], missing: true };
  let r;
  try {
    r = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return { kit: null, links: [], corrupt: `${file} is not valid JSON: ${e.message}`, file };
  }
  if (!r || typeof r !== 'object' || Array.isArray(r)) return { kit: null, links: [], corrupt: `${file} does not hold an install record object`, file };
  return { kit: typeof r.kit === 'string' ? r.kit : null, links: Array.isArray(r.links) ? r.links.filter((l) => typeof l?.path === 'string') : [] };
}

// The record, or a corrupt failure that names the file, for steps that act on it.
export function readInstallOrFail(file = paths().install) {
  const r = readInstall(file);
  if (r.corrupt) fail('corrupt', `${r.corrupt}. Fix or remove it by hand. Nothing was changed.`, { file });
  return r;
}

export function writeInstall(data, file = paths().install) {
  writeJsonAtomic(file, { kit: data.kit ?? kitDir, links: data.links });
}

// Adds links to the record, one entry per path, and keeps the rest.
export function record(entries, kit = kitDir) {
  const r = readInstallOrFail();
  const byPath = new Map(r.links.map((l) => [l.path, l]));
  for (const e of entries) byPath.set(e.path, e);
  writeInstall({ kit, links: [...byPath.values()] });
}

// Where a link points, as an absolute path, or null when the path is not a link.
export function linkTarget(path) {
  try {
    if (!lstatSync(path).isSymbolicLink()) return null;
    return resolve(dirname(path), readlinkSync(path));
  } catch {
    return null;
  }
}

// True when path is a link whose target lies inside the kit, even when the target is gone.
export function pointsInto(path, kit = kitDir) {
  const target = linkTarget(path);
  if (!target) return false;
  const roots = new Set([kit, real(kit)]);
  const targets = new Set([target, real(target), join(real(dirname(target)), basename(target))]);
  for (const t of targets) for (const root of roots) if (t === root || t.startsWith(root + sep)) return true;
  return false;
}

// The kit's skills: every skills/bollplank-* folder.
export function kitSkills(kit = kitDir) {
  const dir = join(kit, 'skills');
  try {
    return readdirSync(dir).filter((n) => n.startsWith('bollplank-') && statSync(join(dir, n)).isDirectory()).sort();
  } catch {
    return [];
  }
}

// Links every kit skill into <clientDir>/skills for each client. A link of ours that points
// elsewhere in the kit is pointed at the right folder. Anything else at the path is left alone.
// Links of ours to skills the kit no longer has are removed. Every link made or kept is recorded.
export function linkSkills(clients, kit = kitDir) {
  const made = [];
  const kept = [];
  const skipped = [];
  const removed = [];
  const skills = kitSkills(kit);
  // Read the record first, so a corrupt one stops the links before any is made.
  const r = readInstallOrFail();
  for (const { name, dir } of clients) {
    const skillsDir = join(dir, 'skills');
    for (const skill of skills) {
      const path = join(skillsDir, skill);
      const target = join(kit, 'skills', skill);
      const entry = { path, target, kind: 'skill', client: name };
      const exists = lexists(path);
      if (exists && !pointsInto(path, kit)) {
        skipped.push({ ...entry, reason: linkTarget(path) ? `a link to ${linkTarget(path)}, which is not this kit` : 'a file or folder that is not a link' });
        continue;
      }
      if (exists && same(linkTarget(path), target)) {
        kept.push(entry);
        continue;
      }
      if (exists) unlinkSync(path);
      mkdirSync(skillsDir, { recursive: true });
      symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
      made.push(entry);
    }
  }
  for (const l of r.links) {
    if (l.kind !== 'skill' || skills.includes(basename(l.path))) continue;
    if (pointsInto(l.path, kit) && !existsSync(l.path)) {
      unlinkSync(l.path);
      removed.push(l);
    }
  }
  const gone = new Set(removed.map((l) => l.path));
  const byPath = new Map(r.links.filter((l) => !gone.has(l.path)).map((l) => [l.path, l]));
  for (const e of [...made, ...kept]) byPath.set(e.path, e);
  writeInstall({ kit, links: [...byPath.values()] });
  return { made, kept, skipped, removed };
}

// Each recorded link, checked: still a link, still into the kit, and its target still there.
export function checkLinks(kit = kitDir) {
  const r = readInstall();
  return r.links.map((l) => {
    if (!lexists(l.path)) return { ...l, ok: false, problem: 'missing' };
    if (!pointsInto(l.path, kit)) return { ...l, ok: false, problem: linkTarget(l.path) ? 'points outside the kit' : 'no longer a link' };
    if (!existsSync(l.path)) return { ...l, ok: false, problem: 'points at a kit path that is gone' };
    return { ...l, ok: true };
  });
}

// Removes the recorded links that still point into the kit. Anything else is left and reported.
export function removeLinks(kit = kitDir) {
  const r = readInstallOrFail();
  const removed = [];
  const left = [];
  for (const l of r.links) {
    if (!lexists(l.path)) continue;
    if (!pointsInto(l.path, kit)) {
      left.push({ ...l, reason: linkTarget(l.path) ? `now a link to ${linkTarget(l.path)}` : 'no longer a link' });
      continue;
    }
    unlinkSync(l.path);
    removed.push(l);
  }
  return { removed, left, recorded: r.links.length, missing: r.missing === true };
}

function lexists(p) {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function real(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function same(a, b) {
  return a !== null && (a === b || real(a) === real(b));
}

// install.sh calls this file directly to record the command link it made or found.
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  const [cmd, link] = process.argv.slice(2);
  if (cmd !== 'record-bin' || !link) {
    process.stderr.write('usage: node lib/setup/links.mjs record-bin <link>\n');
    process.exit(2);
  }
  if (!pointsInto(link)) {
    process.stderr.write(`${link} is not a link into ${kitDir}, so it is not recorded.\n`);
    process.exit(1);
  }
  try {
    record([{ path: link, target: linkTarget(link), kind: 'bin' }]);
  } catch (e) {
    // fail() has printed the JSON failure. The exit code tells install.sh to stop.
    if (e instanceof Exit) process.exit(e.code);
    throw e;
  }
}
