import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// The docs check of the gate. The docs, skills and prompts are public, so they name no internal
// ticket, tool or command. A ticket key is allowed only in the synthetic form ACME-<n>. A hit names
// its file, its line and the match, and nothing more of the line.
export const DOC_PATHS = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', 'docs', 'skills', 'prompts'];
// Plans sit on a branch while its work runs and are removed before it merges.
const SKIP = [join('docs', 'plans')];

const RULES = [
  { what: 'a ticket key', re: /\b[A-Z][A-Z0-9]*-\d+\b/g, allowed: (m) => /^ACME-\d+$/.test(m) },
  { what: 'an internal name', re: /agent-workflow/gi },
  { what: 'an internal command', re: /\baw-[A-Za-z0-9-]*/gi },
];

// The problems in one text, as "<file>:<line>: <what> <match>".
export function textProblems(text, file) {
  const problems = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const { what, re, allowed } of RULES) {
      for (const m of line.matchAll(re)) if (!allowed?.(m[0])) problems.push(`${file}:${i + 1}: ${what} ${m[0]}`);
    }
  });
  return problems;
}

// Every file the check reads, relative to root, with docs/plans left out.
export function docsFiles(root) {
  const walk = (rel) => {
    const abs = join(root, rel);
    if (!existsSync(abs)) return [];
    if (SKIP.some((s) => rel === s || rel.startsWith(s + sep))) return [];
    if (!statSync(abs).isDirectory()) return [rel];
    return readdirSync(abs).sort().flatMap((n) => walk(join(rel, n)));
  };
  return DOC_PATHS.flatMap(walk);
}

export function docsProblems(root) {
  return docsFiles(root).flatMap((rel) => textProblems(readFileSync(join(root, rel), 'utf8'), relative(root, join(root, rel)).split(sep).join('/')));
}
