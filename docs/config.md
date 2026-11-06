# Configuration

Bollplank reads `~/.bollplank/config.json` (or `$BOLLPLANK_HOME/config.json`) on every command and validates it first. A config that does not validate stops the command with failure `config` and says what to fix. `bollplank init` writes it, and you can edit it by hand.

[examples/config.example.json](../examples/config.example.json) is a complete example, which the gate validates. [schema/config.schema.json](../schema/config.schema.json) describes the shape for editors. Paths may start with `~/`. A relative `source`, `tickets` or `shipLock` is resolved against the config's folder.

## Top level

| Key | Required | Default | Meaning |
|---|---|---|---|
| `approver.name` | yes | | The person whose explicit words approve a brief and accept a ticket. Approval lines name them exactly. |
| `copyStyle` | no | empty | How briefs and comments are written. |
| `board.kind` | yes | | `linear`, the only board. |
| `board.team`, `board.project` | no | | The Linear team key and project for projects that name none. |
| `board.statuses` | no | Linear's suggestion | The status names for `draft`, `ready`, `inProgress`, `acceptance` and `done`, for projects that map none of their own. Linear's suggestion is `Draft`, `Ready`, `In Progress`, `Acceptance`, `Done`. |
| `critic.default` | no | `other` | `other`, `same`, `claude` or `codex`. |
| `critic.providers.<claude or codex>` | no | | `model` and `effort` for that critic. |
| `critic.same.<claude or codex>` | no | `critic.providers` | `model` and `effort` for a same provider critic. |
| `shipLock` | no | `~/.bollplank/ship.lock` | The shipping lock folder. |
| `projects` | yes | | One entry per project, by name. |

A status is used only by its exact name. Each state's name comes from the project's own `board.statuses`, then the top level `board.statuses`, then Linear's suggestion. A key other than the five states, such as `in_progress`, fails validation, since it would leave the state at its fallback. [existing-project.md](existing-project.md) shows a mapping.

**The critic.** `other` is the client that is not leading. `same` is the lead's own client in a separate session ([same-model.md](same-model.md)). `claude` or `codex` names one, and when it equals the lead the review counts as same provider. A project's `critic.default` wins over the top level one, a brief's approved `Critic:` line wins over both, and `bollplank critic --critic` overrides them for one call. Nothing switches on its own. Nothing is pinned by default, so each client runs its own default model.

**The ship lock** is a folder with a `holder.json` of `ticket`, `session`, `since` and `pid`. Point `shipLock` at the lock of another tool that writes the same record, and a turn held by either blocks the other.

## Projects

| Key | Required | Default | Meaning |
|---|---|---|---|
| `mode` | no | `repository` | `repository`, `consulting` or `configuration` ([runs.md](runs.md)). |
| `source` | yes | | The folder holding the repo checkouts, one subfolder per repo. |
| `tickets` | yes | | The folder for ticket folders and run records. |
| `repos` | repository: yes | `{}` | The repos, by name. A configuration project has none. |
| `validatesAgainst` | no | `{}` | For each repo, the repos its changes are checked against, read only. |
| `shipOrder` | no | the order of `repos` | The merge and deploy order. When given, it lists every repo exactly once. |
| `critic.default` | no | the top level one | The critic for this project's tickets. |
| `board.team`, `board.project` | no | the top level ones | The Linear team key and project for this project's issues. When given, each is a name, not empty. |
| `board.statuses` | no | the top level ones | This project's own status names, for a team whose statuses differ. |
| `board.teamId`, `board.projectId` | consulting and configuration | | The Linear ids a readback is compared against. |
| `runs` | no | `false` | Ticket runs are allowed only when `true`. |
| `privateScan` | no | `false` | `bollplank merge` scans the PR head, history, title and body for private names. |
| `stopList` | no | `[]` | What a run stops and asks about. Empty means the run skill's own list. |

### Repos

| Key | Required | Default | Meaning |
|---|---|---|---|
| `github` | yes | | `owner/name`. |
| `checks` | with runs | | The PR checks that must be green before a merge. At least one when the project's `runs` is `true`. Merge refuses a repo without them. |
| `baseBranch` | no | the remote's default, else `master` | The branch work starts from and merges into. |
| `cloneNodeModules` | no | `false` | Copy `node_modules` into each worktree. An APFS clone on macOS. |
| `disposable` | no | `[]` | Ignored paths that `bollplank ticket remove` deletes without asking, such as build output. See below. |
| `deploy` | no | `{ "kind": "none" }` | How `bollplank deploy-wait` knows a merge is deployed. |

| `deploy.kind` | Keys | What `deploy-wait` does |
|---|---|---|
| `none` | | Returns at once. |
| `command` | `command` | Runs the command with `{commit}` replaced by the merge commit and uses its exit code. It runs in a clean, detached checkout of the merge commit, made for the call in a temporary folder and removed after it. `node_modules` is cloned in when the repo has `cloneNodeModules`. No other ignored file is, so a command that needs one, such as `.env`, gets it another way. The commit must be on `origin/<baseBranch>`, which is fetched first when the commit is not there yet. A repo without `origin/HEAD` needs `baseBranch` when its base is not `master`. |
| `amplify` | `appId`, `region`, optional `branch` and `profile` | Waits for the Amplify job whose commit is the merge commit. `branch` defaults to the base branch. `profile` sets `AWS_PROFILE`. |
| `github-actions` | `workflow` | Waits for the named workflow's run on the merge commit. The newest run decides. `workflow` is its name, file name or id. When the workflow's push filters, read from its file at the merge commit, exclude the merge, GitHub starts no run, so it returns at once. Whenever it cannot tell, it waits. |

**Disposable paths.** `ticket remove` refuses ignored files other than `node_modules`, since an ignored file can be real work, such as a `.env` or local notes. List what your gates rebuild every time, and remove deletes those without asking, for example `["dist/", "packages/*/dist/", "**/*.tsbuildinfo"]`. A pattern is matched against the path from the repo root. `*` is any run of characters within one folder name, and `**` is a whole folder name that stands for zero or more folders. A trailing `/` names a folder only, and so does a final `/**`. A pattern without either names a file or a folder. A path inside a matching folder matches too. Git reports a folder whose contents are all ignored as one entry, so a file pattern such as `**/*.tsbuildinfo` does not cover a folder that holds such a file. List the folder. Validation refuses an absolute path, a `.` or `..` folder, the characters `? [ ] { } ! \` and a pattern without a letter or digit, such as `**/*` or `*.*`, which would match almost anything. Patterns reach into submodules too, matched against the path from the repo root, so `lib/dist/` covers the build output of a submodule at `lib`. List build output only. Remove deletes whatever matches without asking, and names it in its output.

### Consulting and configuration projects

| Key | Mode | Meaning |
|---|---|---|
| `ticketPrefix` | consulting, required | Capital letters and digits. Every ticket with it can run. |
| `allowedTickets` | configuration, required | The ticket ids that can run, such as `ACME-7`. |
| `targets` | both, required | Named targets. Journal labels, not access grants. |
| `runbook` | both, required | The runbook the lead reads before a run. |
| `verificationChecks` | both, required | Unique check names that must pass before a run completes. |
| `protectedProjects` | both, optional | Names the lead must not touch. Guidance, not access control. |

A journal project's whole config entry is hashed at the start of a run. A later change stops the run until `bollplank run rebaseline`.
