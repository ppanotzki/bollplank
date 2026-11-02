// bollplank merge <project> <repo> <pr> [--run <ticket folder>]
// Squash merge a PR only when every expected check is present and green on its head commit, and
// never with a failing or missing check. The expected checks come from the config, never from the
// PR itself.
//
// With --run, the merge also respects the run record: a selected plan or code review stage must
// be complete, and the result (PR, final head, merge commit) is written back for removal.
// A project with privateScan also needs the private name scan of the PR head to pass.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../args.mjs';
import { loadConfig, loadProject } from '../config.mjs';
import { emit, fail } from '../out.mjs';
import { expand } from '../paths.mjs';
import { baseBranch, firstLine, git } from '../git.mjs';
import { scan } from '../private-scan.mjs';

export const usage = 'bollplank merge <project> <repo> <pr> [--run <ticket folder>]';

export function run(argv) {
  const { opts, positional, error } = parse(argv, { run: 'value' });
  const [projectName, repo, prArg, ...extra] = positional ?? [];
  if (error || !projectName || !repo || !prArg || extra.length) fail('usage', error ?? usage);
  if (!/^[1-9][0-9]*$/.test(prArg)) fail('usage', `${prArg} is not a PR number`);
  const pr = Number(prArg);
  const project = loadProject(loadConfig(), projectName);
  const repoConfig = project.repos[repo];
  if (!repoConfig) fail('usage', `no repo ${repo} in ${projectName}`);
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

  const view = ghJson('pr', 'view', String(pr), '-R', slug, '--json', 'state,headRefOid,statusCheckRollup,isDraft,baseRefName');
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
  if (bad.length) refuse('checks', bad.map(([n, r]) => `${n}: ${r}`).join(', '), { head: view.headRefOid, checks: results });

  let record = null;
  const recordPath = opts.run ? join(expand(opts.run), '.run.json') : null;
  if (recordPath) {
    if (!existsSync(recordPath)) refuse('no-run', `no run record at ${recordPath}`);
    record = JSON.parse(readFileSync(recordPath, 'utf8'));
    for (const stage of ['plan', 'code']) {
      const st = record.stages?.[stage];
      if (st?.selected && !st.complete) refuse('stage-incomplete', `the selected ${stage} review stage is not complete`, { stage });
    }
  }

  let privateScan = null;
  if (project.privateScan) {
    if (!existsSync(checkout)) refuse('private-scan', `privateScan needs the source checkout ${checkout}`);
    try {
      git(checkout, 'fetch', '--quiet', 'origin', `pull/${pr}/head`);
      git(checkout, 'cat-file', '-e', `${view.headRefOid}^{commit}`);
    } catch (e) {
      refuse('private-scan', `could not fetch the PR head into ${checkout}: ${firstLine(e)}`);
    }
    privateScan = scan(checkout, view.headRefOid);
    if (privateScan.outcome !== 'passed') refuse('private-scan', `private name scan ${privateScan.outcome}${privateScan.reason ? `: ${privateScan.reason}` : ''}`, { head: view.headRefOid, privateScan });
  }

  // --match-head-commit makes GitHub refuse the merge if the branch moved after the checks ran.
  gh('pr', 'merge', String(pr), '-R', slug, '--squash', '--match-head-commit', view.headRefOid);
  const after = ghJson('pr', 'view', String(pr), '-R', slug, '--json', 'state,mergeCommit');
  if (after.state !== 'MERGED') refuse('not-merged', `merge did not complete, PR is ${after.state}`);
  const result = { merged: true, repo, pr, base, finalHead: view.headRefOid, mergeCommit: after.mergeCommit?.oid ?? null, checks: results };
  if (record) {
    record.repos = record.repos ?? {};
    record.repos[repo] = { ...(record.repos[repo] ?? {}), ...result, at: new Date().toISOString() };
    record.updated = new Date().toISOString();
    writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n');
  }
  emit({ ok: true, ...result, ...(privateScan ? { privateScan: { outcome: privateScan.outcome, source: privateScan.source } } : {}) });
}
