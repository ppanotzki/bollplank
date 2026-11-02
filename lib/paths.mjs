import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every path Bollplank uses comes from here. Tests point them at temporary folders through
// BOLLPLANK_HOME, HOME, CLAUDE_CONFIG_DIR and CODEX_HOME.
export const kitDir = dirname(dirname(fileURLToPath(import.meta.url)));

export function expand(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return homedir();
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
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
