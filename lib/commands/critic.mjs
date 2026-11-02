// bollplank critic --ticket T --subject brief|plan|code --round n --prompt-file f --lead claude|codex
//   [--project p] [--critic other|same|claude|codex] [--read-dir d] [--instruction-file f] [--timeout s]
//   [--model m] [--effort e] [--new-session]
// Asks a critic for one critique round and prints it as JSON. The lead has filled the prompt from
// prompts/critic.md or prompts/critic-same.md. This wrapper fills {REVIEWER}, {MODEL}, {WORKFLOW},
// {ISSUE} with the ticket, and {INSTRUCTION} with the text of --instruction-file under a line saying
// it comes from the approver, or with nothing.
// The critic works the board. It gets every tool of its client's Linear MCP servers, read and write,
// no other MCP server, no web and no file edits, and reads the --read-dir folder when one is given.
// It reads the issue and its comments, posts its critique as one comment and replies with the text
// it posted. A critic that shows it used or was given any other tool fails as critic-used-tools. A
// client with no usable Linear server, or a Claude Code whose user settings set a key or a provider
// route or reach outside the source folder, fails as critic-unavailable before any model turn.
// A critique counts only when the critic read the issue and its comments with successful board
// calls. Otherwise the call fails as board-unreachable and the session is kept, so a retry resumes
// it. posted says whether a call that saves a comment on the issue succeeded, on every outcome. The
// body of that call is the source of truth: when it is a well formed critique, the returned text is
// that body, even when the final reply is empty or malformed. When the call fails after such a post,
// the round is counted all the same and the failure says counted, since the board holds that round
// now and a retry would post it twice. The text of a critic that used a tool it is not allowed is
// never returned. The Model line is filled before the call with the pinned model and effort, or
// Unverified. When the client reports another model, the returned text names that one and
// modelCorrection says what the posted comment's Model line holds and what it should hold.
// The critic is --critic when given (a brief's approved Critic: line), else the critic.default of
// --project, else the config's critic.default.
// One critic session per ticket, provider and mode is reused across subjects. Rounds are counted
// per subject. State is written after a counted round, and the session alone after
// board-unreachable. --new-session starts a fresh session and keeps the round counts, for a
// session the client no longer has.
// One call per ticket, provider and mode runs at a time. Another one fails as critic-busy.
// Every call with a known session is bound to its ticket in the ledger, failed calls too.
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { missing, parse } from '../args.mjs';
import { CRITICS, loadConfig, loadProject, projectCritic } from '../config.mjs';
import { withLock, writeJsonAtomic } from '../fsx.mjs';
import { emit, fail } from '../out.mjs';
import { paths } from '../paths.mjs';
import { childEnv, get, other } from '../providers/index.mjs';
import { toolPart } from '../setup/probe.mjs';
import { workflowLine } from '../version.mjs';

export const usage = 'bollplank critic --ticket T --subject brief|plan|code --round n --prompt-file f --lead claude|codex [--project p] [--critic other|same|claude|codex] [--read-dir d] [--instruction-file f] [--timeout s] [--model m] [--effort e] [--new-session]';

const SUBJECTS = ['brief', 'plan', 'code'];
const LEADS = ['claude', 'codex'];
const SPEC = { project: 'value', ticket: 'value', subject: 'value', round: 'value', 'prompt-file': 'value', critic: 'value', lead: 'value', 'read-dir': 'value', 'instruction-file': 'value', timeout: 'value', model: 'value', effort: 'value', 'new-session': 'bool' };

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
  const fresh = opts['new-session'] === true;

  let template;
  try {
    template = readFileSync(opts['prompt-file'], 'utf8');
  } catch (e) {
    fail('usage', `cannot read the prompt file ${opts['prompt-file']}: ${e.code ?? e.message}`);
  }
  let instruction = '';
  if (opts['instruction-file'] !== undefined) {
    try {
      instruction = readFileSync(opts['instruction-file'], 'utf8').trim();
    } catch (e) {
      fail('usage', `cannot read the instruction file ${opts['instruction-file']}: ${e.code ?? e.message}`);
    }
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
  const choice = opts.critic ?? (opts.project !== undefined ? projectCritic(config, loadProject(config, opts.project)).default : config.critic.default);
  const mode = choice === 'other' || choice === 'same' ? choice : 'named';
  const provider = choice === 'other' ? other(lead) : choice === 'same' ? get(lead) : get(choice);
  // A critic of the lead's own provider is a same provider review, however it was chosen.
  const same = provider.name === lead;
  const base = { critic: provider.name, mode, ticket, subject, round };
  const pinned = (same ? config.critic.same?.[provider.name] : undefined) ?? config.critic.providers?.[provider.name] ?? {};
  const model = opts.model ?? pinned.model;
  const effort = opts.effort ?? pinned.effort;

  // The chosen critic is used or the call fails. Nothing switches to another provider or mode.
  // A missing client is the real problem, so it is reported before a round mismatch. Finding it
  // runs nothing.
  const env = childEnv(process.env);
  const bin = provider.resolve(env);
  if (!bin) fail('critic-unavailable', `${provider.label} was not found on PATH or in its app bundle. Install it or choose another critic.`, base);

  const statePath = join(paths().critics, `${ticket}.${provider.name}${same ? '.same' : ''}.json`);
  const call = { ticket, subject, round, provider, same, base, model, effort, readDir, instruction, timeout, template, env, bin, statePath, fresh };
  const lock = await withLock(statePath, () => critique(call));
  if (lock.held) fail('critic-busy', `another critic call for ${ticket} with ${provider.label}${same ? ' in same provider mode' : ''} is running. Wait for it. If none is running, remove the folder ${lock.lock}.`, base);
}

// One round while this ticket, provider and mode is locked.
async function critique({ ticket, subject, round, provider, same, base, model, effort, readDir, instruction, timeout, template, env, bin, statePath, fresh }) {
  // Rounds count per subject. A skipped or repeated round never reaches a client.
  const state = readState(statePath, base);
  const expected = state.rounds[subject] + 1;
  if (round !== expected) fail('round-mismatch', `${subject} round ${round} was asked, but ${state.rounds[subject]} ${subject} rounds are saved for this critic, so the next is ${expected}`, { ...base, expected });

  const sign = provider.signInStatus(bin, env);
  if (!sign.signedIn || !sign.subscription) fail('critic-unavailable', sign.detail, { ...base, signIn: { signedIn: sign.signedIn, subscription: sign.subscription, method: sign.method } });

  // The header lines are filled before the call, since the critic posts the critique itself. One
  // pass, so text the lead or the approver wrote is never filled again.
  const reviewer = same ? `${provider.label}, same provider, separate session` : provider.label;
  const pinnedLine = model ? `${model}, ${effort ?? 'effort unverified'}` : 'Unverified';
  const workflow = workflowLine();
  const fill = { REVIEWER: reviewer, MODEL: pinnedLine, WORKFLOW: workflow, ISSUE: ticket, INSTRUCTION: instruction ? `This instruction comes from the approver of ${ticket}:\n${instruction}` : '' };
  const prompt = template.replace(/\{(REVIEWER|MODEL|WORKFLOW|ISSUE|INSTRUCTION)\}/g, (_, k) => fill[k]);

  const cwd = paths().neutral;
  mkdirSync(cwd, { recursive: true });
  const resume = fresh ? undefined : state.sessionId;
  const r = await provider.review({ bin, prompt, sessionId: resume, model, effort, readDir, cwd, issue: ticket, timeoutMs: timeout * 1000, env });
  const sessionId = r.sessionId ?? resume ?? null;
  bind({ ticket, tool: provider.name, session: sessionId, subject, round, usage: r.usage ?? null });
  const board = boardWork(r.calls ?? [], ticket);
  // A well formed critique the critic posted on the issue is a round on the board, so it is counted
  // whatever else went wrong, and a failure says so.
  const counted = Boolean(board.critique);
  const rounds = counted ? { ...state.rounds, [subject]: round } : state.rounds;
  const failed = (failure, detail, extra = {}) => {
    if (counted) writeJsonAtomic(statePath, { sessionId, rounds });
    fail(failure, detail, { ...base, sessionId, posted: board.posted, ...(counted ? { counted: true } : {}), ...extra });
  };

  if (!r.ok) {
    const extra = {};
    if (r.code !== undefined) extra.code = r.code;
    if (r.fix) extra.fix = r.fix;
    if (r.failure === 'timeout') extra.seconds = timeout;
    // A review that arrived before an abnormal exit is kept for the lead. It is a round only when the
    // critic posted it.
    const received = board.critique ?? (r.text?.trim() ? r.text : null);
    if (r.failure === 'exit' && received) extra.receivedReview = { text: received, verdict: verdictOf(received), sessionId, round, posted: board.posted, counted };
    failed(r.failure, r.detail, extra);
  }
  // The lead never posts a critique whose subject the critic did not read. The session is kept so
  // a retry resumes it, and the round stays open unless the critic posted it anyway.
  if (!board.issue || !board.comments) {
    if (sessionId && !counted) writeJsonAtomic(statePath, { sessionId, rounds: state.rounds });
    const missed = !board.issue ? `the issue ${ticket}` : `the comments of ${ticket}`;
    const next = counted ? 'It posted a critique anyway, so the round is counted. Tell the approver, and do not post another.' : 'Check that its client can reach Linear, then call again with the same round.';
    failed('board-unreachable', `the critic made no successful board call that read ${missed}, so its reply was not used. ${next}`);
  }
  // What the critic posted wins over its final reply.
  const text = board.critique ?? (r.text ?? '').trimStart();
  if (!text.trim()) failed('empty-answer', 'the critic replied with nothing');
  const verdict = verdictOf(text);
  // The reply must be the critique itself, so its first line is the header.
  if (!isCritique(text)) failed('malformed-answer', 'the reply does not start with "Critique of " or has no Verdict line', { head: text.slice(0, 300) });

  // The posted comment carries the pinned model line. The model the client reported wins: the
  // returned text names it, and modelCorrection tells the lead to fix the posted comment.
  const reported = r.model ?? null;
  const correction = reported && reported !== pinnedLine ? { posted: pinnedLine, reported } : null;
  const returned = correction ? withHeader(text, [['Model', reported]]) : text;

  writeJsonAtomic(statePath, { sessionId, rounds: { ...state.rounds, [subject]: round } });
  emit({ ok: true, critic: provider.name, mode: base.mode, ticket, subject, round, sessionId, ...(fresh ? { sessionRestarted: true } : {}), model: reported ?? pinnedLine, verdict, posted: board.posted, ...(correction ? { modelCorrection: correction } : {}), usage: r.usage ?? null, text: returned });
}

// What the critic's Linear calls show: issue when a call that gets the issue named it and
// succeeded, comments when a call that lists comments did the same for that issue, and posted when
// a call that saves or creates a comment on it succeeded. critique is the body of the last such
// comment call that is a well formed critique, else null. The issue is named by its key, or by an
// id the issue read returned for that key, since a client may pass either, and only in an argument
// that identifies an issue, never in free text such as a body or a query.
export function boardWork(calls, issue) {
  const ok = calls.filter((c) => c && c.ok);
  const names = new Set([issue.toLowerCase()]);
  const reads = ok.filter((c) => boardKind(c.tool) === 'issue' && String(c.text ?? '').trim() && namesIssue(c.args, names, issue));
  for (const c of reads) for (const id of issueIds(c.text, issue)) names.add(id.toLowerCase());
  const on = (kind) => ok.filter((c) => boardKind(c.tool) === kind && namesIssue(c.args, names, issue));
  const posts = on('comment');
  const bodies = posts.map((c) => argsObject(c.args)?.body).filter((b) => typeof b === 'string').map((b) => b.trimStart());
  const critique = bodies.filter(isCritique).pop() ?? null;
  return { issue: reads.length > 0, comments: reads.length > 0 && on('comments').length > 0, posted: posts.length > 0, critique };
}

// A well formed critique starts with its "Critique of" line and has a Verdict line.
function isCritique(text) {
  return /^Critique of /.test(text) && Boolean(verdictOf(text));
}

// The kind of a board tool by its own name: issue for get_issue, comments for list_comments,
// comment for save_comment or create_comment, with or without a leading linear, in snake or camel
// case. Anything else is null.
export function boardKind(tool) {
  const words = toolPart(tool)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words[0] === 'linear') words.shift();
  const [verb, ...rest] = words;
  const noun = rest.join('_');
  if (['get', 'read', 'fetch'].includes(verb) && noun === 'issue') return 'issue';
  if (['list', 'get', 'read', 'fetch'].includes(verb) && ['comments', 'issue_comments'].includes(noun)) return 'comments';
  if (['save', 'create', 'add', 'post'].includes(verb) && ['comment', 'issue_comment'].includes(noun)) return 'comment';
  return null;
}

// The argument names that identify an issue, compared without case, _ or -. A comment's body, a
// search query or a title never counts, so a critique that only mentions the key names nothing.
const ISSUE_KEYS = new Set(['issue', 'issueid', 'issuekey', 'issueidentifier', 'issueurl', 'issuenumber', 'id', 'identifier', 'key', 'url']);

// Whether an argument that identifies an issue names this one: one of its names whole, or its key
// as a whole word inside a link. An issue argument that is an object is searched the same way.
function namesIssue(args, names, issue, depth = 0) {
  const obj = argsObject(args);
  if (!obj || depth > 4) return false;
  return Object.entries(obj).some(([k, v]) => {
    if (!ISSUE_KEYS.has(k.toLowerCase().replace(/[^a-z]/g, ''))) return false;
    if (typeof v === 'string') {
      const t = v.trim();
      return names.has(t.toLowerCase()) || new RegExp(`(^|[^A-Za-z0-9-])${issue}($|[^A-Za-z0-9])`, 'i').test(t);
    }
    return Boolean(v) && typeof v === 'object' && !Array.isArray(v) && namesIssue(v, names, issue, depth + 1);
  });
}

// A call's arguments as an object, from an object or from JSON in a string, as the clients pass them.
function argsObject(args) {
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      return null;
    }
  }
  return args && typeof args === 'object' && !Array.isArray(args) ? args : null;
}

// The ids of the issue in an issue read's result: the id of each object whose identifier is the
// key. A result is read as JSON, including JSON inside a string, as the clients wrap tool results.
function issueIds(text, issue) {
  const ids = new Set();
  const visit = (v, depth) => {
    if (depth > 12 || v == null) return;
    if (typeof v === 'string') {
      const t = v.trim();
      if (t.startsWith('{') || t.startsWith('[')) {
        try {
          visit(JSON.parse(t), depth + 1);
        } catch {}
      }
      return;
    }
    if (Array.isArray(v)) return v.forEach((x) => visit(x, depth + 1));
    if (typeof v !== 'object') return;
    if (typeof v.identifier === 'string' && v.identifier.toLowerCase() === issue.toLowerCase() && typeof v.id === 'string' && v.id) ids.add(v.id);
    for (const x of Object.values(v)) visit(x, depth + 1);
  };
  visit(text, 0);
  return [...ids];
}

// Sets each line of the header, the lines from "Critique of" to the first blank line. A line that
// is there is rewritten in place. A missing one goes after the one before it in this order, or
// right after the "Critique of" line.
export function withHeader(text, lines) {
  const all = text.split('\n');
  let end = all.findIndex((l, i) => i > 0 && !l.trim());
  if (end < 0) end = all.length;
  let anchor = 0;
  for (const [key, value] of lines) {
    const at = all.slice(1, end).findIndex((l) => l.startsWith(`${key}:`));
    if (at >= 0) {
      all[at + 1] = `${key}: ${value}`;
      anchor = at + 1;
    } else {
      all.splice(anchor + 1, 0, `${key}: ${value}`);
      anchor += 1;
      end += 1;
    }
  }
  return all.join('\n');
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
