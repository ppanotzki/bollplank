# Plan: a github-actions deploy whose workflow runs only for some paths

Status: v1, 2026-11-06. Brief v3, approved. Code review stage selected.

Base: master c2fb2e2, which already holds the clean checkout for command deploys. The version there is 0.4.0 and tagged, so this is 0.4.1.

## Steps

1. **New module `lib/workflow-filter.mjs`**, with no dependency and no I/O, so the reader and the matcher are tested on their own.
   - `readPushTrigger(text)` reads the top level `on` key only. Forms: a scalar event, a flow list of events, or a block map of events, or a block list of events. Under `push`: nothing, `null`, `~` or `{}`, or a block map of `branches`, `branches-ignore`, `tags`, `tags-ignore`, `paths`, `paths-ignore`, each a flow list or a block list of plain, single quoted or double quoted strings. It returns `{ events, push }` or `{ unknown: <reason> }`. Tabs, anchors, aliases, block scalars, flow maps, an `on` key seen twice and any other key under `push` give unknown.
   - `globToRegExp(pattern, { pathMode })` follows GitHub's filter pattern syntax: `*` (not `/`), `**`, `**/` matching zero or more folders, `?` and `+` as quantifiers on the character before, `[...]` with letters, digits and ranges, `\` escapes. Anything else, or `?` or `+` with no character before it, returns null.
   - `matchList(patterns, value)` is the last matching pattern wins rule with `!` negation. A list of only negations, or a pattern that does not compile, gives unknown.
   - `decide({ trigger, baseBranch, files })` returns `{ answer: 'runs' | 'does-not-run' | 'unknown', reason }`:
     - any event other than `push` and `workflow_dispatch`, no `push`, `tags` or `tags-ignore`, both branch lists, or both path lists: unknown
     - branch lists with no known base branch: unknown. A branch list that excludes the base branch: does not run.
     - no path list: runs
     - files missing, empty or over 300: unknown
     - `paths`: runs when any file matches. `paths-ignore`: runs when any file is not ignored. `!` in a `paths-ignore` list: unknown.
2. **`deploy-wait`, github-actions branch.** Before the wait loop, `pushFilter()`:
   - `gh api repos/<slug>/actions/workflows?per_page=100&page=<n>`, every page. Exactly one workflow whose id, name, path or file name equals `deploy.workflow`, else unknown.
   - `gh api repos/<slug>/contents/<path>?ref=<commit>`, base64 content, else unknown.
   - Read the trigger. Only when a path list is there does it fetch the files.
   - `gh api repos/<slug>/commits/<commit>?per_page=100&page=<n>` until a short page or over 300 files. More than one parent gives unknown. A renamed file counts under both names.
   - The base branch is `repoConfig.baseBranch`, else origin/HEAD in the repo's folder, else unknown.
   - Any `gh` failure gives unknown with its first line as the reason.
3. **Act.** Does not run: one `gh run list`. A run there goes on to the wait loop. None returns `succeeded`, ref `none`, `runId` null, `workflowFile` and a `note`. Runs or unknown: the wait loop as today. Every github-actions result carries `filter: { answer, reason }`, and a timeout's `detail` adds the reason when the answer was unknown.
4. **Tests.** The fake `gh` in `test/deploy-wait.test.mjs` answers `gh api` by path from a fixture and `gh run list` from the sequence, so the existing tests keep their sequences. Cases from the brief's step 7, plus unit tests in `test/workflow-filter.test.mjs` for the reader, the glob cases of GitHub's cheat sheet and `decide`.
5. **Docs and version.** `docs/config.md`, `docs/commands.md`, CHANGELOG 0.4.1, `package.json` 0.4.1.

## Deviation from the brief

The reader and matcher sit in a new `lib/workflow-filter.mjs` instead of inside `deploy-wait.mjs`, so they can be tested without a fake `gh`. Fetching every page of workflows and changed files can take a few more `gh api` calls than the three the brief named.
