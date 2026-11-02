# Commands

Everything is one command, `bollplank <command> [options]`. `bollplank help` lists the commands. There is no `--help` for a single command, so this page is the reference.

Most commands are called by the skills, not typed by you. The ones you type are `init`, `doctor`, `update`, `uninstall`, `version` and sometimes `context` or `turn status`.

## Conventions

- **Output.** Each command prints one JSON object on stdout, with `"ok": true` or `"ok": false`. A failure has a `failure` code and usually a `detail`. The exceptions say so below: `init`, `doctor`, `update` and `uninstall` talk to a person and print JSON only with `--json`, and a few commands print text.
- **Exit codes.** `0` for success, `1` for a failure, `2` for a usage error (failure `usage`).
- **Options.** An option that takes a value and gets none, or gets another option instead, is a usage error. Unknown options are usage errors. List options take comma separated values, such as `--change acme-api,acme-web`.
- **Tickets** look like `ACME-1`. Lower case is accepted and turned into upper case.
- **Failures every command can give:** `usage`, `config` (the config is missing or does not validate) and `internal` (a bug, with the stack in `detail`).

## Setup

### `bollplank init [--answers <file>] [--offline]`

Finds the clients and their sign in, probes Linear from each client, picks the board names, asks for the approver, copy style and critic default, optionally adds a first project, writes the config and links the skills. See [setup.md](setup.md).

### `bollplank doctor [--offline] [--json]`

Checks the install and says what to fix. See [setup.md](setup.md).

### `bollplank update`

Moves the kit to the newest release tag, links new skills and prints the release's changelog section.

### `bollplank uninstall [--purge]`

Removes the links `init` made. `--purge` also removes the home folder, after you confirm.

### `bollplank version [--json]`

Prints the Workflow line every brief and comment carries, for example `Bollplank 0.1.0, build 12`. The version is the one in `package.json`, which equals the release tag. The build is the number of commits on the kit's base branch at the installed commit, so it grows by one per merged PR. A copy with commits that are not on the base branch adds ` plus unmerged commits`, and one with local changes adds `, with uncommitted changes`. Outside a git checkout the line ends `build unknown`. `--json` prints `{ "ok": true, "workflow": "..." }`.

### `bollplank context [<project>]`

Prints what a skill needs: `workflow`, `kit` (the kit folder), `approver`, `copyStyle`, `board` with its statuses, `critic`, and `projects` (the project names). With a project it adds `project`: `name`, `mode`, `runs`, `stopList`, `board`, `repos`, `shipOrder`, `privateScan`, `source` and `tickets`.

## The critic

### `bollplank critic`

```
bollplank critic --ticket <TICKET> --subject brief|plan|code --round <n> --prompt-file <file> --lead claude|codex
  [--critic other|same|claude|codex] [--read-dir <folder>] [--timeout <seconds>] [--model <m>] [--effort <e>]
```

Runs one critique round and returns the critique text. The lead posts it.

- `--prompt-file` is the prompt the lead filled from [prompts/critic.md](../prompts/critic.md) or [prompts/critic-same.md](../prompts/critic-same.md). The command fills `{REVIEWER}`, `{MODEL}` and `{WORKFLOW}`.
- `--lead` is the client running the session that calls the critic.
- `--critic` overrides `critic.default` for this call. `other` is the provider that is not `--lead`.
- `--read-dir` opens one source folder to the critic for reading. Claude Code gets it with `--add-dir` and with shell and edit tools denied. Codex gets it as its working folder in a read only sandbox. Without it, the critic runs in the empty `~/.bollplank/neutral` folder.
- `--timeout` defaults to 600 seconds.
- `--model` and `--effort` override the config for this call.

The critic gets no board access, no MCP servers and read tools only. Its environment loses every model key and provider setting. One session per ticket, provider and mode is reused across subjects, so the critic that reviewed the brief remembers it when it reviews the plan. Rounds count per subject: the call refuses with `round-mismatch` unless `--round` is one more than the rounds saved for this ticket, critic and subject. State is saved only after a well formed critique.

A success has `critic`, `mode` (`other`, `same` or `named`), `ticket`, `subject`, `round`, `sessionId`, `model`, `verdict` (`Approve` or `Revise`), `usage` and `text`.

| Failure | Meaning |
|---|---|
| `usage` | A missing or bad option, or a prompt file or read folder that cannot be read. |
| `round-mismatch` | The round is not the next one for this subject. `expected` says which is. |
| `critic-unavailable` | The chosen client is not found, not signed in, or signed in without a subscription. Nothing else is tried. |
| `timeout` | No answer within `--timeout`. |
| `client-error` | The client reported an error, such as a quota limit. |
| `exit` | The client exited abnormally. A critique that arrived before the exit is returned as `receivedReview` and is not counted as a round. |
| `empty-answer` | The client replied with nothing. |
| `malformed-answer` | The reply does not start with `Critique of ` or has no `Verdict:` line. |
| `state` | The saved critic state cannot be read. |

## Tickets and runs

### `bollplank ticket`

```
bollplank ticket create <project> <TICKET> --slug <slug> --change <repo,repo> [--validate <repo,repo>]
bollplank ticket refresh <project> <TICKET>
bollplank ticket status <project> <TICKET>
bollplank ticket remove <project> <TICKET>
```

For repository projects only. A ticket folder `<tickets>/<TICKET>` holds one git worktree per repo, side by side.

- **create** makes branch `<ticket>-<slug>` from `origin/<base branch>` in each repo the ticket changes, and a detached checkout of `origin/<base branch>` for each repo used only for validation. Repos named in `validatesAgainst` are added on their own. `node_modules` is cloned on macOS and copied elsewhere, only for repos with `cloneNodeModules`. When a step fails, the worktrees made before it are removed (`create-failed`, with `rolledBack`).
- **refresh** fetches every repo and moves validation checkouts to the latest base branch. It refuses before moving anything when one has local changes.
- **status** reports each worktree's head and changed file count.
- **remove** refuses when any worktree has uncommitted or untracked changes, or commits that are not on the base branch and not the merged head recorded by `bollplank merge --run`. Otherwise it removes the worktrees and the ticket branches.

Failures: `no-ticket-folder`, `exists`, `create-failed`, `refused`, `git-failed`.

### `bollplank run`

The run record, `.run.json` in the ticket folder. For repository projects:

```
bollplank run init <project> <TICKET> --review none|plan|code|both [--critic other|same|claude|codex]
bollplank run stage <project> <TICKET> plan|code --revision <sha or version> --verdict Approve|Revise [--points <n>] [--complete]
bollplank run reopen <project> <TICKET> plan|code --reason <text>
bollplank run gate <project> <TICKET> plan|code
bollplank run plan <project> <TICKET> --commit <sha> [--path <file>]
bollplank run deploy <project> <TICKET> <repo> --kind <kind> --status <status> [--ref <job or run>] [--commit <sha>]
bollplank run log <project> <TICKET> --event <text>
bollplank run show <project> <TICKET>
```

- **init** refuses with `runs-disabled` unless the project has `"runs": true`, and with `no-ticket-folder` before `bollplank ticket create`. `--review` comes from the brief's Cross-model review line. On an existing record it returns it for a resume.
- **stage** records a review round. The stage is complete when the verdict is `Approve`, or with `--complete` after every material point was sorted and the critic confirmed.
- **gate** exits 0 when the stage is not selected or is complete, and fails with `stage-incomplete` otherwise.
- **reopen** marks a stage incomplete after a change to covered behaviour.

Failures: `runs-disabled`, `no-ticket-folder`, `no-run`, `not-selected`, `stage-incomplete`.

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

`--linear-readback` is accepted as another name for `--board-readback`. [runs.md](runs.md) explains the journal. Failures: `ticket-not-enabled`, `runs-disabled`, `no-run`, `stage-incomplete`, `refused`, `config`.

## Shipping

### `bollplank turn`

```
bollplank turn take <TICKET> [--session <id>]
bollplank turn release <TICKET>
bollplank turn status
```

The shipping turn: one lock per machine, so one ticket ships at a time. `take` succeeds when the lock is free or already held by the same ticket, so a resumed run gets its turn back. Only the holder can release. A lock is never broken automatically. `status` reports the holder and for how many minutes it has held the turn. `turn` works without a config and then uses `~/.bollplank/ship.lock`.

Failures: `held` (another ticket holds it), `no-holder` (the lock folder exists without a readable holder record, perhaps a take in progress, so check and remove it by hand), `not-holder`.

### `bollplank merge`

```
bollplank merge <project> <repo> <pr> [--run <ticket folder>]
```

Squash merges a PR only when it is open, not a draft, targets the repo's base branch, and every check in the repo's `checks` is present, finished and green on its head commit. The expected checks come from the config, never from the PR. The merge is made with `--match-head-commit`, so GitHub refuses it when the branch moved after the checks ran.

- With `--run`, a selected plan or code stage in the run record must be complete, and the PR, final head and merge commit are written back to the record. `bollplank ticket remove` needs that record to recognise a squash merged branch.
- For a project with `privateScan`, the PR head and its history must pass the private name scan with the local list. A scan that is skipped because no list is present refuses the merge.

A success has `merged`, `repo`, `pr`, `base`, `finalHead`, `mergeCommit` and `checks`. Failures: `not-open`, `draft`, `wrong-base`, `checks`, `no-run`, `stage-incomplete`, `private-scan`, `not-merged`, `gh-failed`.

### `bollplank deploy-wait`

```
bollplank deploy-wait <project> <repo> <commit> [--timeout <seconds>] [--interval <seconds>]
```

Waits for the deploy of one commit the way the repo's `deploy.kind` says (see [config.md](config.md)), and exits 0 only when it succeeded. The timeout defaults to 1800 seconds and the poll interval to 15. A short `--timeout`, such as 30, only looks. The commit must be a hex commit id.

Failures: `deploy-failed`, `timeout`, `command-failed`, `aws-failed`, `gh-failed`.

## The ledger

### `bollplank ledger`

```
bollplank ledger mark <TICKET>
bollplank ledger collect <TICKET> --created <iso> --approved <iso> --done <iso> [--shipped <iso>] [--run <ticket folder>]
  [--raised <TICKET,TICKET>] [--title <text>] [--write] [--markdown]
bollplank ledger rollup [--json]
```

The ticket ledger counts tokens per model for a ticket's brief (creation to approval) and its implementation (approval to Done), and its timeline.

- **mark** prints `now working on <TICKET>`. The command's own tool call in the session file is the marker: from that response on, the session's tokens count for the ticket. Markers written by the private kit Bollplank replaces count too.
- **collect** reads the Claude Code and Codex session files written since the ticket was created, splits their tokens by marker and by critic binding, and prints JSON with the ledger and its comment text. `--markdown` prints only the comment. `--write` replaces the ticket's entry in the rollup. Without `--shipped`, the time of the last successful deploy in `--run`'s record is used. A session with markers from both kits is listed in its own section.
- **rollup** prints one table row per ledgered ticket, or JSON with `--json`.
