# Configuration

Bollplank reads `~/.bollplank/config.json` (or `$BOLLPLANK_HOME/config.json`) on every command and validates it first. A config that does not validate stops the command with failure `config` and a list of what to fix. `bollplank init` writes the file. You can edit it by hand.

[schema/config.schema.json](../schema/config.schema.json) describes the same shape for editors. `lib/config.mjs` is what Bollplank enforces. [examples/config.example.json](../examples/config.example.json) is a complete example, and the gate validates it on every PR.

Paths may start with `~/` for your home folder. A relative path in the config, for a project's `source` and `tickets` and for `shipLock`, is resolved against the folder the config file is in, so it never depends on where a later command runs.

## A short example

```json
{
  "approver": { "name": "Ada" },
  "copyStyle": "Plain sentences. No filler.",
  "board": { "kind": "linear" },
  "critic": { "default": "other" },
  "projects": {
    "acme-shop": {
      "source": "~/Code/acme",
      "tickets": "~/Code/acme/Tickets",
      "repos": {
        "acme-api": { "github": "acme/acme-api", "checks": ["checks"], "deploy": { "kind": "github-actions", "workflow": "deploy" } }
      },
      "board": { "team": "ACME", "project": "Shop" },
      "runs": true
    }
  }
}
```

## Top level

| Key | Required | Default | Meaning |
|---|---|---|---|
| `approver.name` | yes | | The person whose explicit words approve a brief and accept a ticket. Approval lines must name them exactly, since the run helper matches the name. |
| `copyStyle` | no | empty | How briefs and comments are written. Skills read it from `bollplank context`. |
| `board.kind` | yes | | `linear`. It is the only board. |
| `board.team`, `board.project` | no | | The Linear team key and project for projects whose own `board` names none. `bollplank context` uses them in its `boards` map. `bollplank init` writes them. |
| `board.statuses` | no | `Draft`, `Ready`, `In Progress`, `Acceptance`, `Done` | Your names for the keys `draft`, `ready`, `inProgress`, `acceptance` and `done`. A status is used only by its exact name. |
| `critic.default` | no | `other` | `other`, `same`, `claude` or `codex`. See below. |
| `critic.providers.<claude or codex>` | no | | `model` and `effort` for that critic. |
| `critic.same.<claude or codex>` | no | | `model` and `effort` for a same provider critic. Falls back to `critic.providers`. |
| `shipLock` | no | `~/.bollplank/ship.lock` | The shipping lock folder. |
| `projects` | yes | | One entry per project, by name. |

### Critic

- `other` is the provider that is not leading. In a Claude Code session the critic is Codex, and the reverse.
- `same` is the lead's own provider in a separate session. See [same-model.md](same-model.md).
- `claude` or `codex` names one. When it equals the lead, the review counts as same provider.

A project can set its own `critic.default`, which wins over the top level one for its tickets. `bollplank context <project>` shows the one that applies, and `bollplank critic --project <name>` uses it. A brief can name its critic in a `Critic:` header line, which wins over both for that ticket once approved. `bollplank critic --critic` overrides the defaults for one call. Nothing switches the critic on its own. When the chosen client is missing or not signed in with a subscription, the call fails with `critic-unavailable`.

`model` and `effort` are passed to the client. Nothing is pinned by default, so the client runs its own default model. The posted critique's `Model:` line is the model the client reported it ran, with the effort it was given. When the client reports none, the line is the pinned `model` and `effort`, and with no pin it reads `Unverified`. With a pinned model, a Claude Code line names the pin. See [commands.md](commands.md#bollplank-critic).

### Ship lock

Only one ticket ships at a time on a machine. The lock is a folder with a `holder.json` record of `ticket`, `session`, `since` and `pid`. Point `shipLock` at another kit's lock folder that writes the same record, and a turn held by either one blocks the other.

## Projects

| Key | Required | Default | Meaning |
|---|---|---|---|
| `mode` | no | `repository` | `repository`, `consulting` or `configuration`. See [runs.md](runs.md). |
| `source` | yes | | The folder holding the project's repo checkouts, one subfolder per repo name. |
| `tickets` | yes | | The folder for ticket folders and run records. |
| `repos` | repository: yes | `{}` | The repos, by name. A repository project needs at least one. A configuration project has none. |
| `validatesAgainst` | no | `{}` | For each repo, the repos its changes are validated against. They are checked out alongside, read only. |
| `shipOrder` | no | the order of `repos` | The order repos merge and deploy in. When given, it lists every configured repo exactly once, so no repo a ticket changes can be left out of a ship. |
| `critic.default` | no | the top level `critic.default` | `other`, `same`, `claude` or `codex`, for this project's tickets. |
| `board.team`, `board.project` | no | the top level `board.team` and `board.project` | The Linear team key and project name for this project's issues. |
| `board.teamId`, `board.projectId` | consulting and configuration: yes | | The Linear ids the run helper compares a readback against. |
| `runs` | no | `false` | Ticket runs are allowed only when this is `true`. |
| `privateScan` | no | `false` | When `true`, `bollplank merge` runs the private name scan on the PR head and its history, and on the PR's title and body, and refuses unless both pass. The squash commit then gets the scanned title and body as its message. |
| `stopList` | no | `[]` | What a run stops and asks the approver about. With an empty list, the run skill uses its own default list. |

### Repos

| Key | Required | Default | Meaning |
|---|---|---|---|
| `github` | yes | | `owner/name`. |
| `checks` | yes | | The PR check names that must be present and green before a merge. At least one, since nothing else proves a PR is safe. |
| `baseBranch` | no | the remote's default branch, else `master` | The branch work starts from and merges into. |
| `cloneNodeModules` | no | `false` | Copy `node_modules` into each ticket worktree. On macOS it is an APFS clone, which costs no space. |
| `deploy` | no | `{ "kind": "none" }` | How `bollplank deploy-wait` knows a merge is deployed. |

Deploy kinds:

| `kind` | Keys | What `deploy-wait` does |
|---|---|---|
| `none` | | Returns at once. |
| `command` | `command` | Runs the command with `{commit}` replaced by the merge commit, in the repo's checkout, and uses its exit code. |
| `amplify` | `appId`, `region`, optional `branch` and `profile` | Waits for the AWS Amplify job whose commit is the merge commit, never the latest job. `branch` is the Amplify branch and defaults to the base branch. `profile` is the AWS profile, set as `AWS_PROFILE` for the `aws` calls. |
| `github-actions` | `workflow` | Waits for the named workflow's run on the merge commit, through `gh run list --commit`. The newest run on that commit decides, so a rerun counts. |

### Consulting and configuration projects

These keys apply only to the two journal modes. [runs.md](runs.md) describes the modes.

| Key | Mode | Meaning |
|---|---|---|
| `ticketPrefix` | consulting, required | Capital letters and digits. Every ticket with this prefix can run. |
| `allowedTickets` | configuration, required | The ticket ids that can run, such as `ACME-7`. |
| `targets` | both, required | Named targets, each an object. They are journal labels, not access grants. |
| `runbook` | both, required | The path of the project's runbook, which the lead reads before a run. |
| `verificationChecks` | both, required | Unique check names that must pass before a run completes, such as `brief-acceptance`. |
| `protectedProjects` | both, optional | Names the lead must not touch. Guidance for the lead, not an access control. |

Bollplank hashes a journal project's whole config entry at the start of a run. A later change to it stops the run until it is reconciled with `bollplank run rebaseline`.
