# Plan: a command deploy runs in a clean checkout of the merge commit

Status: v1, 2026-11-06
Ticket: NEO-189, brief v3 (approved). Code review stage selected.

This plan sits on the ticket branch and is removed before the merge.

## Steps

1. **lib/checkout.mjs** (new, shared).
   - `copyNodeModules(src, dest)` moves here from `lib/commands/ticket.mjs`, unchanged. `ticket.mjs` imports it.
   - `makeCheckout({ src, repo, commit, base })`:
     - `git fetch --quiet origin` in `src`. A fetch failure is `commit-missing` with git's first line.
     - resolve the commit with `rev-parse --verify <commit>^{commit}`, then `merge-base --is-ancestor <full> origin/<base>`. Either failing is `commit-missing`.
     - `git worktree prune`, then `mkdtempSync(join(tmpdir(), 'bollplank-deploy-<repo>-'))` and `git worktree add --quiet --detach <dir> <full>`. A failure removes the empty folder and is `checkout-failed`.
     - returns `{ dir, full }`.
   - `removeCheckout(src, dir)`: `git worktree remove --force <dir>`, then `git worktree prune`. If git refuses, `rmSync(dir)` only when `dir` is the path this call made (it starts with the temporary prefix and was returned by `makeCheckout`), then prune. Returns null or git's first line.
   - Errors are thrown as a small `CheckoutError { failure, detail }` so deploy-wait turns them into its own result.

2. **lib/commands/deploy-wait.mjs**, the `command` branch.
   - `no-checkout` when `join(source, repo)` is missing or `rev-parse --git-dir` fails there.
   - base branch from `baseBranch(repoConfig, checkout)`, as the amplify branch does.
   - make the checkout, clone node_modules when `cloneNodeModules`, run the command with `cwd` set to the checkout.
   - SIGINT and SIGTERM handlers, set only while the command runs: stop the process group, remove the checkout, emit `failed` with failure `interrupted` and exit. The ship skill already treats anything but `succeeded` as no end state to release on, so an interrupted call is looked at again by a resume.
   - cleanup in a `finally` before `done()`, since `done()` throws `Exit`.
   - the result gains `checkout: "clean"` and `nodeModules` (`cloned`, `copied` or null). A removal failure after the command ends turns the result into `checkout-failed`, keeping the command's own status and exit code in the detail fields, since a leftover worktree in someone's repo must be seen.
   - `{commit}` is replaced with the commit as given, as today.

3. **Tests** in `test/deploy-wait.test.mjs`. The command tests move from a made up commit and a missing source folder to a real `gitRepo` with a bare origin under `src/acme-cmd`, since every command call now needs one. The amplify and github-actions tests keep the made up commit.
   - existing command tests: exit code, commit in the command, timeout with the process group stopped.
   - clean checkout: the source folder is reset to an older commit, has a local edit and an untracked file. The command writes `git rev-parse HEAD` and `git status --porcelain` and its cwd to a file. HEAD is the merge commit, status empty, cwd not the source folder.
   - after success, failure and timeout: `git worktree list --porcelain` names only the source folder, and the temporary folder is gone.
   - node_modules: present with `cloneNodeModules`, absent without.
   - `commit-missing` for a local only commit and a side branch commit. `no-checkout` for a missing source folder.
   - two calls at once on two commits, each command sleeping briefly and checking its HEAD at the end. Both succeed and both checkouts are gone.
   - SIGTERM: a slow command, the test sends SIGTERM to the bollplank process once the command started, then checks the result, the worktree list and the folder.

4. **Docs and release.** `docs/config.md` command row, `docs/commands.md` (adds and failures), `docs/runs.md` one line, `docs/windows.md` (node_modules copied, not cloned), the schema description, `package.json` 0.4.0, CHANGELOG 0.4.0.

5. **Gate.** `node scripts/check.mjs` in the ticket folder, then remove this plan in its own commit before the merge.

## Order

Steps 1 and 2 are one change in two files. Step 3 follows them. Step 4 runs alongside. The change is small enough for one implementer.
