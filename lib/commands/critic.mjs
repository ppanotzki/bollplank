// bollplank critic --ticket T --subject brief|plan|code --round n --prompt-file f --lead claude|codex
//   [--critic other|same|claude|codex] [--read-dir d] [--timeout s] [--model m] [--effort e]
// Asks a critic for one critique round and prints it as JSON. The lead has filled the prompt from
// prompts/critic.md or prompts/critic-same.md. This wrapper fills {REVIEWER}, {MODEL} and {WORKFLOW}.
// The critic gets no board. It reads the prompt, and the --read-dir folder when one is given, and
// replies with the critique text. The lead posts it.
// One critic session per ticket, provider and mode is reused across subjects. Rounds are counted
// per subject, and state is written only after a well formed critique.
// Every call with a known session is bound to its ticket in the ledger, failed calls too.
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { missing, parse } from '../args.mjs';
import { CRITICS, loadConfig } from '../config.mjs';
import { emit, fail } from '../out.mjs';
import { paths } from '../paths.mjs';
import { childEnv, get, other } from '../providers/index.mjs';
import { workflowLine } from '../version.mjs';

export const usage = 'bollplank critic --ticket T --subject brief|plan|code --round n --prompt-file f --lead claude|codex [--critic other|same|claude|codex] [--read-dir d] [--timeout s] [--model m] [--effort e]';

const SUBJECTS = ['brief', 'plan', 'code'];
const LEADS = ['claude', 'codex'];
const SPEC = { ticket: 'value', subject: 'value', round: 'value', 'prompt-file': 'value', critic: 'value', lead: 'value', 'read-dir': 'value', timeout: 'value', model: 'value', effort: 'value' };

export async function run(argv) {
  const { opts, positional, error } = parse(argv, SPEC);
  if (error || positional.length) fail('usage', error ?? `unexpected ${positional[0]}. ${usage}`);
  const gap = missing(opts, ['ticket', 'subject', 'round', 'prompt-file', 'lead']);
  if (gap) fail('usage', `${gap}. ${usage}`);
  if (!/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(opts.ticket)) fail('usage', '--ticket must look like ACME-1');
  const ticket = opts.ticket.toUpperCase();
  const subject = opts.subject;
  if (!SUBJECTS.includes(subject)) fail('usage', `--subject must be one of ${SUBJECTS.join(', ')}`);
  if (!/^[1-9]\d*$/.test(opts.round)) fail('usage', '--round must be a whole number from 1');
  const round = Number(opts.round);
  const lead = opts.lead;
  if (!LEADS.includes(lead)) fail('usage', `--lead must be one of ${LEADS.join(', ')}`);
  if (opts.critic !== undefined && !CRITICS.includes(opts.critic)) fail('usage', `--critic must be one of ${CRITICS.join(', ')}`);
  const timeout = opts.timeout === undefined ? 600 : Number(opts.timeout);
  if (!(timeout > 0)) fail('usage', '--timeout must be a number of seconds above 0');

  let template;
  try {
    template = readFileSync(opts['prompt-file'], 'utf8');
  } catch (e) {
    fail('usage', `cannot read the prompt file ${opts['prompt-file']}: ${e.code ?? e.message}`);
  }
  let readDir = null;
  if (opts['read-dir'] !== undefined) {
    try {
      readDir = realpathSync(opts['read-dir']);
      if (!statSync(readDir).isDirectory()) throw new Error('not a folder');
    } catch {
      fail('usage', `--read-dir ${opts['read-dir']} must be a folder that exists and can be read`);
    }
  }

  const config = loadConfig();
  const choice = opts.critic ?? config.critic.default;
  const mode = choice === 'other' || choice === 'same' ? choice : 'named';
  const provider = choice === 'other' ? other(lead) : choice === 'same' ? get(lead) : get(choice);
  // A critic of the lead's own provider is a same provider review, however it was chosen.
  const same = provider.name === lead;
  const base = { critic: provider.name, mode, ticket, subject, round };
  const pinned = (same ? config.critic.same?.[provider.name] : undefined) ?? config.critic.providers?.[provider.name] ?? {};
  const model = opts.model ?? pinned.model;
  const effort = opts.effort ?? pinned.effort;

  // Rounds count per subject. A skipped or repeated round never reaches a client.
  const statePath = join(paths().critics, `${ticket}.${provider.name}${same ? '.same' : ''}.json`);
  const state = readState(statePath, base);
  const expected = state.rounds[subject] + 1;
  if (round !== expected) fail('round-mismatch', `${subject} round ${round} was asked, but ${state.rounds[subject]} ${subject} rounds are saved for this critic, so the next is ${expected}`, { ...base, expected });

  // The chosen critic is used or the call fails. Nothing switches to another provider or mode.
  const env = childEnv(process.env);
  const bin = provider.resolve(env);
  if (!bin) fail('critic-unavailable', `${provider.label} was not found on PATH or in its app bundle. Install it or choose another critic.`, base);
  const sign = provider.signInStatus(bin, env);
  if (!sign.signedIn || !sign.subscription) fail('critic-unavailable', sign.detail, { ...base, signIn: { signedIn: sign.signedIn, subscription: sign.subscription, method: sign.method } });

  const reviewer = same ? `${provider.label}, same provider, separate session` : provider.label;
  const modelLine = model ? `${model}, ${effort ?? 'effort unverified'}` : 'Unverified';
  const prompt = template.replaceAll('{REVIEWER}', reviewer).replaceAll('{MODEL}', modelLine).replaceAll('{WORKFLOW}', workflowLine());

  const cwd = paths().neutral;
  mkdirSync(cwd, { recursive: true });
  const r = await provider.review({ bin, prompt, sessionId: state.sessionId, model, effort, readDir, cwd, timeoutMs: timeout * 1000, env });
  const sessionId = r.sessionId ?? state.sessionId ?? null;
  bind({ ticket, tool: provider.name, session: sessionId, subject, round, usage: r.usage ?? null });

  if (!r.ok) {
    const extra = { ...base, sessionId };
    if (r.code !== undefined) extra.code = r.code;
    if (r.failure === 'timeout') extra.seconds = timeout;
    // A review that arrived before an abnormal exit is kept for the lead, never counted as a round.
    if (r.failure === 'exit' && r.text?.trim()) extra.receivedReview = { text: r.text, verdict: verdictOf(r.text), sessionId, round };
    fail(r.failure, r.detail, extra);
  }
  const text = r.text ?? '';
  if (!text.trim()) fail('empty-answer', 'the critic replied with nothing', { ...base, sessionId });
  const verdict = verdictOf(text);
  // The reply must be the critique itself, so its first line is the header.
  if (!/^Critique of /.test(text.trimStart()) || !verdict) fail('malformed-answer', 'the reply does not start with "Critique of " or has no Verdict line', { ...base, sessionId, head: text.slice(0, 300) });

  // The Model line names the model that actually ran, as the client reported it, so a critique can
  // neither guess nor misstate it. Without a report the prompt's pinned or Unverified line stays.
  const ran = r.model ? `${r.model}, ${effort ?? 'effort not pinned'}` : null;
  const posted = ran ? text.replace(/^Model:.*$/m, `Model: ${ran}`) : text;

  mkdirSync(paths().critics, { recursive: true });
  writeFileSync(statePath, JSON.stringify({ sessionId, rounds: { ...state.rounds, [subject]: round } }, null, 2) + '\n');
  emit({ ok: true, critic: provider.name, mode, ticket, subject, round, sessionId, model: r.model ?? 'Unverified', verdict, usage: r.usage ?? null, text: posted });
}

function readState(file, base) {
  const empty = { sessionId: undefined, rounds: { brief: 0, plan: 0, code: 0 } };
  if (!existsSync(file)) return empty;
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    const rounds = { ...empty.rounds };
    for (const k of SUBJECTS) if (Number.isInteger(s.rounds?.[k]) && s.rounds[k] >= 0) rounds[k] = s.rounds[k];
    return { sessionId: typeof s.sessionId === 'string' && s.sessionId ? s.sessionId : undefined, rounds };
  } catch (e) {
    fail('state', `cannot read the critic state ${file}: ${e.message}`, base);
  }
}

function verdictOf(text) {
  return text.match(/^Verdict:\s*(Approve|Revise)\b/m)?.[1] ?? null;
}

// The ledger binding. A write error never fails the call, since the critique is what matters.
function bind({ ticket, tool, session, subject, round, usage }) {
  if (!session) return;
  try {
    const dir = paths().ledger;
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'bindings.jsonl'), JSON.stringify({ at: new Date().toISOString(), ticket, tool, session, subject, round, usage }) + '\n');
  } catch {}
}
