// bollplank run <cmd> <project> <TICKET> [<stage or repo>] [options]
// The run record: .run.json in the ticket folder. It is what makes a ticket folder a run, what a
// resumed run reads before it acts, and what removal trusts after a squash merge.
//
// Repository projects:
//   init --review none|plan|code|both [--critic other|same|claude|codex]
//   stage plan|code --revision <sha or version> --verdict Approve|Revise [--points n] [--complete]
//   reopen plan|code --reason <text>
//   gate plan|code          exits 0 when the stage is not selected or is complete
//   deploy <repo> --kind <kind> --status <status> [--ref <job or stack>] [--commit <sha>]
//                           kind: none, command, amplify, github-actions, merge or release
//                           status: succeeded, failed, timeout or running, as deploy-wait reports
//   plan --commit <sha> [--path <file>]
//   log --event <text>
//   show
//
// Consulting and configuration projects go to lib/configuration-run.mjs, which keeps an evidence
// journal: check, init, plan, code, stage, reopen, gate, change, verify, complete, rebaseline,
// log and show.
//
// A stage counts as complete only when its last round is Approve, or the lead marked it complete
// after sorting every material point into fix, flag or drop and the critic confirmed. A later
// change to covered behaviour reopens it.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../args.mjs';
import { loadConfig, loadProject, CRITICS } from '../config.mjs';
import { writeJsonAtomic } from '../fsx.mjs';
import { emit, fail } from '../out.mjs';
import { ticketId } from '../git.mjs';
import { configurationRun, RunError } from '../configuration-run.mjs';

// The deploy kinds and statuses a run record accepts. deploy-wait reports the same statuses.
export const DEPLOY_RECORD_KINDS = ['none', 'command', 'amplify', 'github-actions', 'merge', 'release'];
export const DEPLOY_STATUSES = ['succeeded', 'failed', 'timeout', 'running'];

export const usage = 'bollplank run init|stage|reopen|gate|deploy|plan|log|show <project> <TICKET> [<stage or repo>] [options]. Consulting and configuration projects also take check, code, change, verify, complete and rebaseline.';

// One spec for both modes, since the parser refuses options it does not know.
const spec = {
  review: 'value', critic: 'value', revision: 'value', verdict: 'value', points: 'value', complete: 'bool',
  reason: 'value', kind: 'value', ref: 'value', commit: 'value', status: 'value', path: 'value', event: 'value',
  brief: 'value', approval: 'value', instruction: 'value', 'board-readback': 'value', 'linear-readback': 'value',
  authorization: 'value', 'scope-evidence': 'value', evidence: 'value', gate: 'value', id: 'value', target: 'value',
  residual: 'value', replacement: 'value', check: 'value',
};

export function run(argv) {
  const { opts, positional, error } = parse(argv, spec);
  const [cmd, projectName, ticketArg, ...rest] = positional ?? [];
  if (error || !cmd || !projectName || !ticketArg) fail('usage', error ?? usage);
  const ticket = ticketId(ticketArg);
  if (!ticket) fail('usage', `${ticketArg} is not a ticket id like ACME-1`);
  const config = loadConfig();
  const project = loadProject(config, projectName);
  if (project.mode === 'consulting' || project.mode === 'configuration') {
    const { name, ...profile } = project;
    let result;
    try {
      result = configurationRun({ cmd, project: name, ticket, profile, opts, positional: rest, approver: config.approver.name, boardKind: config.board.kind });
    } catch (e) {
      if (e instanceof RunError) fail(e.failure, e.message);
      // A record or evidence file that is not valid JSON is a failure to report, never a crash.
      if (e instanceof SyntaxError) fail('corrupt', `a JSON file of the ${ticket} run in ${join(profile.tickets, ticket)} could not be read: ${e.message}`);
      throw e;
    }
    emit(result);
  }
  repositoryRun({ cmd, project, ticket, opts, positional: rest });
}

function repositoryRun({ cmd, project, ticket, opts, positional }) {
  const folder = join(project.tickets, ticket);
  const path = join(folder, '.run.json');
  const now = () => new Date().toISOString();
  const load = () => {
    if (!existsSync(path)) fail('no-run', `no run record at ${path}`);
    let r;
    try {
      r = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      fail('corrupt', `${path} is not valid JSON: ${e.message}. Fix it by hand or restore it before the run goes on.`, { file: path });
    }
    if (!r || typeof r !== 'object' || Array.isArray(r)) fail('corrupt', `${path} does not hold a run record object`, { file: path });
    // Older or hand written records may lack the newer fields.
    r.repos ??= {};
    r.deploys ??= [];
    r.log ??= [];
    r.stages ??= {};
    for (const s of ['plan', 'code']) r.stages[s] = { selected: false, complete: false, rounds: [], ...(r.stages[s] ?? {}) };
    return r;
  };
  const save = (r) => {
    r.updated = now();
    writeJsonAtomic(path, r);
  };

  if (cmd === 'init') {
    if (project.runs !== true) fail('runs-disabled', `ticket runs are disabled for ${project.name}. Set runs to true in its config.`);
    if (!existsSync(join(folder, '.ticket.json'))) fail('no-ticket-folder', `create the ticket folder first with bollplank ticket create ${project.name} ${ticket}`);
    if (existsSync(path)) emit({ ok: true, note: 'run record exists, resume from it', record: load() });
    const review = opts.review;
    if (!['none', 'plan', 'code', 'both'].includes(review)) fail('usage', '--review must be none, plan, code or both, from the brief header');
    if (opts.critic !== undefined && !CRITICS.includes(opts.critic)) fail('usage', `--critic must be one of ${CRITICS.join(', ')}`);
    const r = {
      project: project.name,
      ticket,
      started: now(),
      review,
      critic: opts.critic ?? null,
      stages: {
        plan: { selected: review === 'plan' || review === 'both', complete: false, rounds: [] },
        code: { selected: review === 'code' || review === 'both', complete: false, rounds: [] },
      },
      repos: {},
      deploys: [],
      log: [{ at: now(), event: 'run started' }],
    };
    save(r);
    emit({ ok: true, record: r });
  }
  if (cmd === 'stage' || cmd === 'reopen' || cmd === 'gate') {
    const name = positional[0];
    if (!['plan', 'code'].includes(name)) fail('usage', 'stage must be plan or code');
    const r = load();
    const st = r.stages[name];
    if (cmd === 'gate') {
      if (!st.selected) emit({ ok: true, stage: name, selected: false });
      if (st.complete) emit({ ok: true, stage: name, selected: true, complete: true, lastRound: st.rounds.at(-1) ?? null });
      fail('stage-incomplete', `the ${name} review stage is not complete`, { stage: name, selected: true, complete: false, lastRound: st.rounds.at(-1) ?? null });
    }
    if (!st.selected) fail('not-selected', `the ${name} stage is not selected for this ticket`);
    if (cmd === 'reopen') {
      st.complete = false;
      r.log.push({ at: now(), event: `${name} stage reopened`, reason: opts.reason ?? null });
      save(r);
      emit({ ok: true, stage: name, complete: false });
    }
    if (!opts.revision || !['Approve', 'Revise'].includes(opts.verdict)) fail('usage', '--revision and --verdict Approve|Revise are required');
    if (opts.points !== undefined && !/^\d+$/.test(opts.points)) fail('usage', '--points must be a number');
    st.rounds.push({ at: now(), revision: opts.revision, verdict: opts.verdict, points: opts.points !== undefined ? Number(opts.points) : null });
    st.complete = opts.verdict === 'Approve' || opts.complete === true;
    r.log.push({ at: now(), event: `${name} review round ${st.rounds.length}: ${opts.verdict}${st.complete ? ', stage complete' : ''}` });
    save(r);
    emit({ ok: true, stage: name, complete: st.complete, rounds: st.rounds.length });
  }
  if (cmd === 'deploy') {
    const repo = positional[0];
    if (!repo || !opts.kind || !opts.status) fail('usage', 'bollplank run deploy <project> <TICKET> <repo> --kind <kind> --status <status> [--ref <ref>] [--commit <sha>]');
    if (!DEPLOY_RECORD_KINDS.includes(opts.kind)) fail('usage', `--kind must be one of ${DEPLOY_RECORD_KINDS.join(', ')}`);
    if (!DEPLOY_STATUSES.includes(opts.status)) fail('usage', `--status must be one of ${DEPLOY_STATUSES.join(', ')}, as deploy-wait reports`);
    const r = load();
    const entry = { at: now(), repo, kind: opts.kind, ref: opts.ref ?? null, commit: opts.commit ?? null, status: opts.status };
    const i = r.deploys.findIndex((d) => d.repo === repo && d.kind === entry.kind && d.ref === entry.ref);
    if (i >= 0) r.deploys[i] = entry;
    else r.deploys.push(entry);
    r.log.push({ at: now(), event: `${repo} ${entry.kind} ${entry.ref ?? ''} ${entry.status}`.replace(/\s+/g, ' ') });
    save(r);
    emit({ ok: true, deploy: entry });
  }
  if (cmd === 'plan') {
    if (!opts.commit) fail('usage', 'bollplank run plan <project> <TICKET> --commit <sha> [--path <file>]');
    const r = load();
    r.plan = { commit: opts.commit, path: opts.path ?? null, at: now() };
    r.log.push({ at: now(), event: `plan committed at ${opts.commit}` });
    save(r);
    emit({ ok: true, plan: r.plan });
  }
  if (cmd === 'log') {
    if (!opts.event) fail('usage', 'bollplank run log <project> <TICKET> --event <text>');
    const r = load();
    r.log.push({ at: now(), event: opts.event });
    save(r);
    emit({ ok: true, entries: r.log.length });
  }
  if (cmd === 'show') emit({ ok: true, record: load() });
  fail('usage', `unknown run command ${cmd}. ${usage}`);
}
