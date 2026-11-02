# Commands

Everything is one command, `bollplank <command> [options]`. `bollplank help` lists the commands. `bollplank <command> --help` (or `-h`) prints that command's usage line and exits 0, on every command. This page is the full reference.

Most commands are called by the skills, not typed by you. The ones you type are `init`, `doctor`, `update`, `uninstall`, `version` and sometimes `context` or `turn status`.

## Conventions

- **Output.** Each command prints one JSON object on stdout, with `"ok": true` or `"ok": false`. A failure has a `failure` code and usually a `detail`. The exceptions say so below: `init`, `doctor`, `update` and `uninstall` talk to a person and print JSON only with `--json`, and `version` prints text without `--json`.
- **Exit codes.** `0` for success, `1` for a failure, `2` for a usage error (failure `usage`) or an unknown command.
- **Options.** An option that takes a value and gets none, or gets another option instead, is a usage error. Unknown options are usage errors. List options take comma separated values, such as `--change acme-api,acme-web`.
- **Tickets** look like `ACME-1`. Lower case is accepted and turned into upper case.
- **Failures every command can give:** `usage`, `config` (the config is missing or does not validate) and `internal` (a bug, with the stack in `detail`). A command that reads a record or state file that is not valid JSON fails with `corrupt` and names the file in `file`. It never crashes on one and never rewrites it.

## Setup

### `bollplank init [--answers <file>] [--offline] [--json]`

Finds the clients and their sign in, reads Linear from each client, picks the board names, asks for the approver, copy style and critic default, optionally adds a first project, writes the config, links the skills and runs `doctor`. Without a terminal it needs `--answers`. `--json` prints the result as JSON and asks its questions on stderr. See [setup.md](setup.md) for the steps and the answers file.

Failures: `usage` (no terminal and no answers file, an answers file that cannot be read or is not one JSON object, or a required answer that is missing), `config` (the answers do not make a valid config, so nothing was written), `corrupt` (the install record cannot be read, so init stops before it asks anything) and `stopped` (the questions were interrupted).

### `bollplank doctor [--offline] [--json]`

Checks the install and says what to fix. It exits 1 when a required check fails. `--json` prints `{ ok, offline, checks }`, where each check has `id`, `name`, `required`, `ok`, `detail` and `fix`, and `skipped` when `--offline` skipped it. See [setup.md](setup.md) for the checks.

### `bollplank update [--pre] [--json]`

Moves the kit to the newest release tag, links the skills again and prints the release's changelog section. `--pre` also takes pre-release tags such as `v1.2.0-rc.1`. It only moves forward: a kit whose `package.json` version is newer than every tag stays where it is and reports `ahead`.

A success has `kit`, `installed`, `tag`, `already`, `ahead`, `from`, `to`, `links` and `changelog`. Failures: `not-a-checkout` (the kit is not a git checkout, or is a folder inside another checkout), `corrupt` (the kit's `package.json` or the install record cannot be read), `local-changes`, `fetch`, `no-release` and `checkout`.

### `bollplank uninstall [--purge] [--yes] [--json]`

Removes the links recorded in `~/.bollplank/install.json` that still point into the kit, and nothing else. `--purge` also removes the home folder after you confirm on a terminal, or with `--yes`.

A success has `removed`, `left`, `home`, `purged`, `kept` and `command`, the way to run Bollplank from now on. Failures: `usage` (`--purge` without a terminal and without `--yes`), `lock-held` (`--purge` while the ship lock is held), `unsafe-purge` (`--purge` on a folder that is not a Bollplank home) and `corrupt` (the install record cannot be read). The `lock-held` and `unsafe-purge` checks run before any link is removed. See [setup.md](setup.md).

### `bollplank version [--json]`

Prints the Workflow line every brief and comment carries, for example `Bollplank 0.1.0, build 12`. The version is the one in `package.json`, which equals the release tag. The build is the number of commits on the kit's base branch at the installed commit, so it grows by one per merged PR. A copy with commits that are not on the base branch adds ` plus unmerged commits`, and one with local changes adds `, with uncommitted changes`. Outside a git checkout the line ends `build unknown`. `--json` prints `{ "ok": true, "workflow": "..." }`.

### `bollplank context [<project>]`

Prints what a skill needs: `workflow`, `kit` (the kit folder), `approver`, `copyStyle`, `board` with its statuses, `critic`, `projects` (the project names) and `boards`. `boards` maps each project name to its board `team` and `project`, taken from the project's `board`, else from the top level `board.team` and `board.project`, else `null`. A skill uses it to find which project an issue belongs to, so it is there with or without a project.

With a project it adds `project`: `name`, `mode`, `runs`, `stopList`, `board` (the project's own `board` entry, without the top level defaults), `repos`, `shipOrder`, `privateScan`, `critic`, `source` and `tickets`. `project.critic` is the critic default that applies to the project: `{ "default": ..., "from": "project" }` when the project sets its own `critic.default`, else the top level one with `"from": "config"`.

## The critic

### `bollplank critic`

```
bollplank critic --ticket <TICKET> --subject brief|plan|code --round <n> --prompt-file <file> --lead claude|codex
  [--project <name>] [--critic other|same|claude|codex] [--read-dir <folder>] [--timeout <seconds>] [--model <m>] [--effort <e>] [--new-session]
```

Runs one critique round and returns the critique text. The lead posts it.

- `--prompt-file` is the prompt the lead filled from [prompts/critic.md](../prompts/critic.md) or [prompts/critic-same.md](../prompts/critic-same.md). The lead fills `{TICKET}`, `{ROUND}`, `{SUBJECT}`, `{SUBJECT_SHORT}`, `{DATE}`, `{ROUND_NOTE}` and `{BODY}`. The command fills `{REVIEWER}`, `{MODEL}` and `{WORKFLOW}`. `{ROUND_NOTE}` is "Review the whole subject." in round 1. In later rounds it asks the critic to review what changed since its last round plus anything it missed, with its earlier rounds and the responses in `{BODY}`.
- `--lead` is the client running the session that calls the critic.
- `--project` takes the default from that project's `critic.default`, else from the top level `critic.default`. An unknown project is a usage error.
- `--critic` overrides both defaults for this call. The critique skill passes the brief's approved `Critic:` line here, so it wins over the project. `other` is the provider that is not `--lead`.
- `--read-dir` opens one source folder to the critic for reading. Without it, the critic runs in the empty `~/.bollplank/neutral` folder.
- `--timeout` defaults to 600 seconds and must be above 0.
- `--model` and `--effort` override the config for this call.
- `--new-session` starts a fresh critic session and keeps the saved round counts. Use it after `session-missing`.

**What the critic gets.** No board, no MCP servers and no connectors, for either provider. Its environment loses every model key, provider route and client session marker (see [SECURITY.md](../SECURITY.md)).

- Claude Code runs with `--strict-mcp-config`, `--setting-sources local` and `ENABLE_CLAUDEAI_MCP_SERVERS=false`, so neither configured servers nor claude.ai connectors load. Without `--read-dir` it has no tools at all. With `--read-dir` it has only `Read`, `Grep` and `Glob`, allowed inside that folder only, with shell and edit tools denied.
- Codex runs `codex exec` in a read only sandbox, signed in with ChatGPT only (`forced_login_method="chatgpt"`) and with `model_provider` pinned to `openai`, so a profile or provider in its config cannot move it onto a key. Every MCP server Codex lists for the working folder is switched off by name, and the list is read again to confirm that none is left on. Connectors (apps), plugins, browsers, computer use, image generation, sub agents, memories, tool suggestions, hooks and skill installs are switched off, and `web_search` is disabled. `--read-dir` is its working folder.
- The event stream is checked as well. The call fails with `critic-used-tools`, and its text is never returned, when a Claude Code critic starts an MCP server, is offered a tool beyond the allowed reads or calls one. The same goes for a Codex critic that makes an MCP call, a file change, a web search or any other item than a message, reasoning, a read only command, a todo list or an error.

**Sessions and rounds.** One session per ticket, provider and mode is reused across subjects, so the critic that reviewed the brief remembers it when it reviews the plan. Rounds count per subject: the call refuses with `round-mismatch` unless `--round` is one more than the rounds saved for this ticket, critic and subject. State is saved only after a well formed critique. One call per ticket, provider and mode runs at a time. Another one fails with `critic-busy`. Every call with a known session is bound to its ticket in the ledger, failed calls too.

**The header.** The command owns the critique's `Reviewer:`, `Model:` and `Workflow:` lines. It rewrites them in the returned text, or inserts them under the `Critique of` line, whatever the critic wrote. `Reviewer:` is `Claude Code` or `Codex`, with `, same provider, separate session` for a critic of the lead's own provider. `Model:` is the model the client reported with the effort it was given: for Claude Code the model in the result's `modelUsage`, for Codex the model and effort in its session file. When the client reports none, it is the pinned `model` and `effort` from the options or the config, and with no pin it is `Unverified`. With a pinned model, a Claude Code line names the pin. The critic writes the other header lines, including `Round:`.

A success has `critic`, `mode` (`other`, `same` or `named`), `ticket`, `subject`, `round`, `sessionId`, `sessionRestarted` (only with `--new-session`), `model`, `verdict` (`Approve` or `Revise`), `usage` and `text`. Every failure has `critic`, `mode`, `ticket`, `subject` and `round`, and `sessionId` once one is known.

| Failure | Meaning |
|---|---|
| `usage` | A missing or bad option, or a prompt file or read folder that cannot be read. |
| `critic-unavailable` | The chosen client is not found, not signed in, or signed in without a subscription, or Codex could not switch off all of its MCP servers. Nothing else is tried. A client that is not found is reported before `round-mismatch`, and finding it runs nothing. The sign in is read after the round check, and its result is in `signIn`. |
| `critic-busy` | Another call for this ticket, provider and mode is running. The detail names the lock folder to remove if none is. |
| `round-mismatch` | The round is not the next one for this subject. `expected` says which is. No client runs. |
| `state` | The saved critic state cannot be read. |
| `session-missing` | The client no longer has the saved session. Retry with `--new-session`. The round counts are kept. |
| `critic-used-tools` | The critic was given or used a tool, an MCP server or a connector. The reply was not used. |
| `timeout` | No answer within `--timeout`. `seconds` says how long. |
| `client-error` | The client reported an error. Quota and usage limits arrive this way. |
| `exit` | The client exited abnormally or did not start. A critique that arrived before the exit is returned as `receivedReview` and is not counted as a round. |
| `empty-answer` | The client replied with nothing. |
| `malformed-answer` | The reply does not start with `Critique of ` or has no `Verdict:` line. `head` shows its start. |

## Tickets and runs

### `bollplank ticket`

```
bollplank ticket create <project> <TICKET> --slug <slug> --change <repo,repo> [--validate <repo,repo>]
bollplank ticket refresh <project> <TICKET>
bollplank ticket status <project> <TICKET>
bollplank ticket remove <project> <TICKET> [--force-ignored]
```

For repository projects only. A ticket folder `<tickets>/<TICKET>` holds one git worktree per repo, side by side, and the folder record `.ticket.json`.

- **create** makes branch `<ticket>-<slug>` from `origin/<base branch>` in each repo the ticket changes, and a detached checkout of `origin/<base branch>` for each repo used only for validation. Repos named in `validatesAgainst` are added on their own. `node_modules` is cloned on macOS and copied elsewhere, only for repos with `cloneNodeModules`. When a step fails, the worktrees made before it are removed (`create-failed`, with `rolledBack`).
- **refresh** fetches every repo and moves validation checkouts to the latest base branch. It refuses before moving anything when one has local changes.
- **status** reports each worktree's head and changed file count.
- **remove** refuses when a worktree has uncommitted or untracked changes, or ignored files other than `node_modules`. It also refuses when the worktree's head, or the ticket branch itself, has commits that are not on `origin/<base>` and are not the merged head that `bollplank merge --run` recorded. The branch is checked even when the worktree is detached or its folder is gone. `--force-ignored` lets removal delete the listed ignored files. Nothing forces past the other refusals. Otherwise it removes the worktrees, the ticket branches and the records.

Failures: `usage`, `no-ticket-folder`, `exists`, `create-failed`, `refused` (with `refusals`, and `ignored` listing the ignored files per repo), `corrupt` and `git-failed`.

### `bollplank run`

The run record, `.run.json` in the ticket folder. For repository projects:

```
bollplank run init <project> <TICKET> --review none|plan|code|both [--critic other|same|claude|codex]
bollplank run stage <project> <TICKET> plan --revision <sha or version> --verdict Approve|Revise [--points <n>] [--complete]
bollplank run stage <project> <TICKET> code --revision <sha> | --revisions <repo>=<sha>,<repo>=<sha> --verdict Approve|Revise [--points <n>] [--complete]
bollplank run reopen <project> <TICKET> plan|code --reason <text>
bollplank run gate <project> <TICKET> plan|code
bollplank run plan <project> <TICKET> --commit <sha> [--path <file>]
bollplank run deploy <project> <TICKET> <repo> --kind <kind> --status <status> [--ref <ref>] [--commit <sha>]
bollplank run log <project> <TICKET> --event <text>
bollplank run show <project> <TICKET>
bollplank run check-shipped <project> <TICKET>
```

- **init** refuses with `runs-disabled` unless the project has `"runs": true`, and with `no-ticket-folder` before `bollplank ticket create`. `--review` comes from the brief's Cross-model review line, and `--critic` from its `Critic:` line when it has one. On an existing record it returns it for a resume.
- **stage** records a review round. The stage is complete when the verdict is `Approve`, or with `--complete` after every material point was sorted and the critic confirmed. A code round names the reviewed head of each repo the ticket changes, with `--revisions acme-api=<sha>,acme-web=<sha>`, and the round keeps them as `revisions`. `--revision` alone is enough when the ticket folder changes one repo, and is refused when it changes more. A pair that names a repo the ticket does not change, a repo twice, or both options at once is a usage error.
- **gate** exits 0 when the stage is not selected or is complete, and fails with `stage-incomplete` otherwise.
- **reopen** marks a stage incomplete after a change to covered behaviour, or after `bollplank merge` refused with `review-stale`.
- **check-shipped** exits 0 only when every repo the ticket folder's `.ticket.json` changes is merged, as `bollplank merge --run` recorded it, and the latest deploy recorded for that repo's merge commit has status `succeeded`. A deploy recorded for another commit does not count. The result has `shipped` and, per repo in ship order, `merged`, `mergeCommit`, `pr`, `deployed` and `deploy`. Otherwise it fails with `not-shipped`, and the detail names each repo that is not merged or not deployed. The run and accept skills check it before the issue moves to acceptance or Done.
- **deploy** records a deploy. `--kind` is one of `none`, `command`, `amplify`, `github-actions`, `merge` and `release`, and `--status` one of `succeeded`, `failed`, `timeout` and `running`. The first four kinds and the first three statuses are what `deploy-wait` reports, so its `kind`, `status` and `ref` go straight in. `merge` and `release` record a step that is not a `deploy-wait` kind. A second entry with the same repo, kind and ref replaces the first.

Failures: `usage`, `runs-disabled`, `no-ticket-folder`, `no-run`, `not-selected`, `stage-incomplete`, `not-shipped` and `corrupt` (a run record or ticket folder record that is not valid JSON or not an object).

Consulting and configuration projects use the same command with an evidence journal:

```
bollplank run check <project> <TICKET>
bollplank run init <project> <TICKET> --brief <file> --approval <reference> --instruction <reference> --review <value> --board-readback <file>
bollplank run plan <project> <TICKET> --path <file>
bollplank run code <project> <TICKET> --path <subject file>            (consulting only)
bollplank run stage <project> <TICKET> plan|code --revision <sha256> --verdict Approve|Revise --evidence <file>
bollplank run reopen <project> <TICKET> [plan|code] --reason <text>
bollplank run gate <project> <TICKET> [plan|code]
bollplank run change <project> <TICKET> --id <operation> --target <alias> --status intent|verified|failed|superseded --evidence <file>
  [--gate plan|code] [--reason <text> --residual none|corrected [--replacement <operation>]]
bollplank run verify <project> <TICKET> --check <name> --status pass|fail --evidence <file>
bollplank run complete <project> <TICKET>
bollplank run rebaseline <project> <TICKET> --brief <file> --approval <reference> --review <value> --board-readback <file>
  --reason <text> --authorization <reference> --scope-evidence <file>
bollplank run log <project> <TICKET> --event <text>
bollplank run show <project> <TICKET>
```

`--linear-readback` is accepted as another name for `--board-readback`. These modes read the critic from the brief file's `Critic:` line. [runs.md](runs.md) explains the journal. Failures: `usage`, `ticket-not-enabled`, `runs-disabled`, `no-run`, `stage-incomplete`, `refused`, `config` and `corrupt`.

## Shipping

### `bollplank turn`

```
bollplank turn take <TICKET> [--session <id>]
bollplank turn release <TICKET>
bollplank turn status
```

The shipping turn: one lock per machine, so one ticket ships at a time. `take` succeeds when the lock is free or already held by the same ticket, so a resumed run gets its turn back. Only the holder can release. A lock is never broken automatically. `status` reports the holder and for how many minutes it has held the turn. `turn` works without a config and then uses `~/.bollplank/ship.lock`.

Failures: `held` (another ticket holds it), `no-holder` (the lock folder exists without a readable holder record, perhaps a take in progress, so check and remove it by hand) and `not-holder`.

### `bollplank merge`

```
bollplank merge <project> <repo> <pr> [--run <ticket folder>]
```

Squash merges a PR only when it is open, not a draft, targets the repo's base branch, and every check in the repo's `checks` is present, finished and green on its head commit. The expected checks come from the config, never from the PR. The merge is made with `--match-head-commit`, so GitHub refuses it when the branch moved after the checks ran.

- **With `--run`,** the run record and the ticket folder must be for this merge: the record's project is this project, the folder's `.ticket.json` exists and names the same project and ticket, and the repo is one the ticket changes. The PR must be the ticket's own: its head branch (`headRefName`) is the ticket branch in `.ticket.json`, and once the run record has a PR for the repo, it is that PR. This holds whether or not a review stage is selected. Otherwise the merge refuses with `run-mismatch`. A selected plan or code stage must be complete. The PR, final head and merge commit are written back to the record. `bollplank ticket remove` needs that record to recognise a squash merged branch.
- **With a selected code stage,** the PR head must carry the change the last approved code round reviewed for this repo, its entry in the round's `revisions`. A round with one plain `revision` counts only for a ticket that changes one repo. A round with no entry for the repo refuses with `review-stale`. The PR head is fetched into the source checkout, and for both commits the change from where it left `origin/<base>` is compared by `git patch-id --verbatim`, never by commit. The verbatim patch id keeps whitespace, so an indentation change, such as a Python line moved into or out of a block, needs a new review. It ignores line numbers, so a clean rebase keeps the patch id and the approval. A changed change refuses with `review-stale`. Then run `bollplank run reopen <project> <TICKET> code --reason "..."`, review the PR head and record the new round. An approved revision that is not a commit in the source checkout is `review-stale` too, and so is every review check when the git in use has no `patch-id --verbatim` (git 2.40 and later have it).
- **For a project with `privateScan`,** the PR head and its whole history must pass the private name scan with the local list, and so must the PR's title and body. The squash commit then gets that scanned title, with ` (#<pr>)`, as its subject and the scanned body as its body, so GitHub never writes unscanned text into history. A scan that is skipped because no list is present refuses the merge.

A success has `merged`, `repo`, `pr`, `base`, `finalHead`, `mergeCommit` and `checks`. It adds `review` (`approved`, `approvedPatchId`, `headPatchId`) with a code stage, and the `privateScan` and `messageScan` outcomes for a `privateScan` project. Every failure has `merged: false`, `repo` and `pr`.

| Failure | Meaning |
|---|---|
| `not-open`, `draft`, `wrong-base` | The PR is closed or merged, a draft, or targets another branch. |
| `checks` | An expected check is missing, not finished or failed. `checks` lists each one. |
| `no-run` | `--run` names a folder without `.run.json`. |
| `run-mismatch` | The run record or ticket folder is for another project, ticket or repo, or the PR is not the ticket's: its head branch is not the ticket branch, or the record has another PR for the repo. |
| `stage-incomplete` | A selected plan or code stage is not complete. |
| `no-checkout` | The code review check needs the source checkout, or could not fetch the PR head into it. |
| `review-stale` | The PR head is not the change the last approved code round reviewed for this repo, the round names no head for the repo, or git cannot compare them verbatim. |
| `private-scan` | The scan of the PR head, or of its title and body, failed or was skipped. It names patterns by number and never prints a name. |
| `corrupt` | The run record or ticket folder record is not valid JSON or not an object. |
| `not-merged`, `gh-failed` | GitHub did not complete the merge, or a `gh` call failed. |

### `bollplank deploy-wait`

```
bollplank deploy-wait <project> <repo> <commit> [--timeout <seconds>] [--interval <seconds>]
```

Waits for the deploy of one commit the way the repo's `deploy.kind` says (see [config.md](config.md)), and exits 0 only when it succeeded. The commit must be a hex commit id. The timeout defaults to 1800 seconds and the poll interval to 15. `--interval` must be at least 1. A short `--timeout`, such as 30, only looks. A resumed run looks with `--timeout 30`, and a `timeout` status then means the deploy has no end yet.

Every result has `ok`, `project`, `repo`, `commit`, `kind`, `status`, `ref` and `minutes`. `status` is `succeeded`, `failed` or `timeout`, and `ok` is true only for `succeeded`. `ref` is the Amplify job id, the workflow run id, the command, or `none`. `bollplank run deploy` records the same `status` and `ref`. Any status but `succeeded` comes with a `failure` and a `detail`. Each kind adds its own details:

| Kind | Adds | Failures |
|---|---|---|
| `none` | `note` | none |
| `command` | `command`, `exitCode`, `signal`, `output` (the last 20 lines) | `deploy-failed` (a non zero exit), `timeout` (the command and every program it started are stopped), `command-failed` (it could not start) |
| `amplify` | `appId`, `branch`, `region`, `jobId`, `jobStatus` | `deploy-failed`, `timeout`, `aws-failed` |
| `github-actions` | `github`, `workflow`, `runId`, `runStatus`, `conclusion`, `url` | `deploy-failed`, `timeout`, `gh-failed` |

An `aws-failed` or `gh-failed` lookup also has status `failed`. An unknown deploy kind fails with `config`.

## The ledger

### `bollplank ledger`

```
bollplank ledger mark <TICKET>
bollplank ledger collect <TICKET> --created <iso> --approved <iso> --done <iso> [--shipped <iso>] [--run <ticket folder>]
  [--raised <TICKET,TICKET>] [--title <text>] [--write] [--markdown]
bollplank ledger rollup [--json]
```

The ticket ledger counts tokens per model for a ticket's brief (creation to approval) and its implementation (approval to Done), and its timeline.

- **mark** prints `now working on <TICKET>`. The command's own tool call in the session file is the marker: from that response on, the session's tokens count for the ticket. Markers written by `aw-ledger mark` of the private kit Bollplank replaces count too.
- **collect** reads the Claude Code and Codex session files written since the ticket was created, splits their tokens by marker and by critic binding, and prints JSON with the ledger and its comment text. `--markdown` prints only the comment. `--write` replaces the ticket's entry in the rollup. Without `--shipped`, the time of the last deploy with status `succeeded` in `--run`'s record is used. A session with markers from both kits is listed in its own section.
- **rollup** prints one table row per ledgered ticket, or JSON with `--json`.

Failures: `usage` and `corrupt` (a run record or rollup store that is not valid JSON).
