// The two critic providers by name, and the environment every child of theirs gets.
import * as claude from './claude.mjs';
import * as codex from './codex.mjs';

export const providers = { claude, codex };

export function get(name) {
  return providers[name] ?? null;
}

// The provider that is not leading.
export function other(lead) {
  return lead === 'claude' ? codex : lead === 'codex' ? claude : null;
}

// Every model credential and provider route is removed, so a child can only use its own saved
// sign in. Nothing else is removed.
export const SCRUB = /^(ANTHROPIC_|OPENAI_|CODEX_API_KEY|CODEX_ACCESS|CLAUDE_CODE_USE_|AWS_BEARER_TOKEN_BEDROCK|AZURE_OPENAI)/;

export function childEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !SCRUB.test(k)));
}
