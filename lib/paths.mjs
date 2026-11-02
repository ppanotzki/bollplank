import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every path Bollplank uses comes from here. Tests point them at temporary folders through
// BOLLPLANK_HOME, HOME, CLAUDE_CONFIG_DIR and CODEX_HOME.
export const kitDir = dirname(dirname(fileURLToPath(import.meta.url)));

// ~ and ~/ name the home folder. Any other relative path is resolved against base: the folder of
// the config file for a path from the config, the current folder for a variable or an argument.
// So a path never depends on where a later command runs. An empty value counts as not set.
export function expand(p, base = process.cwd()) {
  if (typeof p !== 'string') return p;
  if (p === '') return undefined;
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return isAbsolute(p) ? p : resolve(base, p);
}

export function home() {
  return expand(process.env.BOLLPLANK_HOME) ?? join(homedir(), '.bollplank');
}

export function paths() {
  const h = home();
  return {
    home: h,
    config: join(h, 'config.json'),
    kit: join(h, 'kit'),
    critics: join(h, 'critics'),
    neutral: join(h, 'neutral'),
    ledger: expand(process.env.BOLLPLANK_LEDGER_DIR) ?? join(h, 'ledger'),
    install: join(h, 'install.json'),
    shipLock: join(h, 'ship.lock'),
    privateNames: join(h, 'private-names.txt'),
  };
}

export const claudeDir = () => expand(process.env.CLAUDE_CONFIG_DIR) ?? join(homedir(), '.claude');
export const codexDir = () => expand(process.env.CODEX_HOME) ?? join(homedir(), '.codex');
