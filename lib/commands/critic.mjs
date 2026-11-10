// bollplank critic --ticket T --subject brief|plan|code --round n --prompt-file f --lead claude|codex
//   [--project p] [--critic other|same|claude|codex] [--read-dir d] [--instruction-file f] [--timeout s]
//   [--model m] [--effort e] [--new-session]
// bollplank critic pending --ticket T [--project p] [--critic c] [--lead l]
// bollplank critic confirm --ticket T --subject s --round n --text-file f --comment link [--project p] [--critic c] [--lead l]
// Asks a critic for one critique round and prints it as JSON. The lead has filled the prompt from
// prompts/critic.md or prompts/critic-same.md. This wrapper fills {REVIEWER}, {MODEL}, {WORKFLOW},
// {ISSUE} with the ticket, {BOARD} with the board's name, and {INSTRUCTION} with the text of
// --instruction-file under a line saying it comes from the approver, or with nothing.
// The board kind comes from --project, else the top level board. On Linear the critic works the
// board: it gets every tool of its client's Linear MCP servers, read and write. It reads the issue
// and its comments, posts its critique as one comment and replies with the text it posted. On Jira
// the critic is reply only: it gets getJiraIssue and executeRead of listJiraIssueComments on
// Atlassian's official server and no write tool, and replies with its critique, which the lead posts.
// Either way it gets no other MCP server, no web and no file edits, and reads the --read-dir folder
// when one is given. A critic that shows it used or was given any other tool fails as
// critic-used-tools. A client with no usable board server, or a Claude Code whose user settings set
// a key or a provider route or reach outside the source folder, fails as critic-unavailable before
// any model turn.
// A critique counts only when the critic read the issue and its comments with successful board
// calls. On Jira the comments read must cover every page. Otherwise the call fails as
// board-unreachable and the session is kept, so a retry resumes it. posted says whether a call that
// saves a comment on the issue succeeded, on every outcome. On Linear the body of that call is the
// source of truth: when it is a well formed critique, the returned text is that body, even when the
// final reply is empty or malformed. When the call fails after such a post, the round is counted all
// the same and the failure says counted, since the board holds that round now and a retry would post
// it twice. The text of a critic that used a tool it is not allowed is never returned. The Model
// line is filled before the call with the pinned model and effort, or Unverified. When the client
// reports another model, the returned text names that one and modelCorrection says what the posted
// comment's Model line holds and what it should hold. The returned text always carries the expected
// Reviewer, Model and Workflow lines, and headerCorrection names each line the posted header lacks or
// holds wrong, so the lead fixes it.
// On Jira a well formed reply is a pending round, not a counted one. Its exact text is saved next to
// the state file and the state holds pending { subject, round, sha256, file, at }. The result has
// delivery "reply" and pending true. The lead posts the text unchanged and runs `critic confirm`,
// which counts the round. `critic pending` prints the stored text for recovery. A critic call while
// a round is pending fails as post-pending before any client starts.
// The critic is --critic when given (a brief's approved Critic: line), else the critic.default of
// --project, else the config's critic.default.
// One critic session per ticket, provider and mode is reused across subjects. Rounds are counted
// per subject. State is written after a counted round, and the session alone after
// board-unreachable. --new-session starts a fresh session and keeps the round counts, for a
// session the client no longer has.
// One call per ticket, provider and mode runs at a time. Another one fails as critic-busy.
// Every call with a known session is bound to its ticket in the ledger, failed calls too.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { missing, parse } from '../args.mjs';
import { BOARDS, kindOf, sharesTopBoard } from '../boards.mjs';
import { CRITICS, loadConfig, loadProject, projectCritic } from '../config.mjs';
import { withLock, writeJsonAtomic } from '../fsx.mjs';
import { emit, fail } from '../out.mjs';
import { paths } from '../paths.mjs';
import { childEnv, get, other } from '../providers/index.mjs';
import { innerCall, toolPart } from '../setup/probe.mjs';
import { workflowLine } from '../version.mjs';

export const usage = 'bollplank critic --ticket T --subject brief|plan|code --round n --prompt-file f --lead claude|codex [--project p] [--critic other|same|claude|codex] [--read-dir d] [--instruction-file f] [--timeout s] [--model m] [--effort e] [--new-session], or bollplank critic pending --ticket T, or bollplank critic confirm --ticket T --subject s --round n --text-file f --comment link, each of the last two with [--project p] [--critic c] [--lead l]';

const SUBJECTS = ['brief', 'plan', 'code'];
const LEADS = ['claude', 'codex'];
const SPEC = { project: 'value', ticket: 'value', subject: 'value', round: 'value', 'prompt-file': 'value', critic: 'value', lead: 'value', 'read-dir': 'value', 'instruction-file': 'value', timeout: 'value', model: 'value', effort: 'value', 'new-session': 'bool' };

export async function run(argv) {
  if (argv[0] === 'pending') return pendingCommand(argv.slice(1));
  if (argv[0] === 'confirm') return confirmCommand(argv.slice(1));
  const { opts, positional, error } = parse(argv, SPEC);
  if (error || positional.length) fail('usage', error ?? `unexpected ${positional[0]}. ${usage}`);
  const gap = missing(opts, ['ticket', 'subject', 'round', 'prompt-file', 'lead']);
  if (gap) fail('usage', `${gap}. ${usage}`);
  if (!/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(opts.ticket)) fail('usage', '--ticket must look like ACME-1');
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
  const project = opts.project !== undefined ? loadProject(config, opts.project) : null;
  const choice = opts.critic ?? (project ? projectCritic(config, project).default : config.critic.default);
  const kind = kindOf(config, opts.project) ?? 'linear';
  if (!BOARDS[kind]) fail('config', `the board kind ${kind} has no critic`);
  const mode = choice === 'other' || choice === 'same' ? choice : 'named';
  const provider = choice === 'other' ? other(lead) : choice === 'same' ? get(lead) : get(choice);
  // A critic of the lead's own provider is a same provider review, however it was chosen.
  const same = provider.name === lead;
  const base = { critic: provider.name, mode, delivery: kind === 'linear' ? 'posted' : 'reply', ticket, subject, round };
  const pinned = (same ? config.critic.same?.[provider.name] : undefined) ?? config.critic.providers?.[provider.name] ?? {};
  const model = opts.model ?? pinned.model;
  const effort = opts.effort ?? pinned.effort;

  // The chosen critic is used or the call fails. Nothing switches to another provider or mode.
  // A missing client is the real problem, so it is reported before a round mismatch. Finding it
  // runs nothing.
  const env = childEnv(process.env);
  const bin = provider.resolve(env);
  if (!bin) fail('critic-unavailable', `${provider.label} was not found on PATH or in its app bundle. Install it or choose another critic.`, base);

  const statePath = stateFile(ticket, provider.name, same);
  const cloudId = kind === 'jira' ? cloudOf(config, project) : null;
  const call = { ticket, subject, round, provider, same, base, model, effort, readDir, instruction, timeout, template, env, bin, statePath, fresh, kind, cloudId, site: kind === 'jira' ? siteOf(config, project) : null };
  const lock = await withLock(statePath, () => critique(call));
  if (lock.held) fail('critic-busy', `another critic call for ${ticket} with ${provider.label}${same ? ' in same provider mode' : ''} is running. Wait for it. If none is running, remove the folder ${lock.lock}.`, base);
}

// The model each client last reported, kept in the critics folder. Doctor's dry run and every
// critique update it. A pinned model is never stored, since the config already names it.
const modelsPath = () => join(paths().critics, 'models.json');

export function lastModel(name) {
  try {
    const v = JSON.parse(readFileSync(modelsPath(), 'utf8'))[name];
    return typeof v === 'string' && v.trim() ? v : null;
  } catch {
    return null;
  }
}

// Best effort: it runs after the critic posted, so a failed write must never stop the round
// from being saved. The next call then posts Unverified or the older model, and is corrected.
export function rememberModel(name, line) {
  if (typeof line !== 'string' || !line.trim() || lastModel(name) === line) return;
  try {
    let all = {};
    try {
      all = JSON.parse(readFileSync(modelsPath(), 'utf8'));
    } catch {}
    mkdirSync(paths().critics, { recursive: true });
    writeJsonAtomic(modelsPath(), { ...(all && typeof all === 'object' && !Array.isArray(all) ? all : {}), [name]: line });
  } catch {}
}

// One round while this ticket, provider and mode is locked.
async function critique({ ticket, subject, round, provider, same, base, model, effort, readDir, instruction, timeout, template, env, bin, statePath, fresh, kind, cloudId, site }) {
  // Rounds count per subject. A skipped or repeated round never reaches a client, and neither does
  // any call while a Jira round waits for the lead's post and confirm.
  const state = readState(statePath, base);
  if (state.pending) {
    const p = state.pending;
    fail('post-pending', `${p.subject} round ${p.round} of ${ticket} is waiting for the lead to post the critic's reply and run bollplank critic confirm. Run bollplank critic pending --ticket ${ticket} to get its text. No client was started.`, { ...base, pending: { subject: p.subject, round: p.round } });
  }
  const expected = state.rounds[subject] + 1;
  if (round !== expected) fail('round-mismatch', `${subject} round ${round} was asked, but ${state.rounds[subject]} ${subject} rounds are saved for this critic, so the next is ${expected}`, { ...base, expected });

  const sign = provider.signInStatus(bin, env);
  if (!sign.signedIn || !sign.subscription) fail('critic-unavailable', sign.detail, { ...base, signIn: { signedIn: sign.signedIn, subscription: sign.subscription, method: sign.method } });

  // The header lines are filled before the call, since the critic posts the critique itself. One
  // pass, so text the lead or the approver wrote is never filled again.
  const reviewer = same ? `${provider.label}, same provider, separate session` : provider.label;
  // With no pinned model, the model this client last reported fills the line, so the posted
  // header is right unless the client changed models since. Unverified only before any report.
  const pinnedLine = model ? `${model}, ${effort ?? 'effort unverified'}` : (lastModel(provider.name) ?? 'Unverified');
  const workflow = workflowLine();
  const label = BOARDS[kind].label;
  const fill = { REVIEWER: reviewer, MODEL: pinnedLine, WORKFLOW: workflow, ISSUE: ticket, BOARD: label, INSTRUCTION: instruction ? `This instruction comes from the approver of ${ticket}:\n${instruction}` : '' };
  const prompt = (kind === 'jira' ? replyOnly(template, cloudId ?? site) : template).replace(/\{(REVIEWER|MODEL|WORKFLOW|ISSUE|BOARD|INSTRUCTION)\}/g, (_, k) => fill[k]);

  const cwd = paths().neutral;
  mkdirSync(cwd, { recursive: true });
  const resume = fresh ? undefined : state.sessionId;
  const r = await provider.review({ bin, prompt, sessionId: resume, model, effort, readDir, cwd, issue: ticket, board: kind, timeoutMs: timeout * 1000, env });
  const sessionId = r.sessionId ?? resume ?? null;
  bind({ ticket, tool: provider.name, session: sessionId, subject, round, usage: r.usage ?? null });
  const board = boardWork(r.calls ?? [], ticket, kind, { cloudId, site });
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
    const next = counted ? 'It posted a critique anyway, so the round is counted. Tell the approver, and do not post another.' : `Check that its client can reach ${label}, then call again with the same round.`;
    if (kind === 'jira' && board.issue && !board.comments) failed('board-unreachable', `the critic did not read every page of the comments of ${ticket} with listJiraIssueComments${cloudId ? ` on the cloud id ${cloudId}` : ''}, from startAt 0 to the last page, so its reply was not used. ${next}`);
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
  if (reported && !model) rememberModel(provider.name, reported);
  const correction = reported && reported !== pinnedLine ? { posted: pinnedLine, reported } : null;
  // The header must carry the wrapper's Reviewer and Workflow lines and the Model line, the reported
  // model when known, else the pinned line. headerCorrection names each line that is missing or
  // differs, so the lead fixes the posted comment. The round still counts, since the critique was
  // posted and read. The returned text always has the expected header.
  const expectedHeader = [['Reviewer', reviewer], ['Model', reported ?? pinnedLine], ['Workflow', workflow]];
  const headerFix = headerCorrection(text, expectedHeader);
  const returned = withHeader(text, expectedHeader);

  // On Jira the critic posted nothing, so the reply is a pending round. Its exact text is saved
  // first, through a temporary file and a rename, and only then the pending record, so a record
  // never points at a missing or half written text.
  if (kind === 'jira') {
    const file = pendingFile(statePath, subject, round);
    writeTextAtomic(file, returned);
    const pending = { subject, round, sha256: sha256(returned), file, at: new Date().toISOString() };
    writeJsonAtomic(statePath, { sessionId, rounds: state.rounds, pending });
    emit({ ok: true, critic: provider.name, mode: base.mode, delivery: 'reply', ticket, subject, round, sessionId, ...(fresh ? { sessionRestarted: true } : {}), model: reported ?? pinnedLine, verdict, posted: false, pending: true, usage: r.usage ?? null, text: returned });
  }
  writeJsonAtomic(statePath, { sessionId, rounds: { ...state.rounds, [subject]: round } });
  emit({ ok: true, critic: provider.name, mode: base.mode, delivery: 'posted', ticket, subject, round, sessionId, ...(fresh ? { sessionRestarted: true } : {}), model: reported ?? pinnedLine, verdict, posted: board.posted, ...(correction ? { modelCorrection: correction } : {}), ...(headerFix.length ? { headerCorrection: headerFix } : {}), usage: r.usage ?? null, text: returned });
}

// What the critic's Linear calls show: issue when a call that gets the issue succeeded and either
// named it in its arguments or returned it, comments when a call that lists comments did the same
// for that issue, and posted when a call that saves or creates a comment on it succeeded. critique
// is the body of the last such comment call that is a well formed critique, else null. A client may
// name the issue by its key or by its id, so the issue's ids become its aliases: from a read that
// named the key, the id of each object in its result whose identifier is the key, and from a read
// whose result is the issue itself, its id and the ids in its arguments. The issue is named only in
// an argument that identifies an issue, never in free text such as a body or a query, and a read of
// another issue never counts, even when its result mentions the key.
export function boardWork(calls, issue, kind = 'linear', ctx = {}) {
  if (kind === 'jira') return jiraWork(calls, issue, ctx);
  const ok = calls.filter((c) => c && c.ok);
  const names = new Set([issue.toLowerCase()]);
  const reads = [];
  for (const c of ok) {
    if (boardKind(c.tool) !== 'issue' || !String(c.text ?? '').trim()) continue;
    if (namesIssue(c.args, names, issue)) {
      reads.push(c);
      for (const id of issueIds(c.text, issue)) names.add(id.toLowerCase());
      continue;
    }
    // A read that asked for another issue by its key never counts, whatever it returned.
    const ids = argIds(c.args);
    if (ids.some((id) => KEY.test(id) && id.toLowerCase() !== issue.toLowerCase())) continue;
    const got = resultIssue(c.text);
    if (!got || typeof got.identifier !== 'string' || got.identifier.toLowerCase() !== issue.toLowerCase()) continue;
    reads.push(c);
    if (typeof got.id === 'string' && got.id) names.add(got.id.toLowerCase());
    for (const id of ids) names.add(id.toLowerCase());
  }
  const on = (kind) => ok.filter((c) => boardKind(c.tool) === kind && namesIssue(c.args, names, issue));
  const posts = on('comment');
  const bodies = posts.map((c) => argsObject(c.args)?.body).filter((b) => typeof b === 'string').map((b) => b.trimStart());
  const critique = bodies.filter(isCritique).pop() ?? null;
  return { issue: reads.length > 0, comments: reads.length > 0 && on('comments').length > 0, posted: posts.length > 0, critique };
}

// What the critic's Jira calls show. issue: a getJiraIssue call that named the issue by an argument
// that identifies an issue, such as issueIdOrKey, or whose result is the issue itself, with a key
// equal to the ticket. Its numeric id becomes an alias. comments: the pages of executeRead of
// listJiraIssueComments that name this issue cover the whole list. Sorted by startAt, the first
// starts at 0, each next one starts where the one before ended, and the last says isLast true or
// reaches total. Pages may overlap, and each page's startAt must be a whole number from 0, given as a
// number or as decimal digits. Comments inside a getJiraIssue result never count, since they may be
// one page only. A read that names another issue in any argument that identifies an issue, or whose
// result is another issue, never counts. Every call counted must name the project's cloud id,
// ctx.cloudId, compared without case, and the issue's ids are learned only from reads on that cloud
// id. When the config has none, every read and page of this issue
// must name one and the same cloud id, and it must be the configured site, ctx.site, as a host or
// its https:// link. The critic is reply only on Jira, so nothing is looked for as a post.
export function jiraWork(calls, issue, { cloudId = null, site = null } = {}) {
  const none = { issue: false, comments: false, posted: false, critique: null };
  const ok = calls.filter((c) => c && c.ok && String(c.text ?? '').trim());
  // Reads and pages on one cloud id, with the aliases learned only from issue reads on that cloud,
  // so an id the issue has on another site never names it here.
  const onCloud = (cloud) => {
    const mine = ok.filter((c) => cloudArg(toolPart(c.tool) === 'executeRead' ? innerCall(c.args).args : c.args) === cloud);
    const names = new Set([issue.toLowerCase()]);
    const reads = [];
    for (const c of mine) {
      if (toolPart(c.tool) !== 'getJiraIssue') continue;
      const got = resultIssue(c.text, 0, 'key');
      // A read whose result is another issue never counts, whatever its arguments named.
      if (got && got.key.toLowerCase() !== issue.toLowerCase()) continue;
      if (namesIssue(c.args, names, issue)) {
        reads.push(c);
        for (const id of issueIds(c.text, issue, 'key')) names.add(id.toLowerCase());
        continue;
      }
      const ids = argIds(c.args);
      if (ids.some((id) => KEY.test(id) && id.toLowerCase() !== issue.toLowerCase())) continue;
      if (!got) continue;
      reads.push(c);
      if ((typeof got.id === 'string' && got.id) || Number.isInteger(got.id)) names.add(String(got.id).toLowerCase());
      for (const id of ids) names.add(id.toLowerCase());
    }
    const pages = [];
    for (const c of mine) {
      if (toolPart(c.tool) !== 'executeRead') continue;
      const inner = innerCall(c.args);
      if (inner.tool !== 'listJiraIssueComments' || !namesIssue(inner.args, names, issue)) continue;
      const page = resultPage(c.text);
      if (!page) continue;
      // startAt is a whole number from 0, as a number or decimal digits. Anything else, such as
      // null, an empty text or a list, makes the page not count. The page's own startAt wins.
      const asked = inner.args.startAt === undefined ? 0 : startIndex(inner.args.startAt);
      const startAt = page.startAt === undefined ? asked : startIndex(page.startAt);
      if (asked === null || startAt === null) continue;
      pages.push({ startAt, count: page.comments.length, total: Number.isInteger(page.total) ? page.total : null, isLast: page.isLast === true });
    }
    return { reads, pages };
  };
  let target = cloudId ? cloudId.trim().toLowerCase() : null;
  if (!target) {
    // Every cloud id, or none, that any Jira call named, and of those the ones with a read or a page
    // of this issue. Exactly one may have any, and it must be the configured site itself.
    const clouds = new Set(ok.filter((c) => ['getJiraIssue', 'executeRead'].includes(toolPart(c.tool))).map((c) => cloudArg(toolPart(c.tool) === 'executeRead' ? innerCall(c.args).args : c.args)));
    const seen = [...clouds].filter((cloud) => {
      const w = onCloud(cloud);
      return w.reads.length || w.pages.length;
    });
    if (seen.length !== 1 || seen[0] === null) return none;
    [target] = seen;
    if (!site || hostOf(target) !== hostOf(site)) return none;
  }
  const { reads, pages } = onCloud(target);
  const issueRead = reads.length > 0;
  return { ...none, issue: issueRead, comments: issueRead && coversAll(pages) };
}

// The cloudId an Atlassian call named, in lower case, or null.
function cloudArg(args) {
  const v = argsObject(args)?.cloudId;
  return typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : null;
}

// A site as a bare host in lower case, from the host or its https:// link.
function hostOf(v) {
  return String(v).trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/$/, '');
}

// A page's startAt as a whole number from 0, from a number or decimal digits, else null.
function startIndex(v) {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 ? v : null;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return null;
}

// Whether comment pages, each { startAt, count, total, isLast }, cover the list from 0 to its end
// with no gap. Pages may overlap. Sorted by startAt, the first starts at 0 and each next one starts
// at or before the end covered so far, which grows to the furthest end. The list is covered once a
// page within that says isLast, or the covered end reaches a page's total. A page read twice counts
// once, the longer read.
export function coversAll(pages) {
  const at = new Map();
  for (const p of pages) if (!at.has(p.startAt) || p.count > at.get(p.startAt).count) at.set(p.startAt, p);
  const sorted = [...at.values()].sort((a, b) => a.startAt - b.startAt);
  if (!sorted.length || sorted[0].startAt !== 0) return false;
  let end = 0;
  for (const p of sorted) {
    if (p.startAt > end) return false;
    end = Math.max(end, p.startAt + p.count);
    if (p.isLast || (p.total !== null && end >= p.total)) return true;
  }
  return false;
}

// The comments page a listJiraIssueComments read returned: the object with a comments list at the
// top of its result, opening only the wrappers the clients put around a tool result, as for an issue.
function resultPage(text, depth = 0) {
  if (depth > 6 || text == null) return null;
  if (typeof text === 'string') {
    const t = text.trim();
    if (!t.startsWith('{') && !t.startsWith('[')) return null;
    try {
      return resultPage(JSON.parse(t), depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(text)) {
    if (!text.length || !text.every((b) => b && typeof b === 'object' && typeof b.text === 'string' && b.comments === undefined)) return null;
    for (const b of text) {
      const found = resultPage(b.text, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof text !== 'object') return null;
  if (Array.isArray(text.comments)) return text;
  for (const k of ['structuredContent', 'structured_content', 'data']) {
    if (text[k] && typeof text[k] === 'object') {
      const found = resultPage(text[k], depth + 1);
      if (found) return found;
    }
  }
  return Array.isArray(text.content) ? resultPage(text.content, depth + 1) : null;
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
const ISSUE_KEYS = new Set(['issue', 'issueid', 'issuekey', 'issueidorkey', 'issueidentifier', 'issueurl', 'issuenumber', 'id', 'identifier', 'key', 'url']);

// Whether the arguments that identify an issue name this one: one of its names whole, or its key
// as a whole word inside a link. An id given as a number counts as its digits. An issue argument
// that is an object is searched the same way. When any such argument names something else, the
// call does not name this issue, even when another argument does.
function namesIssue(args, names, issue) {
  return issueArgs(args, names, issue) === true;
}

// true when the identifying arguments name only this issue, false when any names something else,
// null when none is given.
function issueArgs(args, names, issue, depth = 0) {
  const obj = argsObject(args);
  if (!obj || depth > 4) return depth > 4 ? false : null;
  let found = null;
  for (const [k, v] of Object.entries(obj)) {
    if (!ISSUE_KEYS.has(k.toLowerCase().replace(/[^a-z]/g, ''))) continue;
    let r = null;
    if (typeof v === 'string' || typeof v === 'number') {
      const t = String(v).trim();
      if (!t) continue;
      r = names.has(t.toLowerCase()) || new RegExp(`(^|[^A-Za-z0-9_-])${issue}($|[^A-Za-z0-9_])`, 'i').test(t);
    } else if (v && typeof v === 'object' && !Array.isArray(v)) r = issueArgs(v, names, issue, depth + 1);
    else if (v !== null && v !== undefined) r = false;
    if (r === false) return false;
    if (r === true) found = true;
  }
  return found;
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
function issueIds(text, issue, field = 'identifier') {
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
    if (typeof v[field] === 'string' && v[field].toLowerCase() === issue.toLowerCase() && ((typeof v.id === 'string' && v.id) || Number.isInteger(v.id))) ids.add(String(v.id));
    for (const x of Object.values(v)) visit(x, depth + 1);
  };
  visit(text, 0);
  return [...ids];
}

// The issue an issue read returned, the object with an identifier at the top of its result, else
// null. Only the wrappers the clients put around a tool result are opened: JSON inside a string, a
// list of text blocks, a content list, structured content and an issue field. Nothing deeper is
// searched, so an issue that another issue's result mentions, such as its parent, is never taken.
function resultIssue(text, depth = 0, field = 'identifier') {
  if (depth > 6 || text == null) return null;
  if (typeof text === 'string') {
    const t = text.trim();
    if (!t.startsWith('{') && !t.startsWith('[')) return null;
    try {
      return resultIssue(JSON.parse(t), depth + 1, field);
    } catch {
      return null;
    }
  }
  // A list of text blocks, never a list of issues.
  if (Array.isArray(text)) {
    if (!text.length || !text.every((b) => b && typeof b === 'object' && typeof b.text === 'string' && b[field] === undefined)) return null;
    for (const b of text) {
      const found = resultIssue(b.text, depth + 1, field);
      if (found) return found;
    }
    return null;
  }
  if (typeof text !== 'object') return null;
  if (typeof text[field] === 'string') return text;
  for (const k of ['structuredContent', 'structured_content', 'data', 'issue']) {
    if (text[k] && typeof text[k] === 'object') {
      const found = resultIssue(text[k], depth + 1, field);
      if (found) return found;
    }
  }
  return Array.isArray(text.content) ? resultIssue(text.content, depth + 1, field) : null;
}

// An issue key such as ACME-1.
const KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

// The ids an issue read passed in its arguments that identify an issue, as strings.
function argIds(args) {
  const obj = argsObject(args);
  if (!obj) return [];
  return Object.entries(obj)
    .filter(([k, v]) => ISSUE_KEYS.has(k.toLowerCase().replace(/[^a-z]/g, '')) && ((typeof v === 'string' && v.trim()) || Number.isInteger(v)))
    .map(([, v]) => String(v).trim());
}

// The header lines, from "Critique of" to the first blank line, that are missing or differ from
// the expected ones, each as { line, posted, expected }. posted is the value the header holds, or
// null when the line is missing.
export function headerCorrection(text, lines) {
  const all = text.split('\n');
  let end = all.findIndex((l, i) => i > 0 && !l.trim());
  if (end < 0) end = all.length;
  const header = all.slice(1, end);
  const out = [];
  for (const [line, expected] of lines) {
    const found = header.find((l) => l.startsWith(`${line}:`));
    const posted = found === undefined ? null : found.slice(line.length + 1).trim();
    if (posted !== expected) out.push({ line, posted, expected });
  }
  return out;
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
  const empty = { sessionId: undefined, rounds: { brief: 0, plan: 0, code: 0 }, pending: null };
  if (!existsSync(file)) return empty;
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    const rounds = { ...empty.rounds };
    for (const k of SUBJECTS) if (Number.isInteger(s.rounds?.[k]) && s.rounds[k] >= 0) rounds[k] = s.rounds[k];
    let pending = null;
    if (s.pending != null) {
      const p = s.pending;
      if (!SUBJECTS.includes(p?.subject) || !Number.isInteger(p.round) || p.round < 1 || !/^[0-9a-f]{64}$/.test(p.sha256 ?? '') || typeof p.file !== 'string' || typeof p.at !== 'string') throw new Error('its pending record is not complete');
      pending = { subject: p.subject, round: p.round, sha256: p.sha256, file: p.file, at: p.at };
    }
    return { sessionId: typeof s.sessionId === 'string' && s.sessionId ? s.sessionId : undefined, rounds, pending };
  } catch (e) {
    fail('state', `cannot read the critic state ${file}: ${e.message}`, base);
  }
}

// The state file of a ticket, provider and mode.
function stateFile(ticket, name, same) {
  return join(paths().critics, `${ticket}.${name}${same ? '.same' : ''}.json`);
}

// The file that holds a pending round's text, named after its state file, so every ticket, provider
// and mode has its own.
function pendingFile(statePath, subject, round) {
  return join(paths().critics, `${basename(statePath, '.json')}.pending-${subject}-${round}.md`);
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// Writes text through a temporary file and a rename, so a crash never leaves half a text behind.
function writeTextAtomic(file, text) {
  mkdirSync(paths().critics, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

// The project's Jira cloud id, its board.teamId, else the top level one for a project of the top
// level kind on the top level site. A project on another site never takes the top level cloud id.
// The site, board.team, is named in the prompt when no cloud id is set.
function cloudOf(config, project) {
  const own = project?.board?.teamId;
  if (typeof own === 'string' && own.trim()) return own.trim();
  const top = config.board?.teamId;
  return sharesTopBoard(config, project?.name) && typeof top === 'string' && top.trim() ? top.trim() : null;
}

function siteOf(config, project) {
  const own = project?.board?.team;
  if (typeof own === 'string' && own.trim()) return own.trim();
  const top = config.board?.team;
  return sharesTopBoard(config, project?.name) && typeof top === 'string' && top.trim() ? top.trim() : null;
}

// The prompts' post sentence, and what a Jira critic is told instead. On Jira the critic is reply
// only, so the sentence that tells it to post is swapped for one that tells it to reply, and how to
// read every page of the comments. A prompt without the sentence gets the Jira text at its end.
const POST_SENTENCE = "Post the critique as one comment on {ISSUE} with your {BOARD} tool. Then reply with exactly the text you posted, with nothing before or after it. Change nothing else on the board unless the approver's instruction above asks for it.";

function replyOnly(template, cloud) {
  const text = [
    'Read the issue with getJiraIssue. Read its comments with executeRead of the tool listJiraIssueComments, from startAt 0, page after page, until a page says isLast is true. Comments inside the getJiraIssue result do not count.',
    ...(cloud ? [`Pass ${cloud} as the cloudId in every Jira call.`] : []),
    'Do not post the critique. You have no tool that writes to Jira, and the lead posts your reply on {ISSUE} unchanged. Reply with the critique only, with nothing before or after it. Change nothing on the board.',
  ].join(' ');
  return template.includes(POST_SENTENCE) ? template.replace(POST_SENTENCE, text) : `${template.replace(/\s*$/, '')}\n\n${text}\n`;
}

const PENDING_SPEC = { ticket: 'value', project: 'value', critic: 'value', lead: 'value' };
const CONFIRM_SPEC = { ...PENDING_SPEC, subject: 'value', round: 'value', 'text-file': 'value', comment: 'value' };

// The one state with a pending round that the options pick. --lead picks the state a critic call
// with the same --lead, --critic and --project uses. Without it, every state of the ticket is
// looked at, narrowed by --critic when that names a provider or a mode. More than one pending
// round needs --lead and --critic to tell them apart.
function pickPending(opts, verb) {
  if (opts.ticket === undefined) fail('usage', `missing --ticket. ${usage}`);
  if (!/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(opts.ticket)) fail('usage', '--ticket must look like ACME-1');
  const ticket = opts.ticket.toUpperCase();
  if (opts.lead !== undefined && !LEADS.includes(opts.lead)) fail('usage', `--lead must be one of ${LEADS.join(', ')}`);
  if (opts.critic !== undefined && !CRITICS.includes(opts.critic)) fail('usage', `--critic must be one of ${CRITICS.join(', ')}`);
  let files;
  if (opts.lead !== undefined) {
    const config = loadConfig();
    const project = opts.project !== undefined ? loadProject(config, opts.project) : null;
    const choice = opts.critic ?? (project ? projectCritic(config, project).default : config.critic.default);
    const provider = choice === 'other' ? other(opts.lead) : choice === 'same' ? get(opts.lead) : get(choice);
    files = [stateFile(ticket, provider.name, provider.name === opts.lead)];
  } else {
    if (opts.project !== undefined) loadProject(loadConfig(), opts.project);
    const names = opts.critic === 'claude' || opts.critic === 'codex' ? [opts.critic] : ['claude', 'codex'];
    files = names.flatMap((n) => [stateFile(ticket, n, false), stateFile(ticket, n, true)]);
    if (opts.critic === 'same') files = files.filter((f) => f.endsWith('.same.json'));
    if (opts.critic === 'other') files = files.filter((f) => !f.endsWith('.same.json'));
  }
  const found = [];
  for (const file of files) {
    const name = basename(file, '.json').slice(ticket.length + 1);
    const [critic, same] = [name.split('.')[0], name.endsWith('.same')];
    const state = readState(file, { critic, ticket });
    if (state.pending) found.push({ file, critic, same, state });
  }
  if (!found.length) fail('no-pending', `no critic round of ${ticket} is pending${opts.lead !== undefined || opts.critic !== undefined ? ' for that critic' : ''}, so there is nothing to ${verb}.`, { ticket });
  if (found.length > 1) fail('usage', `${found.length} critics of ${ticket} have a pending round (${found.map((f) => `${f.critic}${f.same ? ' same' : ''} ${f.state.pending.subject} round ${f.state.pending.round}`).join(', ')}). Add --lead and --critic as in the critic call to pick one.`);
  return { ticket, ...found[0] };
}

// bollplank critic pending: the pending record and its text, after checking the text against its
// sha256. It never starts a client.
function pendingCommand(argv) {
  const { opts, positional, error } = parse(argv, PENDING_SPEC);
  if (error || positional.length) fail('usage', error ?? `unexpected ${positional[0]}. ${usage}`);
  const { ticket, file, critic, same, state } = pickPending(opts, 'print');
  const p = state.pending;
  const at = pendingFile(file, p.subject, p.round);
  let text;
  try {
    text = readFileSync(at, 'utf8');
  } catch (e) {
    fail('pending-corrupt', `the text of ${p.subject} round ${p.round} of ${ticket} cannot be read at ${at}: ${e.code ?? e.message}`, { ticket, critic, pending: p });
  }
  if (sha256(text) !== p.sha256) fail('pending-corrupt', `the stored text of ${p.subject} round ${p.round} of ${ticket} at ${at} no longer matches its sha256. Do not post it. Tell the approver.`, { ticket, critic, pending: p });
  emit({ ok: true, ticket, critic, same, pending: { ...p, file: at }, text });
}

// bollplank critic confirm: counts a pending round once the lead posted its text unchanged. The
// text, subject and round must match the pending record, or nothing changes.
async function confirmCommand(argv) {
  const { opts, positional, error } = parse(argv, CONFIRM_SPEC);
  if (error || positional.length) fail('usage', error ?? `unexpected ${positional[0]}. ${usage}`);
  const gap = missing(opts, ['ticket', 'subject', 'round', 'text-file', 'comment']);
  if (gap) fail('usage', `${gap}. ${usage}`);
  if (!SUBJECTS.includes(opts.subject)) fail('usage', `--subject must be one of ${SUBJECTS.join(', ')}`);
  if (!/^[1-9]\d*$/.test(opts.round)) fail('usage', '--round must be a whole number from 1');
  if (!opts.comment.trim()) fail('usage', '--comment must be the link of the posted comment');
  let text;
  try {
    text = readFileSync(opts['text-file'], 'utf8');
  } catch (e) {
    fail('usage', `cannot read the text file ${opts['text-file']}: ${e.code ?? e.message}`);
  }
  const { ticket, file, critic, same } = pickPending(opts, 'confirm');
  const subject = opts.subject;
  const round = Number(opts.round);
  const base = { ticket, critic, same, subject, round };
  const lock = await withLock(file, () => {
    // Read again under the lock, so a critic call or another confirm cannot interleave.
    const state = readState(file, base);
    const p = state.pending;
    if (!p) fail('no-pending', `no critic round of ${ticket} is pending any more.`, base);
    if (p.subject !== subject || p.round !== round) fail('confirm-mismatch', `the pending round of ${ticket} is ${p.subject} round ${p.round}, not ${subject} round ${round}. Nothing changed.`, { ...base, pending: { subject: p.subject, round: p.round } });
    if (sha256(text) !== p.sha256) fail('confirm-mismatch', `the text in ${opts['text-file']} is not the pending text of ${subject} round ${round}. Post the text from bollplank critic pending unchanged. Nothing changed.`, base);
    if (state.rounds[subject] + 1 !== round) fail('state', `${state.rounds[subject]} ${subject} rounds are saved, so ${subject} round ${round} cannot be counted. Nothing changed.`, base);
    // The round is counted as a posted round is, then the text goes.
    writeJsonAtomic(file, { sessionId: state.sessionId, rounds: { ...state.rounds, [subject]: round } });
    rmSync(pendingFile(file, subject, round), { force: true });
    emit({ ok: true, ...base, comment: opts.comment, counted: true });
  });
  if (lock.held) fail('critic-busy', `a critic call for ${ticket} with this critic is running. Wait for it, then confirm again. If none is running, remove the folder ${lock.lock}.`, base);
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
