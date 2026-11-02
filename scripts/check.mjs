#!/usr/bin/env node
// Bollplank's merge gate, run on every PR as the checks workflow. The first version's ticket grows
// it. For now:
// 1. The license and the agent instructions are present.
// 2. package.json parses and names the project.
// 3. Every script in bin/, lib/ and scripts/ parses.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const problems = [];

for (const file of ['LICENSE', 'AGENTS.md', 'README.md']) if (!existsSync(join(root, file))) problems.push(`${file}: missing`);
if (existsSync(join(root, 'LICENSE')) && !readFileSync(join(root, 'LICENSE'), 'utf8').startsWith('MIT License')) problems.push('LICENSE: not the MIT license');

try {
  if (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name !== 'bollplank') problems.push('package.json: name is not bollplank');
} catch (e) {
  problems.push(`package.json: ${e.message}`);
}

for (const dir of ['bin', 'lib', 'scripts']) {
  if (!existsSync(join(root, dir))) continue;
  for (const name of readdirSync(join(root, dir))) {
    try {
      execFileSync(process.execPath, ['--check', join(root, dir, name)], { stdio: 'pipe' });
    } catch (e) {
      problems.push(`${dir}/${name}: does not parse: ${String(e.stderr).split('\n').find((l) => l.trim()) ?? ''}`);
    }
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('bollplank check OK');
