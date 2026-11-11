# Commands

Everything is one command, `bollplank <command> [options]`. `bollplank help` lists the commands, and `bollplank <command> --help` (or `-h`) prints one command's usage line. Most commands are called by the skills. The ones you type are `init`, `doctor`, `update`, `uninstall`, `version` and sometimes `context` or `turn status`.

## Conventions

- **Output.** One JSON object on stdout, with `"ok": true` or `"ok": false`, a `failure` code and usually a `detail`. `init`, `doctor`, `update` and `uninstall` talk to a person and print JSON only with `--json`. `version` prints text without `--json`.
- **Exit codes.** `0` for success, `1` for a failure, `2` for a usage error or an unknown command.
- **Options.** A value option without a value, or an unknown option, is a usage error. Lists are comma separated, such as `--change acme-api,acme-web`.
- **Tickets** look like `ACME-1`. Lower case is turned into upper case.
- **Every command** can fail with `usage`, `config` (the config is missing or invalid) and `internal` (a bug, with the stack in `detail`). A record or state file that is not valid JSON fails with `corrupt`, names the file in `file`, and is never rewritten.

## Setup

[setup.md](setup.md) has the steps and checks.

- **`bollplank init [--answers <file>] [--offline] [--json]`** sets Bollplank up or again. Failures: `usage` (no terminal and no answers file, a bad answers file, a missing answer, or an answer that is not a Jira site, project key or space key), `config` (the answers do not validate, so nothing was written, and the answers are kept in `config.kept-answers.json` beside the config), `corrupt` (the install record), `missing-project` (the board project was still missing after three reads, so nothing was saved) and `stopped` (the questions were interrupted).
- **`bollplank doctor [--offline] [--json]`** checks the install and exits 1 when a required check fails. `--json` prints `{ ok, offline, checks }`, each check with `id`, `name`, `required`, `ok`, `detail`, `fix`, and `skipped` under `--offline`. The board reads have the ids `<kind>.<client>` and `<kind>`, such as `linear.claude` and `jira.codex`, for each kind the config uses.
- **`bollplank update [--pre] [--json]`** moves the kit to the newest release tag. A success has `kit`, `installed`, `tag`, `already`, `ahead`, `from`, `to`, `links` and `changelog`. Failures: `not-a-checkout`, `corrupt`, `local-changes`, `fetch`, `no-release` and `checkout`.
- **`bollplank uninstall [--purge] [--yes] [--json]`** removes the recorded links. A success has `removed`, `left`, `home`, `purged`, `kept` and `command`. Failures: `usage` (`--purge` with no terminal and no `--yes`), `lock-held`, `unsafe-purge` and `corrupt`, all before anything is removed.

### `bollplank version [--json]`

Prints the Workflow line every brief and comment carries, such as `Bollplank 0.2.0, build 40`. The version is in `package.json` and equals the release tag. The build is the number of commits on the kit's base branch. A copy with commits not on that branch adds ` plus unmerged commits`, one with local changes adds `, with uncommitted changes`, and one outside git ends `build unknown`.

### `bollplank context [<project>]`

Prints what a skill needs: `workflow`, `kit`, `approver`, `copyStyle`, `board` with its `statuses`, `critic`, `projects` (the names) and `boards`, which maps each project to its board `kind`, `team`, `project`, `statuses` and `space` when set, with the top level defaults filled in for a project of the top level kind.

With a project, `board.kind` is that project's kind: its own `board.kind`, else the top level one. `board.statuses` is its effective mapping: its own names, then the top level ones, then the kind's suggestion. `board.team` and `board.project` are the project's own, else the top level ones, so `board` matches the project's `boards` entry. A project of another kind than the top level takes nothing from the top level board. On Jira, `team` is the site, `project` the project key, and `space` the Confluence space key when set. It adds `project` with `name`, `mode`, `runs`, `stopList`, `board`, `repos`, `shipOrder`, `privateScan`, `critic`, `source` and `tickets`. `project.critic` is `{ "default": ..., "from": "project" }` when the project sets its own, else the top level one with `"from": "config"`.

## The critic

### `bollplank critic`

```
bollplank critic --ticket <TICKET> --subject brief|plan|code --round <n> --prompt-file <file> --lead claude|codex
  [--project <name>] [--critic other|same|claude|codex] [--read-dir <folder>] [--instruction-file <file>]
  [--timeout <seconds>] [--model <m>] [--effort <e>] [--new-session]
```

Runs one critique round. The board kind comes from `--project`.

- **Linear.** The critic reads the issue and its comments with its client's Linear tools, posts its critique as one comment, and replies with the text it posted. The command returns that text with `delivery: "posted"`.
- **Jira.** The critic is reply only. It reads the issue with `getJiraIssue` and every page of the comments with `executeRead` of `listJiraIssueComments`, and replies with its critique. The command returns the text with `posted: false`, `delivery: "reply"` and `pending: true`. The round is not counted yet. The lead posts the text unchanged, reads it back and runs `bollplank critic confirm`.

- `--prompt-file` is the prompt the lead filled from [prompts/critic.md](../prompts/critic.md) or [prompts/critic-same.md](../prompts/critic-same.md). The lead fills `{TICKET}`, `{ROUND}`, `{SUBJECT}`, `{SUBJECT_SHORT}`, `{DATE}`, `{ROUND_NOTE}` and `{BODY}`. The command fills `{REVIEWER}`, `{MODEL}`, `{WORKFLOW}`, `{ISSUE}`, `{BOARD}` with the board's name and `{INSTRUCTION}`. On Jira it also swaps the prompt's post sentence for one that tells the critic to reply only, to read every page of the comments from `startAt` 0, and to pass the project's cloud id (`board.teamId`, else the site) in every call.
- `--lead` is the client of the calling session. `--critic` overrides the defaults for this call. Without it, `--project` takes that project's `critic.default`, else the top level one. `other` is the client that is not `--lead`.
- `--read-dir` opens one source folder for reading. Without it, the critic runs in the empty `~/.bollplank/neutral`.
- `--instruction-file` holds an instruction from the approver, such as to edit the brief. Its text fills `{INSTRUCTION}` under a line saying it comes from the approver. Without it, `{INSTRUCTION}` is empty.
- `--timeout` defaults to 600 seconds. `--model` and `--effort` override the config for this call.
- `--new-session` starts a fresh session and keeps the round counts. Use it after `session-missing`.

**What the critic gets.** On Linear, its client's Linear tools, read and write. On Jira, only `getJiraIssue` and `executeRead`, on Atlassian's official server, and `executeRead` only for `listJiraIssueComments`. Also the `--read-dir` folder. No other MCP server, no web and no file edits. Claude Code has no shell. Codex has a shell in a read only sandbox with no network. Its environment loses every model key, provider route and session marker. [SECURITY.md](../SECURITY.md#what-the-critic-can-reach) has the detail.

**The subject must have been read.** A critique is used only when the critic made a successful call that read the issue and one that read its comments. An issue read counts when its arguments name the key, or when its result is the issue itself, with an `identifier` equal to the key. Either way the issue's id becomes an alias, so a critic that reads the comments and posts by the id still counts. A read of another issue never counts, even when its result mentions the key. Otherwise the call fails with `board-unreachable` and the session is kept, so a retry resumes it. On Jira, comments inside the `getJiraIssue` result never count, and the `listJiraIssueComments` pages for this issue and the project's cloud id must cover the whole list without a gap: the first starts at 0, each next one starts where the one before ended, and the last says `isLast: true` or reaches `total`.

**What the critic posted counts,** on Linear. The body of the critic's successful comment call on the issue is the source of truth. Only an argument that identifies the issue, such as `issueId`, `id` or `url`, can name it, never free text such as a body or a query. When that body is a well formed critique, it is the returned text, even when the final reply is empty or malformed. When the call fails after such a post, for any reason, the round is counted all the same and the failure says `counted: true`, since the board holds that round now. The lead then posts nothing more and calls the next round when it is due.

**Sessions and rounds.** One session per ticket, provider and mode is reused across subjects. Rounds count per subject, and `--round` must be one more than the rounds saved, or the call fails with `round-mismatch`. State is saved with a counted round, and after `board-unreachable` with only the session, so a retry resumes it. Any other failure saves nothing. One call per ticket, provider and mode runs at a time. Every call with a known session is bound to its ticket in the ledger.

**The header.** The command fills `Reviewer:`, `Model:` and `Workflow:` before the call. `Reviewer:` is `Claude Code` or `Codex`, with `, same provider, separate session` for the lead's own provider. `Model:` is the pinned `model` and `effort`. Without a pinned model it is the model this client last reported, kept in `~/.bollplank/critics/models.json` by doctor's dry run and by each critique, or `Unverified` before any report. When the client reports another model, the returned text names that one, and `modelCorrection` is `{ posted, reported }`. The posted header, the lines from `Critique of` to the first blank line, must carry all three lines. The expected values are the wrapper's `Reviewer:` and `Workflow:`, and for `Model:` the model the client reported, or the pinned line when none was reported. The returned text always has the expected header. When the posted header lacks a line or holds another value, `headerCorrection` lists each one as `{ line, posted, expected }`, with `posted` null for a missing line. The round still counts, and the lead edits the posted comment's header to the expected lines and reads it back before it relies on the round. If the edit fails, it posts the returned text as a new comment.

A success has `critic`, `mode` (`other`, `same` or `named`), `delivery` (`posted` or `reply`), `ticket`, `subject`, `round`, `sessionId`, `sessionRestarted` (with `--new-session`), `model`, `verdict` (`Approve` or `Revise`), `posted` (whether a call that saves a comment on the issue succeeded), `modelCorrection` and `headerCorrection` when needed, `usage` and `text`. A Jira success also has `pending: true`, and never `modelCorrection` or `headerCorrection`, since nothing was posted yet. Every failure has `critic`, `mode`, `ticket`, `subject`, `round`, and `sessionId` once known.

| Failure | Meaning |
|---|---|
| `usage` | A missing or bad option, or a file or folder that cannot be read. |
| `critic-unavailable` | The client is not found, not signed in with a subscription, or has no board server that is connected and signed in. For Jira that is Atlassian's server at its official URL. Or Claude Code's user settings set a key or a provider route or let the critic read outside its folder, or its managed settings could keep hooks on, or Codex could not switch off its other MCP servers. Nothing else is tried. `fix` says what to do. |
| `critic-busy` | Another call for this ticket, provider and mode is running. The detail names its lock folder. |
| `post-pending` | A Jira round is waiting for the lead's post and confirm. The detail names its subject and round. No client runs. |
| `critic-other-board` | The critic state of this ticket key belongs to a Jira board at another site or cloud id, so its session is not resumed. No client runs. The detail names the state file the approver removes to start over. |
| `round-mismatch` | The round is not the next one. `expected` says which is. No client runs. |
| `state` | The saved critic state cannot be read. |
| `session-missing` | The client lost the session. Retry with `--new-session`. |
| `board-unreachable` | The critic did not read the issue and its comments. The round is not counted unless the critic posted a critique anyway. |
| `critic-used-tools` | The critic was given or used a tool, an MCP server or a connector it is not allowed. The reply was not used. |
| `timeout` | No answer within `--timeout`. `seconds` says how long. |
| `client-error` | The client reported an error. Quota and usage limits arrive this way. |
| `exit` | The client exited abnormally or did not start. A critique that arrived first is in `receivedReview`, which says whether it was `counted`. |
| `empty-answer`, `malformed-answer` | The reply was empty, or does not start with `Critique of ` or has no `Verdict:` line. `head` shows its start. |

Every failure after the critic started carries `posted`, and so does a `receivedReview`, so the lead knows whether a comment was left anyway. `counted: true` says the posted comment was a well formed critique and its round is counted.

### `bollplank critic pending` and `bollplank critic confirm`

```
bollplank critic pending --ticket <TICKET> [--lead claude|codex] [--critic other|same|claude|codex] [--project <name>]
bollplank critic confirm --ticket <TICKET> --subject brief|plan|code --round <n> --text-file <file> --comment <link>
  [--lead claude|codex] [--critic other|same|claude|codex] [--project <name>]
```

For a Jira round, which the critic answers with a reply only. Both look at every critic state of the ticket and take the one with a pending round. A pending round names the site and cloud id of its board, so both need `--project` and refuse a round of another board. When more than one critic of the ticket has a round pending, add `--lead` and `--critic`, with `--project`, as in the critic call, to pick the same state that call used.

- **pending** prints the pending record, `{ subject, round, sha256, file, at }`, and the stored text, after checking that the text still matches its sha256. It fails when it does not. It never starts a client. The text is kept in `~/.bollplank/critics`, in a file named after the critic's state file, `<state file name without .json>.pending-<subject>-<round>.md`, so every ticket, provider and mode has its own.
- **confirm** runs after the lead posts the text unchanged and reads it back. Pass the `file` that pending printed as `--text-file`, since a copy can gain a trailing newline or other line endings. The sha256 of `--text-file` must equal the pending one, and the subject and round must match, or it fails and nothing changes. On success the round is counted, as a posted round is, and the pending record and its file are cleared. `--comment` is the link of the posted comment.

| Failure | Meaning |
|---|---|
| `usage` | A missing or bad option, a text file that cannot be read, or more than one pending round without `--lead` and `--critic`. |
| `no-pending` | No round of the ticket is pending for that critic. Nothing changed. |
| `pending-other-board` | The pending round belongs to another board, at another site or cloud id, whose tickets have the same key. Do not post it. |
| `pending-corrupt` | The stored text is missing or no longer matches its sha256. Do not post it. The failure names the state file as `state`. To run the round again, the approver checks the issue's comments, removes the `pending` key from that file and deletes the text file if it is there. |
| `confirm-mismatch` | The text, subject or round is not the pending one. Nothing changed. |
| `critic-busy` | A critic call for this ticket and critic is running. Confirm again after it. |
| `state` | The saved critic state cannot be read. |

The critique skill uses both for recovery too. After a lost reply, an interrupted post or an interrupted confirm, it runs `pending`, looks for a comment whose body matches the stored text under `bollplank board compare jira`, and confirms with that comment. It posts the text only when no comment has it. The critic never runs again for a pending round.

## The board

### `bollplank board safe-write`

```
bollplank board safe-write jira --html <file>
bollplank board safe-write jira --adf <file>
```

Checks a Jira description before the board skill replaces it with markdown. Give exactly one of the two. It reads the one file and never touches the network.

With `--html` the file holds the description as `getJiraIssue` returns it with `responseContentFormat: "html"`: the whole result, or the description text itself. Atlassian's v2 server returns only markdown or HTML, and HTML keeps everything. The tags markdown keeps are `p`, `br`, `h1` to `h6`, `ul`, `ol`, `li`, `pre`, `code`, `blockquote`, `hr`, `strong`, `em` and `a`, with only `href` on `a`, `class="language-<name>"` on `code`, `data-unique-id` on `pre` and `start` on `ol`. Everything else is listed in `unsupported`, in the order found, each once: an element with a `data-type` by that value, such as `panel-info`, `status` or `mention`, any table tag as `table`, any other tag by its name, any other attribute as `<tag> <attr>`, and an HTML comment as `comment`. A JSON result must say `appliedContentFormat: "html"`, and text with no HTML tag is not HTML. Both fail as `not-html` otherwise. An empty description passes. A result with no description field fails as `no-description`, since it shows nothing about the description: the default view leaves it out, and so does the server for an empty one.

With `--adf` the file holds the description in ADF, for a server that returns it. Markdown keeps only some ADF types when it is written and read back: the nodes `doc`, `paragraph`, `text`, `heading`, `bulletList`, `orderedList`, `listItem`, `codeBlock`, `rule`, `hardBreak` and `blockquote`, and the marks `strong`, `em`, `code` and `link`. The command lists every other node or mark type in `unsupported`, in the order found, each once. It reads the one file and never touches the network.

It exits 0 with `{ "ok": true, "unsupported": [] }` when there are none, also for an empty document, an empty file or a description that is `null`. Failures: `unsupported` (with the types, such as `media`, `mention` or `table`), `not-adf` (the file is not valid JSON, or its root has no `type` of `doc`), `not-html` and `usage`.

### `bollplank board compare`

```
bollplank board compare jira --sent <file> --got <file>
```

Checks a Jira readback: what the lead sent against what Jira returned. Jira's markdown returns every single newline as two trailing spaces and a newline, `- ` bullets as `* `, and adds a trailing newline. On both texts, the compare turns line endings into LF, takes trailing spaces and tabs off each line, writes a `*`, `+` or `-` list marker followed by a space at the start of a list item as `- `, and takes trailing newlines off. Lines in a fenced code block, and indented code lines, keep their markers, since there they are content. Nothing else is changed. It exits 0 with `{ "ok": true }` on a match. Otherwise it fails as `differs` with `line`, the first line that differs counted from 1, and `sent` and `got`, those two lines cut to 200 characters. Consulting and configuration runs on Jira compare the brief with the live description the same way.

## Tickets and runs

### `bollplank ticket`

```
bollplank ticket create <project> <TICKET> --slug <slug> --change <repo,repo> [--validate <repo,repo>]
bollplank ticket refresh <project> <TICKET>
bollplank ticket status <project> <TICKET>
bollplank ticket remove <project> <TICKET> [--force-ignored]
```

For repository projects. A ticket folder `<tickets>/<TICKET>` holds one git worktree per repo and the record `.ticket.json`.

- **create** makes branch `<ticket>-<slug>` from `origin/<base branch>` in each changed repo, and a detached checkout for each repo used only for validation, including those in `validatesAgainst`. `node_modules` is cloned for repos with `cloneNodeModules`. A failed step removes the worktrees made before it (`create-failed`, with `rolledBack`).
- **refresh** fetches every repo and moves validation checkouts to the latest base branch, refusing when one has local changes.
- **status** reports each worktree's head and changed file count.
- **remove** refuses on uncommitted, untracked or ignored files other than `node_modules` and the repo's `disposable` paths ([config.md](config.md)), and on commits that are neither on `origin/<base>` nor the merged head `bollplank merge --run` recorded. `--force-ignored` deletes the listed ignored files. Nothing forces past the rest. It checks inside every submodule git folder the worktree holds, nested ones included: each gitlink in the index with a checkout, an embedded repo without a `.gitmodules` entry too, and each git folder that `git submodule deinit` left without a checkout. A checked out submodule refuses on changes, untracked and ignored files and a checkout that is not the recorded commit. Every such git folder refuses on a stash, on linked worktrees of its own, and on commits on HEAD or a local branch that are in the history of nothing its remotes advertise now, branch or tag. It fetches first, and completes a shallow clone, since its boundary hides that history. Paths inside a submodule are named from the repo root, such as `lib/.env`. A check that cannot run, such as a fetch that fails, refuses. On success, `disposable` names the disposable paths it deleted, per repo.

Failures: `usage`, `no-ticket-folder`, `exists`, `create-failed`, `refused` (with `refusals` and `ignored`), `corrupt` and `git-failed`.

### `bollplank run`

The run record, `.run.json` in the ticket folder. For repository projects:

```
bollplank run init <project> <TICKET> --review none|plan|code|both [--critic other|same|claude|codex]
bollplank run stage <project> <TICKET> plan --revision <sha or version> --verdict Approve|Revise [--points <n>] [--complete]
bollplank run stage <project> <TICKET> code --revision <sha> | --revisions <repo>=<sha>,... --verdict Approve|Revise [--points <n>] [--complete]
bollplank run reopen <project> <TICKET> plan|code --reason <text>
bollplank run gate <project> <TICKET> plan|code
bollplank run plan <project> <TICKET> --commit <sha> [--path <file>]
bollplank run deploy <project> <TICKET> <repo> --kind <kind> --status <status> [--ref <ref>] [--commit <sha>]
bollplank run log <project> <TICKET> --event <text>
bollplank run show <project> <TICKET>
bollplank run check-shipped <project> <TICKET>
```

- **init** refuses with `runs-disabled` unless the project has `"runs": true`, and with `no-ticket-folder` before `ticket create`. On an existing record it returns it, for a resume.
- **stage** records a review round. A stage is complete on `Approve`, or with `--complete`. A code round names the reviewed head of each changed repo with `--revisions`. `--revision` alone is enough for one changed repo.
- **gate** exits 0 when the stage is not selected or is complete, else `stage-incomplete`. **reopen** marks a stage incomplete.
- **check-shipped** exits 0 only when every changed repo is merged and its merge commit has a deploy of the repo's configured kind with status `succeeded` (`none` for a repo with no deploy). Otherwise `not-shipped` names what is missing.
- **deploy** records a deploy. `--kind` is `none`, `command`, `amplify`, `github-actions`, `merge` or `release`, and `--status` is `succeeded`, `failed`, `timeout` or `running`. `merge` and `release` never count as a deploy.

Failures: `usage`, `runs-disabled`, `no-ticket-folder`, `no-run`, `not-selected`, `stage-incomplete`, `not-shipped` and `corrupt`.

Consulting and configuration projects keep an evidence journal instead ([runs.md](runs.md)):

```
bollplank run check <project> <TICKET>
bollplank run init <project> <TICKET> --brief <file> --approval <ref> --instruction <ref> --review <value> --board-readback <file>
  [--agents <source>/AGENTS.md]
bollplank run plan <project> <TICKET> --path <file>
bollplank run code <project> <TICKET> --path <subject file>            (consulting only)
bollplank run stage <project> <TICKET> plan|code --revision <sha256> --verdict Approve|Revise --evidence <file>
bollplank run reopen <project> <TICKET> [plan|code] --reason <text>
bollplank run gate <project> <TICKET> [plan|code]
bollplank run change <project> <TICKET> --id <operation> --target <alias> --status intent|verified|failed|superseded --evidence <file>
  [--gate plan|code] [--reason <text> --residual none|corrected [--replacement <operation>]]
bollplank run verify <project> <TICKET> --check <name> --status pass|fail --evidence <file>
bollplank run complete <project> <TICKET>
bollplank run rebaseline <project> <TICKET> --brief <file> --approval <ref> --review <value> --board-readback <file>
  --reason <text> --authorization <ref> --scope-evidence <file> [--agents <source>/AGENTS.md]
bollplank run log <project> <TICKET> --event <text>
bollplank run show <project> <TICKET>
```

`--linear-readback` is another name for `--board-readback`. On Jira the readback's `id` is the issue key, `teamId` the site's cloud id and `projectId` the numeric project id. `--agents` must resolve to the project's `<source>/AGENTS.md`, stay inside the source folder, and be readable and not empty. The baseline keeps a copy and its sha256 as `agents`, which `run show` prints, and a rebaseline without `--agents` carries the latest copy forward. A run started without it has `agents` null or missing. These modes read the critic from the brief file's `Critic:` line. Failures: `usage`, `ticket-not-enabled`, `runs-disabled`, `no-run`, `stage-incomplete`, `refused`, `config` and `corrupt`.

## Shipping

### `bollplank turn`

```
bollplank turn take <TICKET> [--session <id>]
bollplank turn release <TICKET>
bollplank turn status
```

One shipping lock per machine. `take` succeeds when the lock is free or held by the same ticket. Only the holder releases, and a lock is never broken automatically. `status` reports the holder and for how long. Without a config it uses `~/.bollplank/ship.lock`. Failures: `held`, `no-holder` (a lock folder without a readable holder, to check and remove by hand) and `not-holder`.

### `bollplank merge`

```
bollplank merge <project> <repo> <pr> [--run <ticket folder>]
```

Squash merges a PR only when it is open, not a draft, targets the base branch, and every check in the repo's `checks` is present and green on its head. The checks come from the config, never from the PR. The merge uses `--match-head-commit`.

- **With `--run`,** the record and ticket folder must be this project's and ticket's, the repo one the ticket changes, and the PR the ticket's own: from the ticket branch in the configured repo, never a fork, and the PR the record has for the repo. A selected plan or code stage must be complete. The PR, head and merge commit are written to the record.
- **With a selected code stage,** the PR head must carry the change the last approved code round reviewed for this repo, compared by `git patch-id --verbatim` against the base. A clean rebase keeps the approval. A changed change, whitespace included, needs `run reopen` and a new round. It needs git 2.40 or later.
- **With `privateScan`,** the PR head, its history, its title and its body must pass the private name scan. The squash commit gets the scanned title and body.

A success has `merged`, `repo`, `pr`, `base`, `finalHead`, `mergeCommit`, `checks`, and `review` or the scan outcomes when they apply.

| Failure | Meaning |
|---|---|
| `not-open`, `draft`, `wrong-base` | The PR is closed or merged, a draft, or targets another branch. |
| `checks` | An expected check is missing, not finished or failed. |
| `no-run` | `--run` names a folder without `.run.json`. |
| `run-mismatch` | The record, folder or PR is not this ticket's. |
| `stage-incomplete` | A selected stage is not complete. |
| `no-checkout` | The review check could not use or fetch into the source checkout. |
| `review-stale` | The PR head is not the change the last approved code round reviewed. |
| `private-scan` | The scan failed or was skipped. It never prints a name. |
| `corrupt` | A record is not valid JSON. |
| `not-merged`, `gh-failed` | GitHub did not merge, or a `gh` call failed. |

### `bollplank deploy-wait`

```
bollplank deploy-wait <project> <repo> <commit> [--timeout <seconds>] [--interval <seconds>]
```

Waits for the deploy of one commit the way the repo's `deploy.kind` says ([config.md](config.md)) and exits 0 only on success. A `command` deploy runs in a clean checkout of the commit, never in the repo's own folder. `--timeout` defaults to 1800 and `--interval` to 15 seconds. A short `--timeout`, such as 30, only looks.

Every result has `ok`, `project`, `repo`, `commit`, `kind`, `status` (`succeeded`, `failed` or `timeout`), `ref` and `minutes`, ready for `run deploy`.

| Kind | Adds | Failures |
|---|---|---|
| `none` | `note` | none |
| `command` | `command`, `checkout` (`clean`), `nodeModules`, `exitCode`, `signal`, `output` | `deploy-failed`, `timeout` (the command and its children are stopped), `command-failed`, `no-checkout` (the repo's folder is not the top of a git repo), `commit-missing` (the fetch failed, or the commit is not on `origin/<baseBranch>` after it), `checkout-failed` (the checkout or its `node_modules` could not be made, or the checkout could not be removed), `interrupted` (deploy-wait was stopped, so it stopped the command and removed the checkout) |
| `amplify` | `appId`, `branch`, `region`, `jobId`, `jobStatus` | `deploy-failed`, `timeout`, `aws-failed` |
| `github-actions` | `github`, `workflow`, `filter` (`answer` and `reason`), `runId`, `runStatus`, `conclusion`, `url`, and `workflowFile` and `note` when no run was started | `deploy-failed`, `timeout`, `gh-failed` |

A `github-actions` deploy first reads the workflow's push trigger from its file at the commit. `filter.answer` is `runs`, `does-not-run` or `unknown`. When the trigger's branch or path filters exclude the push, so GitHub starts no run, and no run is there for the commit, it returns `succeeded` at once with `ref` `none` and a `note` that says no run was started. Otherwise it waits for the run. The filters are checked against the base branch of the pull request the commit merged and against the commit's changed files, so they are checked only for a commit that is the squash merge of one pull request. Any doubt gives `unknown`, which waits too: another trigger than `push` and `workflow_dispatch`, a tag filter, a commit that is not such a squash merge or that is also the head of another branch, a tag on the commit when the trigger has no branch filter, since a tag push ignores path filters, a pattern or YAML shape it cannot read, more than 300 changed files, or a failing `gh api` call. A timeout's `detail` then says why.

## The ledger

### `bollplank ledger`

```
bollplank ledger mark <TICKET>
bollplank ledger collect <TICKET> --created <iso> --approved <iso> --done <iso> [--shipped <iso>] [--run <ticket folder>]
  [--raised <TICKET,TICKET>] [--title <text>] [--write] [--markdown]
bollplank ledger rollup [--json]
```

Tokens per model for a ticket's brief (creation to approval) and implementation (approval to Done), and its timeline.

- **mark** prints `now working on <TICKET>`. Its own tool call in the session file is the marker: from there on, the session's tokens count for the ticket. Markers from another tool that writes the same kind of marker count too, and a session marked by both is listed on its own.
- **collect** splits the session files' tokens by marker and critic binding and prints the ledger and its comment. `--markdown` prints only the comment, `--write` replaces the ticket's rollup entry, and without `--shipped` the last successful deploy in `--run`'s record is used.
- **rollup** prints one row per ledgered ticket, or JSON with `--json`.

Failures: `usage` and `corrupt`.
