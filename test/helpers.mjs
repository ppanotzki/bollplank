// Shared test helpers. Every test runs against temporary folders and fake programs: a temporary
// HOME, BOLLPLANK_HOME, CLAUDE_CONFIG_DIR and CODEX_HOME, and fake executables first on PATH.
// No test touches a real sign in, a real config or a real remote.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const kit = dirname(dirname(fileURLToPath(import.meta.url)));
export const bin = join(kit, 'bin', 'bollplank');
export const isWindows = process.platform === 'win32';
// Fake programs are Node scripts with a shebang, which Windows cannot run from PATH.
export const fakesSkip = isWindows ? 'fake programs on PATH need a shebang, which Windows does not run' : false;

// PATH for tests: the fakes, then links to only node and git, then the system folders. The person's
// own tool folders are left out, so a real claude, codex or gh can never be reached from a test.
function isolatedPath(fakes, tools) {
  if (isWindows) return [fakes, process.env.PATH].join(delimiter);
  mkdirSync(tools, { recursive: true });
  for (const name of ['node', 'git']) {
    const real = name === 'node' ? process.execPath : execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim().replace(/\/libexec\/git-core$/, '/bin/git');
    try {
      symlinkSync(existsSync(real) ? real : execFileSync('/usr/bin/which', [name], { encoding: 'utf8' }).trim(), join(tools, name));
    } catch {}
  }
  return [fakes, tools, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter);
}

export function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'bollplank-test-'));
  const dirs = { root, home: join(root, 'home'), bollplank: join(root, 'home', '.bollplank'), claude: join(root, 'home', '.claude'), codex: join(root, 'home', '.codex'), fakes: join(root, 'fakes'), apps: join(root, 'Applications') };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(BOLLPLANK_|ANTHROPIC_|OPENAI_|CODEX_|CLAUDE_)/.test(k))),
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    BOLLPLANK_HOME: dirs.bollplank,
    BOLLPLANK_APPS_DIR: dirs.apps,
    CLAUDE_CONFIG_DIR: dirs.claude,
    CODEX_HOME: dirs.codex,
    PATH: isolatedPath(dirs.fakes, join(root, '.path-tools')),
  };
  return {
    ...dirs,
    env,
    // Write ~/.bollplank/config.json. Pass an object; it is written as JSON.
    config(c) {
      writeFileSync(join(dirs.bollplank, 'config.json'), JSON.stringify(c, null, 2));
    },
    // A fake executable on PATH. body is Node code, run as CommonJS with process.argv as usual.
    fake(name, body) {
      const file = join(dirs.fakes, name);
      writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
      chmodSync(file, 0o755);
      return file;
    },
    // Run `bollplank ...args`. Returns { status, stdout, stderr, json } with json parsed when it can be.
    run(args, extraEnv = {}, input) {
      const r = spawnSync(process.execPath, [bin, ...args], { env: { ...env, ...extraEnv }, encoding: 'utf8', input, timeout: 60000 });
      let json = null;
      try {
        json = JSON.parse(r.stdout);
      } catch {}
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
    },
    clean: () => rmSync(root, { recursive: true, force: true }),
  };
}

// A git repo with a bare origin, so fetch, push and origin/<branch> behave as they do for real.
export function gitRepo(root, name = 'repo', branch = 'main') {
  const origin = join(root, `${name}.git`);
  const work = join(root, name);
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  mkdirSync(work, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', branch, origin]);
  git(work, 'init', '-q', '-b', branch);
  git(work, 'remote', 'add', 'origin', origin);
  const commit = (file, text, message = file) => {
    mkdirSync(dirname(join(work, file)), { recursive: true });
    writeFileSync(join(work, file), text);
    git(work, 'add', file);
    git(work, 'commit', '-q', '-m', message);
    return git(work, 'rev-parse', 'HEAD');
  };
  return { origin, work, git: (...args) => git(work, ...args), commit };
}

// A minimal valid config for one repository project named acme-shop with its repos under source.
export function acmeConfig(source, tickets, repos = { 'acme-api': { github: 'acme/acme-api', checks: ['checks'] } }, extra = {}) {
  return {
    approver: { name: 'Ada' },
    board: { kind: 'linear' },
    projects: { 'acme-shop': { source, tickets, repos, runs: true, ...extra } },
  };
}
