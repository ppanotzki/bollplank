// bollplank merge <project> <repo> <pr> [--run <ticket folder>]
// Squash merge a PR only when every expected check is present and green on its head commit, and
// never with a failing or missing check. The expected checks come from the config, never from the
// PR itself.
//
// With --run, the merge also respects the run record. The record and the ticket folder must be
// for this project and repo, a selected plan or code review stage must be complete, and when the
// code stage is selected the PR head must carry the change its last approved round reviewed. A
// clean rebase keeps that change, so the two are compared by stable patch id, never by commit.
// The result (PR, final head, merge commit) is written back for removal.
//
// A project with privateScan also needs the private name scan of the PR head and of the PR title
// and body to pass. The squash commit then gets that scanned title and body as its message, so
// GitHub never writes unscanned text into history.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../args.mjs';
import { loadConfig, loadProject } from '../config.mjs';
import { writeJsonAtomic } from '../fsx.mjs';
import { emit, fail } from '../out.mjs';
import { expand } from '../paths.mjs';
import { baseBranch, firstLine, git, tryGit } from '../git.mjs';
import { scan, scanText } from '../private-scan.mjs';

export const usage = 'bollplank merge <project> <repo> <pr> [--run <ticket folder>]';

export function run(argv) {
  const { opts, positional, error } = parse(argv, { run: 'value' });
  const [projectName, repo, prArg, ...extra] = positional ?? [];
  if (error || !projectName || !repo || !prArg || extra.length) fail('usage', error ?? usage);
  if (!/^[1-9][0-9]*$/.test(prArg)) fail('usage', `${prArg} is not a PR number`);
  const pr = Number(prArg);
  const project = loadProject(loadConfig(), projectName);
  if (!Object.hasOwn(project.repos, repo)) fail('usage', `no repo ${repo} in ${projectName}`);
  const repoConfig = project.repos[repo];
  const slug = repoConfig.github;
  const expected = repoConfig.checks;
  const checkout = join(project.source, repo);
  const refuse = (failure, detail, extra = {}) => fail(failure, detail, { merged: false, repo, pr, ...extra });
  const gh = (...a) => {
    try {
      return execFileSync('gh', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (e) {
      refuse('gh-failed', `gh ${a.slice(0, 2).join(' ')} failed: ${firstLine(e)}`);
    }
  };
  const ghJson = (...a) => {
    const raw = gh(...a);
    try {
      return JSON.parse(raw);
    } catch {
      refuse('gh-failed', `gh ${a.slice(0, 2).join(' ')} did not return JSON`);
    }
  };
  const readJson = (file) => {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      refuse('corrupt', `${file} is not valid JSON: ${e.message}`, { file });
    }
  };

  const view = ghJson('pr', 'view', String(pr), '-R', slug, '--json', 'state,headRefOid,statusCheckRollup,isDraft,baseRefName,title,body');
  const head = view.headRefOid;
  const base = baseBranch(repoConfig, existsSync(checkout) ? checkout : null);
  if (view.state !== 'OPEN') refuse('not-open', `PR is ${view.state}`);
  if (view.isDraft) refuse('draft', 'PR is a draft');
  if (view.baseRefName !== base) refuse('wrong-base', `PR targets ${view.baseRefName}, not ${base}`, { base });

  const results = {};
  for (const name of expected) {
    const runs = (view.statusCheckRollup ?? []).filter((c) => (c.name ?? c.context) === name);
    if (!runs.length) results[name] = 'missing';
    else if (runs.some((c) => (c.status ?? 'COMPLETED') !== 'COMPLETED')) results[name] = 'not finished';
    else if (runs.every((c) => (c.conclusion ?? c.state) === 'SUCCESS')) results[name] = 'passed';
    else results[name] = `failed (${runs.map((c) => c.conclusion ?? c.state).join(', ')})`;
  }
  const bad = Object.entries(results).filter(([, r]) => r !== 'passed');
  if (bad.length) refuse('checks', bad.map(([n, r]) => `${n}: ${r}`).join(', '), { head, checks: results });

  let record = null;
  const folder = opts.run ? expand(opts.run) : null;
  const recordPath = folder ? join(folder, '.run.json') : null;
  if (recordPath) {
    if (!existsSync(recordPath)) refuse('no-run', `no run record at ${recordPath}`);
    record = readJson(recordPath);
    if (!record || typeof record !== 'object' || Array.isArray(record)) refuse('corrupt', `${recordPath} does not hold a run record object`, { file: recordPath });
    // The record and the ticket folder must be the ones this merge is for.
    if (record.project !== projectName) refuse('run-mismatch', `the run record at ${recordPath} is for project ${record.project ?? 'unknown'}, not ${projectName}`);
    const ticketPath = join(folder, '.ticket.json');
    if (!existsSync(ticketPath)) refuse('run-mismatch', `no ticket folder record at ${ticketPath}, so the run folder cannot be matched to ${repo}`);
    const ticketRecord = readJson(ticketPath);
    if (ticketRecord?.project !== projectName) refuse('run-mismatch', `${ticketPath} is for project ${ticketRecord?.project ?? 'unknown'}, not ${projectName}`);
    if (record.ticket && ticketRecord.ticket && record.ticket !== ticketRecord.ticket) refuse('run-mismatch', `the run record is for ${record.ticket} and the ticket folder for ${ticketRecord.ticket}`);
    if (ticketRecord.repos?.[repo]?.kind !== 'change') refuse('run-mismatch', `${repo} is not a repo this ticket changes. The ticket folder changes ${Object.entries(ticketRecord.repos ?? {}).filter(([, i]) => i?.kind === 'change').map(([r]) => r).join(', ') || 'no repo'}.`);
    for (const stage of ['plan', 'code']) {
      const st = record.stages?.[stage];
      if (st?.selected && !st.complete) refuse('stage-incomplete', `the selected ${stage} review stage is not complete`, { stage });
    }
  }
  const codeReview = record?.stages?.code?.selected ? record.stages.code : null;

  // The PR head lives on the remote as pull/<n>/head. The review check and the scan both read it.
  if (codeReview || project.privateScan) {
    const why = codeReview ? 'the code review check' : 'privateScan';
    if (!existsSync(checkout)) refuse(codeReview ? 'no-checkout' : 'private-scan', `${why} needs the source checkout ${checkout}`);
    try {
      git(checkout, 'fetch', '--quiet', 'origin');
      git(checkout, 'fetch', '--quiet', 'origin', `pull/${pr}/head`);
      git(checkout, 'cat-file', '-e', `${head}^{commit}`);
    } catch (e) {
      refuse(codeReview ? 'no-checkout' : 'private-scan', `could not fetch the PR head into ${checkout}: ${firstLine(e)}`);
    }
  }

  let review = null;
  if (codeReview) {
    // The stage is complete, so its last round is the one that approved it.
    const approved = codeReview.rounds?.at(-1)?.revision;
    const reopen = `Run \`bollplank run reopen ${projectName} ${record.ticket ?? '<TICKET>'} code --reason "the PR changed after review"\`, then review the PR head.`;
    const approvedSha = typeof approved === 'string' ? tryGit(checkout, 'rev-parse', '--verify', '--quiet', `${approved}^{commit}`) : null;
    if (!approvedSha) refuse('review-stale', `the last approved code round names ${approved ?? 'no revision'}, which is not a commit in ${checkout}. ${reopen}`, { head, approved: approved ?? null });
    const approvedPatch = patchId(checkout, `origin/${base}`, approvedSha);
    const headPatch = patchId(checkout, `origin/${base}`, head);
    review = { approved: approvedSha, approvedPatchId: approvedPatch, headPatchId: headPatch };
    if (!approvedPatch || !headPatch) refuse('review-stale', `git could not compare the approved revision ${approvedSha.slice(0, 12)} with the PR head ${head.slice(0, 12)} against origin/${base}. ${reopen}`, { head, review });
    if (approvedPatch !== headPatch) refuse('review-stale', `the PR head ${head.slice(0, 12)} is not the change the last approved code round reviewed (${approvedSha.slice(0, 12)}). ${reopen}`, { head, review });
  }

  let privateScan = null;
  let messageScan = null;
  if (project.privateScan) {
    privateScan = scan(checkout, head);
    if (privateScan.outcome !== 'passed') refuse('private-scan', `private name scan ${privateScan.outcome}${privateScan.reason ? `: ${privateScan.reason}` : ''}`, { head, privateScan });
    messageScan = scanText({ title: view.title ?? '', body: view.body ?? '' });
    if (messageScan.outcome !== 'passed') refuse('private-scan', `private name scan of the PR title and body ${messageScan.outcome}${messageScan.reason ? `: ${messageScan.reason}` : ''}`, { head, messageScan });
  }

  // --match-head-commit makes GitHub refuse the merge if the branch moved after the checks ran.
  // A scanned project names the squash message itself, from the title and body that were scanned.
  const message = project.privateScan ? ['--subject', `${view.title ?? ''} (#${pr})`, '--body', view.body ?? ''] : [];
  gh('pr', 'merge', String(pr), '-R', slug, '--squash', '--match-head-commit', head, ...message);
  const after = ghJson('pr', 'view', String(pr), '-R', slug, '--json', 'state,mergeCommit');
  if (after.state !== 'MERGED') refuse('not-merged', `merge did not complete, PR is ${after.state}`);
  const result = { merged: true, repo, pr, base, finalHead: head, mergeCommit: after.mergeCommit?.oid ?? null, checks: results, ...(review ? { review } : {}) };
  if (record) {
    record.repos = record.repos ?? {};
    record.repos[repo] = { ...(record.repos[repo] ?? {}), ...result, at: new Date().toISOString() };
    record.updated = new Date().toISOString();
    writeJsonAtomic(recordPath, record);
  }
  emit({
    ok: true,
    ...result,
    ...(privateScan ? { privateScan: { outcome: privateScan.outcome, source: privateScan.source }, messageScan: { outcome: messageScan.outcome, source: messageScan.source } } : {}),
  });
}

// The stable patch id of the change from where sha left base up to sha. A rebase that applies
// cleanly keeps it, and any change to the diff gives another one. null when git cannot tell.
export function patchId(dir, base, sha) {
  try {
    const mergeBase = git(dir, 'merge-base', base, sha);
    const diff = execFileSync('git', ['-C', dir, 'diff', '--no-color', '--no-ext-diff', '--no-textconv', mergeBase, sha], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
    if (!diff.trim()) return 'empty';
    const out = execFileSync('git', ['-C', dir, 'patch-id', '--stable'], { input: diff, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 20 });
    return out.trim().split(/\s+/)[0] || 'empty';
  } catch {
    return null;
  }
}
