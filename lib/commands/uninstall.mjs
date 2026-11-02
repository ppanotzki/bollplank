// bollplank uninstall [--purge] [--yes] [--json]
// Removes the links recorded in ~/.bollplank/install.json that still point into the kit, and
// nothing else. A recorded path that is now something else is left and reported. The clients' own
// files and settings, the Linear MCP included, are never touched. ~/.bollplank stays unless
// --purge is given and confirmed, on a terminal or with --yes.
import { existsSync, rmSync } from 'node:fs';
import { parse } from '../args.mjs';
import { readConfig } from '../config.mjs';
import { emit, fail, say } from '../out.mjs';
import { kitDir, paths } from '../paths.mjs';
import { readInstall, removeLinks, writeInstall } from '../setup/links.mjs';
import { asker } from '../setup/prompts.mjs';

export const usage = 'bollplank uninstall [--purge] [--yes] [--json]';

export async function run(argv) {
  const { opts, positional, error } = parse(argv, { purge: 'bool', yes: 'bool', json: 'bool' });
  if (error || positional.length) fail('usage', error ?? usage);
  const home = paths().home;
  if (opts.purge && !opts.yes && !process.stdin.isTTY) fail('usage', '--purge removes everything in ~/.bollplank. Without a terminal to confirm it, pass --yes as well.');
  const lock = readConfig().config?.shipLock ?? paths().shipLock;
  if (opts.purge && existsSync(lock)) fail('lock-held', `the ship lock ${lock} is held, so a ticket may be shipping. Wait for it to finish, then run uninstall again.`);

  const r = removeLinks();
  const install = readInstall();
  const removedPaths = new Set(r.removed.map((l) => l.path));
  if (!install.missing) writeInstall({ kit: install.kit ?? kitDir, links: install.links.filter((l) => !removedPaths.has(l.path) && r.left.some((x) => x.path === l.path)) });

  let purged = false;
  if (opts.purge && existsSync(home)) {
    const inside = kitDir === home || kitDir.startsWith(home + '/') || kitDir.startsWith(home + '\\');
    let sure = Boolean(opts.yes);
    if (!sure) {
      const io = asker({ json: Boolean(opts.json) });
      sure = await io.yes('purge', `Remove ${home} with your config, critic state and ledger${inside ? `, and the kit itself at ${kitDir}` : ''}? This cannot be undone.`, false);
      io.close();
    }
    if (sure) {
      rmSync(home, { recursive: true, force: true });
      purged = true;
    }
  }

  const result = { ok: true, removed: r.removed.map((l) => l.path), left: r.left.map((l) => ({ path: l.path, reason: l.reason })), home, purged, kept: !purged };
  if (opts.json) emit(result);
  if (r.missing) say(`There is no install record at ${paths().install}, so no links were removed.`);
  else say(r.removed.length ? `Removed ${r.removed.length} link${r.removed.length === 1 ? '' : 's'}:\n${r.removed.map((l) => `  ${l.path}`).join('\n')}` : 'No recorded links were left to remove.');
  for (const l of r.left) say(`Left ${l.path} alone. It is ${l.reason}.`);
  say(purged ? `Removed ${home}.` : `Kept ${home} with your config. Run \`bollplank uninstall --purge\` to remove it too.`);
  say('The clients and their settings are as they were. A Linear MCP that init added stays. Remove it with `claude mcp remove linear` or `codex mcp remove linear` if you want.');
}
