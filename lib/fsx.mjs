import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Write JSON through a temporary file and a rename, so a crash never leaves half a file behind.
export function writeJsonAtomic(file, value, mode) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', mode ? { mode } : undefined);
  renameSync(tmp, file);
}

// Run fn while holding a lock folder next to file. mkdir is atomic, so two processes never both hold it.
// Returns { held: true } without running fn when another process holds the lock.
export async function withLock(file, fn) {
  const lock = `${file}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  try {
    mkdirSync(lock);
  } catch (e) {
    if (e.code === 'EEXIST') return { held: true, lock };
    throw e;
  }
  try {
    return { held: false, value: await fn() };
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
