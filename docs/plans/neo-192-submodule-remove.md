# NEO-192: ticket remove checks inside submodules

Brief v3, approved. Cross-model review: code.

## Facts confirmed on git 2.54

- In a linked worktree, `git submodule update --init` puts the submodule's git folder at `<worktree git dir>/modules/<name>`, and a nested one at `<that>/modules/<name>`. `<name>` is the submodule name and may hold slashes.
- `git submodule deinit` empties the checkout and unsets `core.worktree`, but keeps the git folder with its stash and branches.
- `git worktree remove --force` deletes the worktree's git dir, so every submodule git folder under it goes too.
- `git submodule foreach --recursive` visits only checked out submodules and gives `$displaypath`.

## Design

All in `lib/commands/ticket.mjs`, in a new `submoduleChecks(repo, dest, isDisposable)` called from `remove` for a present worktree.

1. **Checked out submodules.** `git submodule foreach --recursive --quiet 'printf "%s\0%s\0" "$displaypath" "$(git rev-parse --absolute-git-dir)"'` gives each path from the worktree root and its git folder. A failure refuses with the reason.
2. **Git folders without a checkout.** Walk `modules/` under the worktree's own git dir and under each checked out submodule's git folder. A folder with a `HEAD` file and an `objects` folder is a git folder. Record it and walk its own `modules/`. Any other folder is part of a name with slashes, so descend. Compare by real path and skip the git folders of checked out submodules, which step 3 covers. The label is the path from the owning checkout's `.gitmodules` (`submodule.<name>.path`) when there is one, else the owner's label plus the name.
3. **Which git folders count.** Only those inside the worktree's git dir or the worktree folder, since removal deletes only those. A checked out submodule whose git folder lives elsewhere still gets the checkout checks.
4. **Checks for a checked out submodule at `<path>`:**
   - `git -C <path> status --porcelain -z --untracked-files=normal --ignore-submodules=dirty`. An entry for one of its own checked out submodules means that submodule's checkout is not the commit it records: `<repo>: <path>/<sub>: checkout is not the commit <path> records`. Any other entry: `<repo>: <path>: uncommitted or untracked changes`.
   - Ignored files: `ignoredFiles(<path>)`, each prefixed with `<path>/`, joined to the repo's list before the disposable matcher and the `--force-ignored` rule.
5. **Checks for every counted git folder** (with or without a checkout):
   - Stash: `git --git-dir=<g> rev-parse --verify --quiet refs/stash`. Present means `<repo>: <label>: a stash that removal would delete`. `--force-ignored` does not pass it.
   - Commits: `git --git-dir=<g> fetch --quiet --prune --all --no-recurse-submodules`, then the tips (HEAD when it resolves, and every `refs/heads/*`) through `rev-list --count <tips> --not --remotes`. A count above 0 means `<repo>: <label>: <n> commits on no remote of the submodule`.
   - Any git failure in these checks refuses: `<repo>: <label>: could not check the submodule: <first line>`.
   - A git folder without a checkout says so in its label: `<label> (no checkout)`.
6. **The repo's own status** becomes `--ignore-submodules=dirty`, run raw without trimming, so a line for a top level submodule path is told apart from the repo's own changes. Such a line refuses as `<repo>: <path>: checkout is not the commit <repo> records`. Any other line keeps today's `<repo>: uncommitted or untracked changes` and its `continue`. The explicit flag also overrides a `submodule.<name>.ignore` setting that would hide a submodule from status today.
7. Submodule refusals are pushed before the repo's own status check, so they are listed even when the repo also has its own changes.

## Docs, version

- Header comment of `lib/commands/ticket.mjs`, `remove` in `docs/commands.md`, a sentence on submodules in the disposable paragraph of `docs/config.md`.
- `package.json` 0.5.1 and a CHANGELOG section.

## Tests (test/ticket.test.mjs)

A helper builds `acme-lib-sub` (bare remote plus work clone, with a nested `acme-deep` submodule) and adds it to acme-api as submodule `lib`, pushed to main before the ticket is created. Then `git submodule update --init --recursive` in the ticket worktree, with `-c protocol.file.allow=always`.

1. Ignored `lib/.env` refuses, listed as `lib/.env`. `--force-ignored` removes.
2. A stash in `lib` refuses with and without `--force-ignored`.
3. An unpushed commit on a side branch in `lib` refuses. A commit on HEAD that the parent records and pushes, but the submodule never pushed, refuses.
4. An untracked file and a local commit in `lib` refuse and name `lib`.
5. An ignored file and a stash in `lib/deep` refuse.
6. Deinit `lib` after a stash and an unpushed branch: refuses, and after the refusal the stash and branch are still in the git folder.
7. A commit only on a remote branch that was deleted on the remote refuses.
8. `disposable: ["lib/dist/"]` with an ignored `lib/dist/` removes and names `lib/dist/`.
9. A worktree whose submodule was never initialized removes as before, with the same output keys.

The existing remove tests run unchanged.
