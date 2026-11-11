import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { asWritten } from './config.mjs';
import { BOARDS, isBoardKind } from './boards.mjs';
import { expand } from './paths.mjs';
import { firstDifference } from './jira-text.mjs';

// The run journal for consulting and configuration projects. It never calls external services.
// The lead verifies live identities and authority and passes the evidence in as files.
//
// A failure throws a RunError whose failure code becomes the JSON result's failure.
export class RunError extends Error {
  constructor(message, failure = 'refused') {
    super(message);
    this.failure = failure;
  }
}

export const CRITIC_CHOICES = ['other', 'same', 'claude', 'codex'];
// The board's name in messages, by kind. A kind Bollplank does not know is named as written.
const boardName = (kind) => (isBoardKind(kind) ? BOARDS[kind].label : kind);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// approver is config.approver.name. boardKind is the project's resolved board kind (kindOf), which
// names the readback. The readback has one shape for every kind. On Linear id is the issue
// identifier, teamId the team and projectId the project. On Jira id is the issue key, teamId the
// cloud id and projectId the numeric project id.
export function configurationRun({ cmd, project, ticket, profile, opts, positional = [], approver, boardKind = 'linear' }) {
  const fail = (message, failure) => {
    throw new RunError(message, failure);
  };
  if (typeof approver !== 'string' || !approver.trim()) fail('approver.name is required', 'config');
  const board = boardName(boardKind);
  const required = (key) => (typeof opts[key] === 'string' && opts[key].trim() ? opts[key] : fail(`--${key} is required`, 'usage'));
  const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
  const stamp = () => new Date().toISOString();
  const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const evidence = (path) => {
    if (!existsSync(path)) fail(`no file at ${path}`, 'usage');
    return { path: resolve(path), sha256: digest(path) };
  };
  const intact = (entry) => entry && existsSync(entry.path) && digest(entry.path) === entry.sha256;
  const consulting = profile.mode === 'consulting';
  const mode = consulting ? 'consulting' : 'configuration';
  const prefix = profile.ticketPrefix;
  const allowed = consulting
    ? typeof prefix === 'string' && /^[A-Z][A-Z0-9_]*$/.test(prefix) && new RegExp(`^${prefix}-[1-9][0-9]*$`).test(ticket)
    : /^[A-Z][A-Z0-9_]*-\d+$/.test(ticket) && profile.allowedTickets?.includes(ticket);
  if (!allowed) fail(`ticket is not enabled for ${mode} runs`, 'ticket-not-enabled');
  // Eligibility lives in the project config. There is no separate runs file.
  if (profile.runs !== true) fail(`ticket runs are disabled for ${project}. Set runs to true in its config.`, 'runs-disabled');
  const stages = (review) => ({
    plan: { selected: review === 'plan' || review === 'both', complete: false, rounds: [] },
    ...(consulting ? { code: { selected: review === 'code' || review === 'both', complete: false, rounds: [] } } : {}),
  });
  const folder = join(expand(profile.tickets), ticket);
  const file = join(folder, '.run.json');
  const result = { ok: true, mode, project, ticket, folder, targets: profile.targets };
  if (cmd === 'check') return { ...result, exists: existsSync(file) };
  const save = (record) => {
    record.updated = stamp();
    const tmp = file + '.tmp';
    writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
    // The caller serializes commands within one coordinating session.
    renameSync(tmp, file);
    return { ...result, record };
  };
  // The profile as the config file wrote it, so a change to the top level statuses or another
  // project never stops a run.
  const profileHash = createHash('sha256').update(JSON.stringify(asWritten(profile))).digest('hex');
  const readback = () => opts['board-readback'] ?? opts['linear-readback'] ?? fail('--board-readback is required', 'usage');
  const readBaseline = () => {
    const brief = evidence(required('brief'));
    const text = readFileSync(brief.path, 'utf8');
    const approval = required('approval');
    const review = required('review');
    if (!(consulting ? ['none', 'plan', 'code', 'both'] : ['none', 'plan']).includes(review)) fail(`${mode} mode does not support review ${review}`, 'usage');
    const approved = text.match(new RegExp(`^Approval: Approved by ${escapeRe(approver)} on .+`, 'm'))?.[0];
    if (!approved) fail('current brief is not approved');
    if (!new RegExp(`^Cross-model review: ${review}(?:[.\\s]|$)`, 'm').test(text)) fail('review differs from approved brief');
    // The optional critic line sits on its own line, so the review check above stays unchanged.
    const criticLine = text.match(/^Critic: *(\S*)/m);
    if (criticLine && !CRITIC_CHOICES.includes(criticLine[1].replace(/\.$/, ''))) fail(`the brief's Critic line must be one of ${CRITIC_CHOICES.join(', ')}`);
    const critic = criticLine ? criticLine[1].replace(/\.$/, '') : null;
    const version = text.match(/^Brief v[1-9][0-9]*$/m)?.[0];
    if (!version) fail('brief version is missing');
    const liveEvidence = evidence(readback());
    const live = read(liveEvidence.path);
    const age = Date.now() - Date.parse(live.observedAt);
    if (!Number.isFinite(age) || age < -60000 || age > 15 * 60 * 1000) fail(`${board} readback must be freshly observed within 15 minutes`);
    if (!profile.board?.teamId || !profile.board?.projectId || live.id !== ticket || !sameId(live.teamId, profile.board.teamId) || !sameId(live.projectId, profile.board.projectId)) fail(`${board} readback identity mismatch`);
    // Jira's markdown readback rewrites line ends and bullets, so on Jira the approved brief and the
    // live text are compared allowing those rewrites only. Linear keeps its comparison.
    const same = (got) => (boardKind === 'jira' ? firstDifference(text, got) === null : got.trimEnd() === text.trimEnd());
    if (typeof live.description !== 'string' || !same(live.description)) fail(`brief differs from current ${board} readback`);
    return { brief, approval, review, critic, version, liveEvidence, profileHash, agents: agentsEvidence(), at: stamp() };
  };
  // The project's AGENTS.md the run reads: <source>/AGENTS.md on disk, in a Git source as well, so
  // the copy is the exact bytes the run used. Optional, so existing calls keep working.
  const agentsEvidence = () => {
    if (opts.agents === undefined) return null;
    const given = required('agents');
    const real = (path) => {
      try {
        return realpathSync(path);
      } catch {
        return null;
      }
    };
    const source = typeof profile.source === 'string' ? real(expand(profile.source)) : null;
    const expected = typeof profile.source === 'string' ? real(join(expand(profile.source), 'AGENTS.md')) : null;
    const actual = real(given);
    if (!source || !expected || actual !== expected) fail(`--agents must be the project's AGENTS.md in its source folder (${profile.source ? join(profile.source, 'AGENTS.md') : 'no source configured'})`);
    // A link out of the source folder is refused, since acceptance refuses it too.
    const inside = relative(source, actual);
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) fail('AGENTS.md resolves outside the source folder');
    let bytes;
    try {
      if (!statSync(actual).isFile()) fail('AGENTS.md is not a file');
      bytes = readFileSync(actual);
    } catch (e) {
      if (e instanceof RunError) throw e;
      fail(`AGENTS.md cannot be read: ${e.code ?? e.message}`);
    }
    if (!bytes.length) fail('AGENTS.md is empty');
    return { source: actual, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  // The AGENTS.md copy a new baseline keeps: the given file, or else the prior baseline's copy
  // carried forward, so a rebaseline without --agents never drops it. Null only for a run that
  // never recorded one.
  // The bytes are read once and written as they were hashed, so a file saved in between cannot
  // leave a copy that differs from its recorded hash.
  const agentsSource = (candidate, prior) => {
    if (candidate.agents) return candidate.agents;
    if (!prior?.agents) return null;
    const bytes = existsSync(prior.agents.path) ? readFileSync(prior.agents.path) : null;
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== prior.agents.sha256) fail('prior AGENTS.md evidence changed or missing');
    return { source: prior.agents.source, bytes, sha256: prior.agents.sha256 };
  };
  const retainBaseline = (baseline, number, agents) => {
    const dir = join(folder, `baseline-${number}`);
    if (existsSync(dir)) fail('baseline snapshot already exists. Follow Interrupted local save in the configuration reference before retrying');
    mkdirSync(dir, { recursive: true });
    copyFileSync(baseline.brief.path, join(dir, 'approved-brief.md'));
    copyFileSync(baseline.liveEvidence.path, join(dir, 'board-readback.json'));
    let agentsCopy = null;
    if (agents) {
      writeFileSync(join(dir, 'agents.md'), agents.bytes);
      agentsCopy = { source: agents.source, path: resolve(join(dir, 'agents.md')), sha256: agents.sha256 };
    }
    return { ...baseline, number, brief: evidence(join(dir, 'approved-brief.md')), liveEvidence: evidence(join(dir, 'board-readback.json')), agents: agentsCopy, profile: JSON.parse(JSON.stringify(profile)) };
  };
  if (cmd === 'init') {
    if (existsSync(file)) return { ...result, resume: true, record: read(file) };
    const instruction = required('instruction');
    const candidate = readBaseline();
    const baseline = retainBaseline(candidate, 1, agentsSource(candidate, null));
    return save({
      mode, project, ticket, started: stamp(), status: 'In Progress',
      brief: baseline.brief, approval: baseline.approval, instruction, review: baseline.review, critic: baseline.critic, agents: baseline.agents,
      profileHash, baseline: 1, baselines: [baseline], amendments: [],
      plan: null, ...(consulting ? { code: null } : {}), stages: stages(baseline.review),
      changes: [], verification: {}, log: [],
    });
  }
  if (!existsSync(file)) fail('no configuration run record', 'no-run');
  const r = read(file);
  if (r.ticket !== ticket || r.project !== project || (r.mode !== mode && !(consulting && r.mode === 'configuration' && cmd === 'show'))) fail('run identity mismatch');
  if (cmd === 'show') return { ...result, record: r };
  if (cmd === 'log') {
    r.log.push({ at: stamp(), event: required('event') });
    return save(r);
  }
  if (!intact(r.brief)) fail('approved brief evidence changed or missing');
  if (cmd === 'rebaseline') {
    const reason = required('reason');
    const authorization = required('authorization');
    const scopeEvidence = evidence(required('scope-evidence'));
    const candidate = readBaseline();
    const current = r.baselines.at(-1);
    if (!intact(current.liveEvidence)) fail(`prior ${board} evidence changed or missing`);
    const agents = agentsSource(candidate, current);
    if (candidate.brief.sha256 === r.brief.sha256 && candidate.profileHash === r.profileHash && (agents?.sha256 ?? null) === (current.agents?.sha256 ?? null)) fail('baseline is unchanged');
    const baseline = retainBaseline(candidate, r.baseline + 1, agents);
    r.amendments.push({ at: stamp(), from: r.baseline, to: baseline.number, reason, authorization, scopeEvidence, previousPlan: r.plan, previousStages: r.stages, previousVerification: r.verification });
    r.baselines.push(baseline);
    Object.assign(r, {
      baseline: baseline.number, brief: baseline.brief, approval: baseline.approval, review: baseline.review, critic: baseline.critic, agents: baseline.agents,
      profileHash, plan: null, ...(consulting ? { code: null } : {}), stages: stages(baseline.review),
      verification: {}, status: 'In Progress',
    });
    r.log.push({ at: stamp(), event: 'rebaseline', reason, authorization });
    return save(r);
  }
  if (r.profileHash !== profileHash) fail('profile changed during run, reconcile scope before continuing');
  const gate = (name = 'plan') => {
    if (name === 'code') {
      if (!consulting) fail('code gate requires consulting mode');
      gate('plan');
      if (!r.stages.code.selected) return;
    } else if (name !== 'plan') fail('unknown review stage', 'usage');
    const subject = name === 'plan' ? r.plan : r.code;
    const stage = r.stages[name];
    if (!intact(subject)) fail(`recorded ${name} subject changed or missing`);
    if (stage.selected && !stage.complete) fail(`${name} review is incomplete`, 'stage-incomplete');
    const last = stage.rounds.at(-1);
    if (stage.selected && (!intact(last?.evidence) || last.revision !== subject.sha256)) fail('review evidence changed or stale');
  };
  if (cmd === 'plan') {
    r.status = 'In Progress';
    r.plan = evidence(required('path'));
    r.stages.plan.complete = false;
    if (consulting) {
      r.code = null;
      r.stages.code.complete = false;
    }
    r.verification = {};
  } else if (cmd === 'code' && consulting) {
    gate();
    r.code = evidence(required('path'));
    r.stages.code.complete = false;
    r.verification = {};
    r.status = 'In Progress';
  } else if (cmd === 'stage') {
    const name = positional[0];
    if (!Object.hasOwn(r.stages, name) || !r.stages[name].selected) fail('only a selected review stage is supported');
    if (name === 'code') gate();
    const subject = name === 'plan' ? r.plan : r.code;
    if (!intact(subject) || required('revision') !== subject.sha256) fail(`review must cover the current ${name} hash`);
    const verdict = required('verdict');
    if (!['Approve', 'Revise'].includes(verdict)) fail('invalid verdict', 'usage');
    const reviewEvidence = evidence(required('evidence'));
    r.stages[name].rounds.push({ revision: subject.sha256, verdict, evidence: reviewEvidence, at: stamp() });
    r.stages[name].complete = verdict === 'Approve';
    if (verdict === 'Revise') r.status = 'In Progress';
  } else if (cmd === 'reopen') {
    required('reason');
    const name = positional[0] ?? 'plan';
    if (!Object.hasOwn(r.stages, name)) fail('unknown review stage', 'usage');
    r.status = 'In Progress';
    r.stages[name].complete = false;
    if (consulting && name === 'plan') r.stages.code.complete = false;
    r.verification = {};
  } else if (cmd === 'gate') {
    gate(positional[0]);
    return { ...result, complete: true };
  } else if (cmd === 'change') {
    gate(opts.gate ?? 'plan');
    const id = required('id');
    const status = required('status');
    const target = required('target');
    if (!Object.hasOwn(profile.targets ?? {}, target)) fail('target is outside the configured scope');
    if (!['intent', 'verified', 'failed', 'superseded'].includes(status)) fail('invalid change status', 'usage');
    const e = evidence(required('evidence'));
    const previous = r.changes.find((c) => c.id === id);
    if (previous && previous.target !== target) fail('operation identity conflicts with recorded target');
    if (['verified', 'superseded'].includes(previous?.status)) fail('operation already verified or superseded, inspect reality rather than replaying');
    if (!previous && status !== 'intent') fail('record intent with before evidence before external action');
    if (previous && status === 'intent') fail('operation already recorded, reconcile reality before retrying');
    let resolution = null;
    if (status === 'superseded') {
      const reason = required('reason');
      const residual = required('residual');
      if (!['none', 'corrected'].includes(residual)) fail('residual must be none or corrected', 'usage');
      const replacement = residual === 'corrected' ? required('replacement') : null;
      if (replacement) {
        const corrective = r.changes.find((c) => c.id === replacement);
        if (!corrective || corrective.id === id || corrective.status !== 'verified' || !intact(corrective.after)) fail('corrective operation must already be verified');
      }
      resolution = { reason, residual, replacement, evidence: e };
    }
    const event = { status, evidence: e, resolution, at: stamp() };
    if (previous) {
      Object.assign(previous, { status, after: e, resolution, updated: stamp() });
      previous.events.push(event);
    } else r.changes.push({ id, target, status, before: e, baseline: r.baseline, at: stamp(), events: [event] });
    r.verification = {};
    r.status = 'In Progress';
  } else if (cmd === 'verify') {
    gate();
    const check = required('check');
    if (!profile.verificationChecks.includes(check)) fail('unknown verification check', 'usage');
    const status = required('status');
    if (!['pass', 'fail'].includes(status)) fail('verification status must be pass or fail', 'usage');
    r.verification[check] = { status, evidence: evidence(required('evidence')), plan: r.plan.sha256, at: stamp() };
    if (status === 'fail') r.status = 'In Progress';
  } else if (cmd === 'complete') {
    gate();
    if (consulting) gate('code');
    const review = r.stages.plan.rounds.at(-1);
    if (r.stages.plan.selected && (!intact(review?.evidence) || review.revision !== r.plan.sha256)) fail('review evidence changed or stale');
    const resolved = (c) => {
      if (!intact(c.before) || !intact(c.after) || c.events.some((e) => !intact(e.evidence))) return false;
      if (c.status === 'verified') return true;
      if (c.status !== 'superseded' || !c.resolution?.reason || !intact(c.resolution.evidence)) return false;
      if (c.resolution.residual === 'none') return true;
      const corrective = r.changes.find((x) => x.id === c.resolution.replacement);
      return c.resolution.residual === 'corrected' && corrective?.status === 'verified' && intact(corrective.after);
    };
    if (!r.changes.some((c) => c.status === 'verified') || r.changes.some((c) => !resolved(c))) fail('changes lack verified or safely superseded intact evidence');
    for (const baseline of r.baselines) {
      if (!intact(baseline.brief) || !intact(baseline.liveEvidence) || (baseline.agents && !intact(baseline.agents))) fail('baseline evidence changed or missing');
    }
    for (const amendment of r.amendments) {
      if (!intact(amendment.scopeEvidence)) fail('amendment scope evidence changed or missing');
    }
    for (const check of profile.verificationChecks) {
      const v = r.verification[check];
      if (!v || v.status !== 'pass' || v.plan !== r.plan.sha256 || !intact(v.evidence)) fail(`verification incomplete: ${check}`);
    }
    r.status = 'Acceptance';
  } else fail(`unsupported ${mode} command ${cmd}`, 'usage');
  r.log.push({ at: stamp(), event: cmd, detail: opts.event ?? opts.reason ?? null });
  return save(r);
}

// Whether two board ids are the same, compared as text, so a numeric project id read back as a
// number matches the one the config writes as a string. Only text and numbers are ids.
function sameId(a, b) {
  const id = (v) => (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)) ? String(v) : null);
  return id(a) !== null && id(a) === id(b);
}
