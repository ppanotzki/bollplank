#!/usr/bin/env node
// Bollplank's merge gate, run on every PR as the checks workflow and locally before a push.
// 1. The license, README and agent instructions are present, and package.json names the project.
// 2. Every script in bin/, lib/ and scripts/ parses.
// 3. Every skill has frontmatter, a name equal to its folder that starts with bollplank-, and a description.
// 4. Every prompt template keeps the placeholders the critique skill and the critic fill.
// 5. The docs, skills, prompts, AGENTS.md and .github/ name no internal ticket, tool or command
//    (lib/docs-check.mjs).
// 6. The example config is valid, and the schema parses.
// 7. The tests in test/ pass. They use synthetic files and fake programs only.
// 8. The private name check passes on HEAD and its whole history. Skipped is a failure here.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../lib/config.mjs';
import { docsProblems } from '../lib/docs-check.mjs';
import { scan } from '../lib/private-scan.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const problems = [];
// --no-tests skips step 7 while iterating. The PR check and the final local run never pass it.
const skipTests = process.argv.includes('--no-tests');

for (const file of ['LICENSE', 'AGENTS.md', 'README.md']) if (!existsSync(join(root, file))) problems.push(`${file}: missing`);
if (existsSync(join(root, 'LICENSE')) && !readFileSync(join(root, 'LICENSE'), 'utf8').startsWith('MIT License')) problems.push('LICENSE: not the MIT license');
try {
  if (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name !== 'bollplank') problems.push('package.json: name is not bollplank');
} catch (e) {
  problems.push(`package.json: ${e.message}`);
}

const files = (dir) =>
  existsSync(dir)
    ? readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]))
    : [];
for (const file of ['bin', 'lib', 'scripts'].flatMap((d) => files(join(root, d)))) {
  if (!file.endsWith('.mjs') && dirname(file) !== join(root, 'bin')) continue;
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (e) {
    problems.push(`${relative(root, file)}: does not parse: ${String(e.stderr).split('\n').find((l) => l.trim()) ?? ''}`);
  }
}

const skills = join(root, 'skills');
for (const name of existsSync(skills) ? readdirSync(skills) : []) {
  if (!statSync(join(skills, name)).isDirectory()) continue;
  const file = join(skills, name, 'SKILL.md');
  if (!name.startsWith('bollplank-')) problems.push(`skills/${name}: skill folders start with bollplank-`);
  if (!existsSync(file)) {
    problems.push(`skills/${name}: no SKILL.md`);
    continue;
  }
  const front = readFileSync(file, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!front) {
    problems.push(`skills/${name}/SKILL.md: no frontmatter`);
    continue;
  }
  if (front[1].match(/^name:\s*(.+)$/m)?.[1].trim() !== name) problems.push(`skills/${name}/SKILL.md: name does not match the folder`);
  if (!/^description:\s*\S/m.test(front[1])) problems.push(`skills/${name}/SKILL.md: no description`);
}

const prompts = join(root, 'prompts');
for (const name of ['critic.md', 'critic-same.md']) if (!existsSync(join(prompts, name))) problems.push(`prompts/${name}: missing`);
for (const name of existsSync(prompts) ? readdirSync(prompts).filter((f) => f.startsWith('critic')) : []) {
  const text = readFileSync(join(prompts, name), 'utf8');
  for (const p of ['{TICKET}', '{ROUND}', '{SUBJECT}', '{SUBJECT_SHORT}', '{DATE}', '{ROUND_NOTE}', '{REVIEWER}', '{MODEL}', '{WORKFLOW}', '{BODY}', '{ISSUE}', '{BOARD}', '{INSTRUCTION}']) {
    if (!text.includes(p)) problems.push(`prompts/${name}: missing ${p}`);
  }
}

problems.push(...docsProblems(root));

try {
  for (const p of validate(JSON.parse(readFileSync(join(root, 'examples', 'config.example.json'), 'utf8')))) problems.push(`examples/config.example.json: ${p}`);
  JSON.parse(readFileSync(join(root, 'schema', 'config.schema.json'), 'utf8'));
} catch (e) {
  problems.push(`config example or schema: ${e.message}`);
}

const tests = existsSync(join(root, 'test')) ? readdirSync(join(root, 'test')).filter((f) => f.endsWith('.test.mjs')).sort() : [];
if (tests.length && !skipTests) {
  try {
    execFileSync(process.execPath, ['--test', '--test-reporter=tap', ...tests.map((f) => join(root, 'test', f))], { stdio: 'pipe', maxBuffer: 1 << 28 });
  } catch (e) {
    const failed = [...new Set(String(e.stdout).split('\n').filter((l) => /^\s*not ok \d+/.test(l)).map((l) => l.trim()))];
    problems.push(`test/: ${failed.length ? failed.join('; ') : 'the tests did not run'}`);
  }
}

const privacy = scan(root, 'HEAD');
if (privacy.outcome === 'skipped') problems.push(`private names: skipped, which does not pass. ${privacy.reason}`);
// A hit names only its pattern, its commit and a file whose path matches nothing, never the name.
if (privacy.outcome === 'failed' && !privacy.hits) problems.push(`private names: failed. ${privacy.reason}`);
if (privacy.outcome === 'failed' && privacy.hits) problems.push(`private names: ${privacy.hits.length} hits, ${privacy.hits.slice(0, 10).map((h) => `pattern ${h.pattern} in ${h.file ?? 'a commit message or author'} at ${h.commit}`).join('; ')}`);

if (problems.length) {
  console.error(`bollplank check FAILED (${problems.length}):\n${problems.map((p) => `- ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`bollplank check OK (private names ${privacy.outcome}, ${tests.length} test files)`);
