// bollplank deploy-wait <project> <repo> <commit> [--timeout <seconds>] [--interval <seconds>]
// Wait for the deploy of one commit and report how it ended. It reads the repo's deploy setting:
//
//   none            returns at once
//   command         runs the command with {commit} replaced, in a clean, detached checkout of the
//                   commit made for the call and removed after it, and uses its exit code
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
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../args.mjs';
import { loadConfig, loadProject } from '../config.mjs';
import { emit, fail } from '../out.mjs';
import { baseBranch, firstLine, tryGit } from '../git.mjs';
import { CheckoutError, copyNodeModules, makeCheckout, removeCheckout } from '../checkout.mjs';

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
    // The command sees the commit and only the commit: a detached worktree of it in a temporary
    // folder, never the repo's own folder, whose revision and local edits can be anything.
    // The repo's folder must be the top of a git repo itself, not a plain folder inside another one.
    const top = existsSync(checkout) ? tryGit(checkout, 'rev-parse', '--show-toplevel') : null;
    if (!top || realpathSync(top) !== realpathSync(checkout)) {
      done('failed', command, { failure: 'no-checkout', command, detail: `${checkout} is not a git repo, so there is nothing to check the commit out from` });
    }
    // A stop of deploy-wait itself stops the command's process group, and the checkout is still
    // removed. The handlers are on before the checkout is made, so a stop then waits for it too.
    const stopper = { stop: null, signal: null };
    const onSignal = (signal) => {
      stopper.signal = signal;
      stopper.stop?.();
    };
    const signals = process.platform === 'win32' ? ['SIGINT', 'SIGTERM'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
    for (const s of signals) process.on(s, onSignal);
    const off = () => {
      for (const s of signals) process.off(s, onSignal);
    };
    let made;
    try {
      made = makeCheckout({ src: checkout, repo, commit, base: baseBranch(repoConfig, checkout) });
    } catch (e) {
      off();
      if (!(e instanceof CheckoutError)) throw e;
      done('failed', command, { failure: e.failure, command, detail: e.detail });
    }
    let r = { output: '' };
    let nodeModules = null;
    let copyProblem = null;
    let leftover = null;
    try {
      let copyError = null;
      try {
        nodeModules = repoConfig.cloneNodeModules ? copyNodeModules(checkout, made.dir) : null;
      } catch (e) {
        copyError = e;
      }
      // Signal handlers run between the steps above, so a stop that came during them is seen here.
      await new Promise((res) => setImmediate(res));
      // A failed copy is a failed checkout, unless deploy-wait itself was stopped meanwhile.
      if (copyError && !stopper.signal) copyProblem = `node_modules could not be copied into the checkout: ${copyError.signal ? `the copy got ${copyError.signal}` : firstLine(copyError)}`;
      if (!copyProblem && !stopper.signal) r = await runCommand(command, { cwd: made.dir, timeoutMs, stopper });
    } catch (e) {
      r = { output: '', error: e };
    } finally {
      leftover = removeCheckout(checkout, made.dir);
      off();
    }
    const tail = r.output.trim().split('\n').slice(-20).join('\n');
    const extra = { command, checkout: 'clean', nodeModules };
    if (leftover) done('failed', command, { failure: 'checkout-failed', ...extra, detail: `the command ended, but its checkout at ${made.dir} was not removed: ${leftover}`, ...(r.code !== undefined ? { exitCode: r.code } : {}), output: tail });
    if (stopper.signal) done('failed', command, { failure: 'interrupted', ...extra, detail: `deploy-wait got ${stopper.signal}, so the command's process group was stopped and its checkout removed`, output: tail });
    if (copyProblem) done('failed', command, { failure: 'checkout-failed', ...extra, detail: copyProblem });
    if (r.timedOut) done('timeout', command, { failure: 'timeout', ...extra, detail: `the command ran longer than ${timeoutMs / 1000} seconds, so its process group was stopped`, output: tail });
    if (r.error) done('failed', command, { failure: 'command-failed', ...extra, detail: r.error.message });
    const ok = r.code === 0;
    done(ok ? 'succeeded' : 'failed', command, { ...(ok ? {} : { failure: 'deploy-failed' }), ...extra, exitCode: r.code, ...(r.signal ? { signal: r.signal } : {}), output: tail });
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

// Runs the command in a shell of its own process group, so a timeout or a stop of deploy-wait
// stops the shell and every program it started, not only the shell. Output is kept up to 64 MB.
function runCommand(command, { cwd, timeoutMs, stopper }) {
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
    // A program that ignores SIGTERM gets SIGKILL after five seconds.
    const halt = () => {
      stop('SIGTERM');
      setTimeout(() => !finished && stop('SIGKILL'), 5000).unref();
    };
    let halted = false;
    const timer = setTimeout(() => {
      timedOut = true;
      halt();
    }, timeoutMs);
    if (stopper) stopper.stop = () => {
      halted = true;
      halt();
    };
    const end = (r) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ output, timedOut, ...r });
    };
    // Whether any program of the group is still there.
    const groupAlive = () => {
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (e) {
        return e.code === 'EPERM';
      }
    };
    let closed = false;
    let onClosed = null;
    child.on('close', () => {
      closed = true;
      onClosed?.();
    });
    child.on('error', (error) => end({ error }));
    // The shell is gone, on its own or stopped. Anything it left running in the group goes too,
    // before the result, since its checkout is removed next: SIGTERM, then SIGKILL after five
    // seconds, or SIGKILL at once after a timeout or a stop. A program that keeps the output
    // pipes open no longer holds the result back, since the wait starts when the shell exits.
    child.on('exit', async (code, signal) => {
      clearTimeout(timer);
      if (posix) {
        let killed = timedOut || halted;
        stop(killed ? 'SIGKILL' : 'SIGTERM');
        const since = Date.now();
        while (groupAlive() && Date.now() - since < 7000) {
          if (!killed && Date.now() - since >= 5000) {
            stop('SIGKILL');
            killed = true;
          }
          await sleep(100);
        }
      }
      if (!closed) await Promise.race([new Promise((res) => (onClosed = res)), sleep(1000)]);
      end({ code, signal });
    });
  });
}
