// What init and doctor know about the two clients on this machine: where each is, its version
// against the one Bollplank was tested with, its sign in, and its own folder for skills.
import { claudeDir, codexDir } from '../paths.mjs';
import { childEnv, providers, SCRUB } from '../providers/index.mjs';

export const INSTALL_HINT = {
  claude: 'Install Claude Code (https://claude.com/claude-code) so that `claude` is on PATH, then run this again.',
  codex: 'Install Codex with `npm install -g @openai/codex` so that `codex` is on PATH, or install the ChatGPT desktop app, then run this again.',
};

export const SIGN_IN_HINT = {
  claude: 'Run `claude auth login` and sign in with your Claude subscription.',
  codex: 'Run `codex login` and sign in with ChatGPT.',
};

// Every child gets the scrubbed environment, so a key in the shell never decides a sign in.
export function findClients(env = process.env) {
  const clean = childEnv(env);
  return Object.values(providers).map((p) => {
    const dir = p.name === 'claude' ? claudeDir() : codexDir();
    const bin = p.resolve(clean);
    if (!bin) return { name: p.name, label: p.label, provider: p, dir, found: false, usable: false, tested: p.testedVersion };
    const version = p.version(bin, clean);
    const signIn = p.signInStatus(bin, clean);
    return { name: p.name, label: p.label, provider: p, dir, found: true, bin, version, tested: p.testedVersion, testedMatch: version === p.testedVersion, signIn, usable: signIn.signedIn && signIn.subscription };
  });
}

export function versionNote(c) {
  if (!c.version) return `${c.label} did not report its version. Bollplank was tested with ${c.tested}.`;
  if (c.version === c.tested) return `${c.label} ${c.version}, the version Bollplank was tested with.`;
  return `${c.label} ${c.version}. Bollplank was tested with ${c.tested}. It should work, and a problem is worth reporting with both versions.`;
}

// The names of key and provider variables set in the shell. Values are never read or shown.
export function keyVariables(env = process.env) {
  return Object.keys(env).filter((k) => SCRUB.test(k)).sort();
}
