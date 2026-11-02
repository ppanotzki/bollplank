// bollplank deploy-wait <project> <repo> <commit> [--timeout <seconds>] [--interval <seconds>]
// Wait for the deploy of one commit and report how it ended. It reads the repo's deploy setting:
//
//   none            returns at once
//   command         runs the command with {commit} replaced and uses its exit code
//   amplify         waits for the Amplify job whose commitId is the commit, never "the latest job"
//   github-actions  waits for the named workflow's run on the commit
//
// Exit 0 when the deploy succeeded, 1 on any other end or on timeout. The timeout defaults to
// 1800 seconds and the poll interval to 15.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../args.mjs';
import { loadConfig, loadProject } from '../config.mjs';
import { emit, fail } from '../out.mjs';
import { baseBranch, firstLine } from '../git.mjs';

export const usage = 'bollplank deploy-wait <project> <repo> <commit> [--timeout <seconds>] [--interval <seconds>]';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sameCommit = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length >= 7 && (a.startsWith(b) || b.startsWith(a));

export async function run(argv) {
  const { opts, positional, error } = parse(argv, { timeout: 'value', interval: 'value' });
  const [projectName, repo, commit, ...extra] = positional ?? [];
  if (error || !projectName || !repo || !commit || extra.length) fail('usage', error ?? usage);
  // The commit goes into a command line, so only a hex commit id is accepted.
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) fail('usage', `${commit} is not a commit id`);
  const seconds = (name, fallback) => {
    if (opts[name] === undefined) return fallback;
    const n = Number(opts[name]);
    if (!Number.isFinite(n) || n < 0) fail('usage', `--${name} must be a number of seconds`);
    return n;
  };
  const timeoutMs = seconds('timeout', 1800) * 1000;
  const intervalMs = seconds('interval', 15) * 1000;
  const project = loadProject(loadConfig(), projectName);
  const repoConfig = project.repos[repo];
  if (!repoConfig) fail('usage', `no repo ${repo} in ${projectName}`);
  const deploy = repoConfig.deploy ?? { kind: 'none' };
  const checkout = join(project.source, repo);
  const started = Date.now();
  const minutes = () => Math.round((Date.now() - started) / 60000);
  const base = { project: projectName, repo, commit, kind: deploy.kind };
  const done = (o) => emit({ ...base, ...o, minutes: minutes() });

  if (deploy.kind === 'none') emit({ ok: true, ...base, note: 'this repo has no deploy to wait for' });

  if (deploy.kind === 'command') {
    const command = deploy.command.replaceAll('{commit}', commit);
    const r = spawnSync(command, { shell: true, cwd: existsSync(checkout) ? checkout : undefined, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1 << 26 });
    const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-20).join('\n');
    if (r.error?.code === 'ETIMEDOUT') done({ ok: false, failure: 'timeout', command, detail: `the command ran longer than ${timeoutMs / 1000} seconds`, output: tail });
    if (r.error) done({ ok: false, failure: 'command-failed', command, detail: r.error.message });
    done({ ok: r.status === 0, ...(r.status === 0 ? {} : { failure: 'deploy-failed' }), command, exitCode: r.status, output: tail });
  }

  if (deploy.kind === 'amplify') {
    const branch = deploy.branch ?? baseBranch(repoConfig, existsSync(checkout) ? checkout : null);
    const env = { ...process.env, ...(deploy.profile ? { AWS_PROFILE: deploy.profile } : {}) };
    const where = { appId: deploy.appId, branch, region: deploy.region };
    while (true) {
      let jobs = [];
      try {
        const raw = execFileSync('aws', ['amplify', 'list-jobs', '--app-id', deploy.appId, '--branch-name', branch, '--max-items', '10', '--region', deploy.region, '--output', 'json'], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
        jobs = JSON.parse(raw).jobSummaries ?? [];
      } catch (e) {
        done({ ok: false, failure: 'aws-failed', ...where, detail: `aws amplify list-jobs failed: ${firstLine(e)}` });
      }
      const job = jobs.find((j) => sameCommit(j.commitId, commit));
      if (job && ['SUCCEED', 'FAILED', 'CANCELLED'].includes(job.status)) {
        done({ ok: job.status === 'SUCCEED', ...(job.status === 'SUCCEED' ? {} : { failure: 'deploy-failed' }), ...where, jobId: job.jobId, status: job.status });
      }
      if (Date.now() - started >= timeoutMs) done({ ok: false, failure: 'timeout', ...where, detail: job ? `job ${job.jobId} still ${job.status}` : 'no job for this commit yet', jobId: job?.jobId ?? null });
      await sleep(intervalMs);
    }
  }

  if (deploy.kind === 'github-actions') {
    const where = { github: repoConfig.github, workflow: deploy.workflow };
    while (true) {
      let runs = [];
      try {
        const raw = execFileSync('gh', ['run', 'list', '-R', repoConfig.github, '--commit', commit, '--workflow', deploy.workflow, '--json', 'databaseId,status,conclusion,headSha,url,createdAt'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        runs = JSON.parse(raw);
      } catch (e) {
        done({ ok: false, failure: 'gh-failed', ...where, detail: `gh run list failed: ${firstLine(e)}` });
      }
      // The newest run on this commit decides, so a rerun after a failure counts.
      const latest = runs.filter((r) => sameCommit(r.headSha, commit)).sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0];
      if (latest?.status === 'completed') {
        const ok = latest.conclusion === 'success';
        done({ ok, ...(ok ? {} : { failure: 'deploy-failed' }), ...where, runId: latest.databaseId, status: latest.status, conclusion: latest.conclusion, url: latest.url ?? null });
      }
      if (Date.now() - started >= timeoutMs) done({ ok: false, failure: 'timeout', ...where, detail: latest ? `run ${latest.databaseId} still ${latest.status}` : 'no run for this commit yet', runId: latest?.databaseId ?? null });
      await sleep(intervalMs);
    }
  }

  fail('config', `unknown deploy kind ${deploy.kind}`);
}
