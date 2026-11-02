// bollplank deploy-wait <project> <repo> <commit> [--timeout <seconds>] [--interval <seconds>]
// Wait for the deploy of one commit and report how it ended. It reads the repo's deploy setting:
//
//   none            returns at once
//   command         runs the command with {commit} replaced and uses its exit code
//   amplify         waits for the Amplify job whose commitId is the commit, never "the latest job"
//   github-actions  waits for the named workflow's run on the commit
//
// Every result has status succeeded, failed or timeout, and a ref: the Amplify job id, the
// workflow run id, the command, or none. bollplank run deploy records the same status and ref.
// The kind's own details come as well, such as jobStatus, runStatus, conclusion and exitCode.
//
// Exit 0 when the deploy succeeded, 1 on any other end or on timeout. The timeout defaults to
// 1800 seconds and the poll interval to 15, at least 1.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../args.mjs';
import { loadConfig, loadProject } from '../config.mjs';
import { emit, fail } from '../out.mjs';
import { baseBranch, firstLine } from '../git.mjs';

export const usage = 'bollplank deploy-wait <project> <repo> <commit> [--timeout <seconds>] [--interval <seconds>]';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Commit ids match ignoring case, and a short id matches the full one it starts.
export function sameCommit(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length < 7 || b.length < 7) return false;
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  return x.startsWith(y) || y.startsWith(x);
}

export async function run(argv) {
  const { opts, positional, error } = parse(argv, { timeout: 'value', interval: 'value' });
  const [projectName, repo, commit, ...extra] = positional ?? [];
  if (error || !projectName || !repo || !commit || extra.length) fail('usage', error ?? usage);
  // The commit goes into a command line, so only a hex commit id is accepted.
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) fail('usage', `${commit} is not a commit id`);
  const seconds = (name, fallback, min) => {
    if (opts[name] === undefined) return fallback;
    const n = Number(opts[name]);
    if (!Number.isFinite(n) || n < min) fail('usage', `--${name} must be a number of seconds${min ? `, at least ${min}` : ''}`);
    return n;
  };
  const timeoutMs = seconds('timeout', 1800, 0) * 1000;
  const intervalMs = seconds('interval', 15, 1) * 1000;
  const project = loadProject(loadConfig(), projectName);
  if (!Object.hasOwn(project.repos, repo)) fail('usage', `no repo ${repo} in ${projectName}`);
  const repoConfig = project.repos[repo];
  const deploy = repoConfig.deploy ?? { kind: 'none' };
  const checkout = join(project.source, repo);
  const started = Date.now();
  const minutes = () => Math.round((Date.now() - started) / 60000);
  const base = { project: projectName, repo, commit, kind: deploy.kind };
  // ok follows status, and a failure name comes with every status but succeeded.
  const done = (status, ref, o) => emit({ ok: status === 'succeeded', ...base, status, ref: ref == null || ref === '' ? 'none' : String(ref), ...o, minutes: minutes() });
  // Poll again after the interval, or sooner when the timeout comes first.
  const pause = () => sleep(Math.max(0, Math.min(intervalMs, timeoutMs - (Date.now() - started))));

  if (deploy.kind === 'none') done('succeeded', 'none', { note: 'this repo has no deploy to wait for' });

  if (deploy.kind === 'command') {
    const command = deploy.command.replaceAll('{commit}', commit);
    const r = await runCommand(command, { cwd: existsSync(checkout) ? checkout : undefined, timeoutMs });
    const tail = r.output.trim().split('\n').slice(-20).join('\n');
    if (r.timedOut) done('timeout', command, { failure: 'timeout', command, detail: `the command ran longer than ${timeoutMs / 1000} seconds, so its process group was stopped`, output: tail });
    if (r.error) done('failed', command, { failure: 'command-failed', command, detail: r.error.message });
    const ok = r.code === 0;
    done(ok ? 'succeeded' : 'failed', command, { ...(ok ? {} : { failure: 'deploy-failed' }), command, exitCode: r.code, ...(r.signal ? { signal: r.signal } : {}), output: tail });
  }

  if (deploy.kind === 'amplify') {
    const branch = deploy.branch ?? baseBranch(repoConfig, existsSync(checkout) ? checkout : null);
    const env = { ...process.env, ...(deploy.profile ? { AWS_PROFILE: deploy.profile } : {}) };
    const where = { appId: deploy.appId, branch, region: deploy.region };
    while (true) {
      let jobs = [];
      try {
        const raw = execFileSync('aws', ['amplify', 'list-jobs', '--app-id', deploy.appId, '--branch-name', branch, '--max-items', '50', '--region', deploy.region, '--output', 'json'], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
        jobs = JSON.parse(raw).jobSummaries ?? [];
      } catch (e) {
        done('failed', 'none', { failure: 'aws-failed', ...where, detail: `aws amplify list-jobs failed: ${firstLine(e)}` });
      }
      const job = jobs.find((j) => sameCommit(j.commitId, commit));
      if (job && ['SUCCEED', 'FAILED', 'CANCELLED'].includes(job.status)) {
        const ok = job.status === 'SUCCEED';
        done(ok ? 'succeeded' : 'failed', job.jobId, { ...(ok ? {} : { failure: 'deploy-failed' }), ...where, jobId: job.jobId, jobStatus: job.status });
      }
      if (Date.now() - started >= timeoutMs) done('timeout', job?.jobId, { failure: 'timeout', ...where, detail: job ? `job ${job.jobId} still ${job.status}` : 'no job for this commit yet', jobId: job?.jobId ?? null, jobStatus: job?.status ?? null });
      await pause();
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
        done('failed', 'none', { failure: 'gh-failed', ...where, detail: `gh run list failed: ${firstLine(e)}` });
      }
      // The newest run on this commit decides, so a rerun after a failure counts.
      const latest = runs.filter((r) => sameCommit(r.headSha, commit)).sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0];
      if (latest?.status === 'completed') {
        const ok = latest.conclusion === 'success';
        done(ok ? 'succeeded' : 'failed', latest.databaseId, { ...(ok ? {} : { failure: 'deploy-failed' }), ...where, runId: latest.databaseId, runStatus: latest.status, conclusion: latest.conclusion, url: latest.url ?? null });
      }
      if (Date.now() - started >= timeoutMs) done('timeout', latest?.databaseId, { failure: 'timeout', ...where, detail: latest ? `run ${latest.databaseId} still ${latest.status}` : 'no run for this commit yet', runId: latest?.databaseId ?? null, runStatus: latest?.status ?? null });
      await pause();
    }
  }

  fail('config', `unknown deploy kind ${deploy.kind}`);
}

// Runs the command in a shell of its own process group, so a timeout stops the shell and every
// program it started, not only the shell. Output is kept up to 64 MB.
function runCommand(command, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const posix = process.platform !== 'win32';
    const child = spawn(command, { shell: true, cwd, detached: posix, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const keep = (d) => {
      if (output.length < 1 << 26) output += d;
    };
    child.stdout.setEncoding('utf8').on('data', keep);
    child.stderr.setEncoding('utf8').on('data', keep);
    let timedOut = false;
    let finished = false;
    const stop = (signal) => {
      try {
        if (posix) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {}
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop('SIGTERM');
      // A program that ignores SIGTERM gets SIGKILL after five seconds.
      setTimeout(() => !finished && stop('SIGKILL'), 5000).unref();
    }, timeoutMs);
    const end = (r) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ output, timedOut, ...r });
    };
    child.on('error', (error) => end({ error }));
    child.on('close', (code, signal) => {
      // The shell is gone. Anything it left running in the group goes with it on a timeout.
      if (timedOut) stop('SIGKILL');
      end({ code, signal });
    });
  });
}
