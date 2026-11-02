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
// sign in. Names are matched ignoring case, since Windows does.
export const SCRUB = /^(ANTHROPIC_|OPENAI_|CODEX_API_KEY|CODEX_ACCESS|CLAUDE_CODE_USE_|AWS_BEARER_TOKEN_BEDROCK|AZURE_OPENAI)/i;

// The markers a running Claude Code session leaves for its children are removed too, so a same
// provider critic started inside Claude Code is a fresh process and not a child session of it.
// CLAUDE_CODE_SIMPLE is bare mode, which would also refuse a subscription sign in.
// CLAUDE_CODE_OAUTH_TOKEN is a subscription sign in and stays.
export const SESSION_MARKERS = /^(CLAUDECODE$|CLAUDE_CODE_ENTRYPOINT$|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_AGENT_SDK_|CLAUDE_CODE_SIMPLE$|CLAUDE_CODE_SESSION_|CLAUDE_CODE_HOST_SESSION_ID$|CLAUDE_CODE_CHILD_SESSION$|CLAUDE_CODE_MESSAGING_|CLAUDE_CODE_SDK_)/i;

export function childEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !SCRUB.test(k) && !SESSION_MARKERS.test(k)));
}
