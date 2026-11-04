import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// The docs check of the gate. The docs, skills, prompts, agent instructions and GitHub files are
// public, so they name no internal ticket, tool or command. A ticket key is allowed only in the
// synthetic forms ACME-<n> and ACM-<n>. A hit names its file, its line and the match, and nothing more of the line.
export const DOC_PATHS = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', 'AGENTS.md', '.github', 'docs', 'skills', 'prompts'];
// Plans sit on a branch while its work runs and are removed before it merges.
const SKIP = [join('docs', 'plans')];

// Any hyphen-like dash: the hyphen-minus, the soft and non-breaking hyphens, the figure, en and em
// dashes, the minus sign and their small and full width forms.
const DASH = '[-\\u00AD\\u2010-\\u2015\\u2212\\uFE58\\uFE63\\uFF0D]';
// Standards and names that look like a ticket key but are not one, such as UTF-8, SHA-256,
// ISO-8601, HTTP-2, RFC-2119, AES-128, CVE-2024, ES-2015, GPT-5, X86-64, IPV-6, TLS-1, OAUTH-2,
// MD-5, CRC-32 and ECMA-262. Compared without regard to case.
const STANDARDS = ['UTF', 'SHA', 'ISO', 'HTTP', 'RFC', 'AES', 'CVE', 'ES', 'GPT', 'X86', 'IPV', 'TLS', 'OAUTH', 'MD', 'CRC', 'ECMA'];
const prefixOf = (m) => m.split(new RegExp(DASH))[0].toUpperCase();

const RULES = [
  // Any case, so neo-182 in a branch name is caught as well as NEO-182.
  { what: 'a ticket key', re: new RegExp(`\\b[A-Za-z][A-Za-z0-9]*${DASH}\\d+\\b`, 'g'), allowed: (m) => /^ACME?-\d+$/i.test(m) || STANDARDS.includes(prefixOf(m)) },
  // The internal name with any dash, an underscore or a space between its words.
  { what: 'an internal name', re: new RegExp(`\\bagent(?:${DASH}|[_\\s])workflow`, 'gi') },
  { what: 'an internal command', re: new RegExp(`\\baw${DASH}[A-Za-z0-9-]*`, 'gi') },
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
