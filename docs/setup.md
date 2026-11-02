# Setup

Bollplank is plain Node with no dependencies. It is used and tested on macOS. On Windows it is untested beyond CI (see [windows.md](windows.md)). Linux runs the gate in CI and is otherwise unused.

`bollplank help` lists the commands, and `bollplank <command> --help` prints one command's usage line. [commands.md](commands.md) describes each one.

## What you need

- Node 20 or later, and git.
- Claude Code, Codex or both, each signed in with a subscription: `claude auth login` with a Claude account, `codex login` with ChatGPT. A client signed in with an API key, or routed through a cloud provider, is not used as a critic.
- A Linear account, reachable from each client. Claude Code may reach it through Linear's MCP server, a claude.ai connector or a configured server. Codex needs Linear's MCP server, since the probe never uses a ChatGPT connector (see step 2).
- For ticket runs: the GitHub CLI `gh`, signed in, and push rights to the project's repos. For an Amplify deploy, the AWS CLI with a profile that can list the app's jobs.

## Install

```sh
git clone https://github.com/ppanotzki/bollplank ~/.bollplank/kit && ~/.bollplank/kit/install.sh
```

`install.sh` checks git and Node 20 or later, and stops with the fix when one is missing. It says so when the kit is not at `~/.bollplank/kit`, the place the guides assume, and works from there too. It links `bin/bollplank` into `~/.local/bin` and records that link in `~/.bollplank/install.json`. When `~/.local/bin` is not on your `PATH`, it prints the line to add to `~/.zshrc`, or to `~/.bashrc` for bash. Then it runs `bollplank init`, with `~/.local/bin` on its `PATH`, so the doctor that ends init finds the command as a new terminal will.

```sh
./install.sh                              # install, then run bollplank init
./install.sh --no-init                    # install only
./install.sh -- --answers ~/answers.json  # install, then run init with the options after --
```

Everything after `--` goes to `bollplank init`. Any other option is refused with exit 2. `install.sh` never replaces a file or a link that is not its own. A `~/.local/bin/bollplank` that is a file, or a link to somewhere else, stops it with what to do. Running it again is safe.

## `bollplank init`

`bollplank init [--answers <file>] [--offline] [--json]` asks its questions one at a time and is safe to run again. Running it again is how you reconfigure: every earlier answer is offered as the default, and nothing is rewritten without asking. It needs a terminal, or `--answers`. A corrupt `install.json` stops it before it asks anything.

It runs seven steps in this order:

1. **Claude Code and Codex.** It finds each client on your `PATH`, then in the macOS app bundles, and reports its version against the one Bollplank was tested with and its sign in. Only a subscription sign in is used. When a model key or provider variable is set in your shell, it names the variables, never their values, and says that Bollplank removes them for critic calls and probes.
2. **Linear.** It reads Linear from each client signed in with a subscription, with a short headless run that must really call the client's Linear tool and list your teams, their statuses and projects. When a client has no Linear tool or the read fails, it offers to add Linear's MCP server (`https://mcp.linear.app/mcp`) to that client, opens the browser for the Linear sign in, and reads again. The read can only read: Claude Code gets only the read tools of its Linear servers and connectors, a saved allow rule for one Linear write tool is denied by name, and Codex runs with every MCP server but its Linear server switched off, connectors off, and the Linear server offering only its list and get tools. A ChatGPT connector cannot be narrowed to read tools, so Codex is never probed through one. A Codex that reaches Linear only that way is told to add the Linear MCP server. A probe that calls any tool other than a Linear read fails. When your Claude Code settings allow Linear tools broadly, with an allow rule for a whole Linear server or a wildcard such as `mcp__*`, the Claude Code probe does not run at all, since it could not be kept read only. Init then names the rule and its file and says how to narrow it, and does not offer to add the Linear MCP. See [SECURITY.md](../SECURITY.md#the-linear-probes).
3. **The Linear team, project and statuses.** It asks for the team and the project, from the lists the read returned when it could read them. Then it asks for your name for each of the five statuses Bollplank uses: draft, ready, in progress, acceptance and done. When the read listed the team's statuses, each name must be one of them. Init saves each team, project and status name exactly as Linear returned it, so a name typed in another case takes Linear's spelling. A missing status is never created. Init shows the steps to add it in Linear's settings (Settings, Teams, the team, Workflow, and the status group it belongs in) and offers to read Linear again. After three tries, or a no, it keeps the name in the config and says that `bollplank doctor` fails until the status exists, as moving a ticket to it does. When the statuses could not be read, the names you type are not checked.
4. **You and the critic.** It asks for the approver, whose explicit words approve a brief and accept a ticket, the copy style for briefs and comments, and the default critic. The default is `other` with both clients and `same` with one, and an existing choice stays the default. With one client it explains `same` (see [same-model.md](same-model.md)). It never changes an existing `other` without an answer.
5. **A project,** if you want one. You give the source folder. When that folder is itself a git repo, init saves its parent as the project's source folder and the repo by its folder name, since every command finds a repo at `<source>/<repo>`. Otherwise it lists the git repos inside it and asks which belong to the project. It asks for the project's name and its tickets folder. For each repo it asks for the GitHub `owner/name` (read from its `origin` remote), the base branch (from `origin/HEAD`, else `main`), the checks that must pass on a pull request, and the deploy kind with its settings. Last it asks whether to turn runs on, which stay off unless you say yes. The project gets the team and project from step 3 as its `board`, and its repos in the order given as its `shipOrder`.
6. **Saving.** It validates the config and writes nothing when it does not validate. When a config exists and would change, it asks first and keeps the old one as `config.json.bak`. It links every skill into the `skills` folder of each client it found (`~/.claude/skills`, `~/.codex/skills`), records every link in `~/.bollplank/install.json`, and removes its own links to skills the kit no longer has.
7. **Doctor.** It runs `bollplank doctor`, with `--offline` when init had it.

**`--offline`** skips the Linear read in step 2, so team, project and status names are typed and not checked against Linear. `gh` is still used in step 5 to offer check names, from the checks of the repo's latest pull request or, without one, its workflow names. When `gh` cannot read them, init says so. Type the check names as GitHub shows them on a pull request, or give `checks.<repo>` in the answers file. A repo with no check name does not validate, so nothing is written.

**`--json`** prints the result as one JSON object, with init's messages in `messages`, and asks its questions on stderr.

**Never replace.** When a path `init` would link already exists and is not a link into the kit, `init` leaves it alone and reports it. That covers a skill folder of your own with the same name and a link into somewhere else.

### The answers file

`--answers <file>` reads every answer from one JSON object instead of asking, so automation and tests run the same steps. A key the file leaves out takes the question's default. A question with no default whose key is missing, such as `source` or `approver` without a git user name, fails with `usage` and names the key.

| Key | Value | Asked |
|---|---|---|
| `addLinear.claude`, `addLinear.codex` | true or false. Default false. | In step 2, when that client cannot read Linear. |
| `team` | The team key or name. | Step 3. |
| `project` | The Linear project name. | Step 3. |
| `statuses.draft`, `statuses.ready`, `statuses.inProgress`, `statuses.acceptance`, `statuses.done` | The status name. Defaults `Draft`, `Ready`, `In Progress`, `Acceptance`, `Done`. | Step 3. |
| `recheck.<status>` | true or false. Default false. | Step 3, when that status is not in the team. |
| `approver` | The approver's name. Default `git config user.name`. | Step 4. |
| `copyStyle` | The copy style. | Step 4. |
| `critic` | `other`, `same`, `claude` or `codex`. | Step 4. |
| `addProject` | true or false. Default true without projects, false with. | Step 5. |
| `source` | The source folder. Required with a project. | Step 5. |
| `repos` | A list of repo names, or one comma separated string. Default every repo found. | Step 5, when the folder holds more than one repo. |
| `projectName` | The project's name. Default the source folder's name. | Step 5. |
| `replaceProject` | true or false. Default false. | Step 5, when a project of that name exists. |
| `tickets` | The tickets folder. Default `<source>/Tickets`. | Step 5. |
| `github.<repo>` | `owner/name`. Default from the `origin` remote. | Step 5, per repo. |
| `baseBranch.<repo>` | The base branch. | Step 5, per repo. |
| `checks.<repo>` | A list of check names, or one comma separated string. Default what `gh` offers. | Step 5, per repo. |
| `deploy.<repo>` | `none`, `command`, `amplify` or `github-actions`. Default `none`. | Step 5, per repo. |
| `deployCommand.<repo>` | The command, with `{commit}` for the merge commit. | Step 5, for `command`. |
| `deployWorkflow.<repo>` | The workflow name. Default the repo's first workflow. | Step 5, for `github-actions`. |
| `amplify.<repo>.appId`, `amplify.<repo>.region` | The Amplify app id and its AWS region. | Step 5, for `amplify`. |
| `amplify.<repo>.branch`, `amplify.<repo>.profile` | The Amplify branch and the AWS profile. Optional. | Step 5, for `amplify`. |
| `runs` | true or false. Default false. | Step 5. |
| `writeConfig` | true or false. Default true. | Step 6, when a config exists and would change. |

A key written as `a.b` is a nested object: `checks.acme-api` is `{ "checks": { "acme-api": [...] } }`. A yes or no question takes only `true` or `false`, and any other value takes its default. `critic` and `deploy.<repo>` must be one of their values. `team`, `project` and the statuses take any name.

A complete answers file, for a source folder `~/Code/acme` that holds three repos:

```json
{
  "addLinear": { "claude": true, "codex": false },
  "team": "ACME",
  "project": "Shop",
  "statuses": { "draft": "Draft", "ready": "Ready", "inProgress": "In Progress", "acceptance": "In Review", "done": "Done" },
  "recheck": { "acceptance": false },
  "approver": "Ada",
  "copyStyle": "Plain sentences. Say what to do. No filler.",
  "critic": "other",
  "addProject": true,
  "source": "~/Code/acme",
  "repos": ["acme-api", "acme-web", "acme-site"],
  "projectName": "acme-shop",
  "replaceProject": false,
  "tickets": "~/Code/acme/Tickets",
  "github": { "acme-api": "acme/acme-api", "acme-web": "acme/acme-web", "acme-site": "acme/acme-site" },
  "baseBranch": { "acme-api": "main", "acme-web": "main", "acme-site": "main" },
  "checks": { "acme-api": ["checks"], "acme-web": "checks, e2e", "acme-site": ["build"] },
  "deploy": { "acme-api": "github-actions", "acme-web": "command", "acme-site": "amplify" },
  "deployWorkflow": { "acme-api": "deploy" },
  "deployCommand": { "acme-web": "./scripts/wait-for-deploy.sh {commit}" },
  "amplify": { "acme-site": { "appId": "d1acme", "region": "eu-north-1", "branch": "main", "profile": "acme" } },
  "runs": false,
  "writeConfig": true
}
```

## `bollplank doctor`

`bollplank doctor [--offline] [--json]` checks, in this order:

- `node`: Node 20 or later.
- `workflow`: the Workflow line (`bollplank version`). A warning when the build is unknown.
- `path`: that `bollplank` is on your `PATH`. A warning only, since the full path `~/.bollplank/kit/bin/bollplank` works too. The fix is the line to add to your shell profile.
- `config`: the config validates.
- `links`: every link recorded in `install.json` is still a link into the kit, and its target exists. A missing or corrupt record fails.
- `skills.<client>`, for each client found: every kit skill is in that client's `skills` folder as a link into the kit, whether or not it was recorded.
- `client.<client>`, `version.<client>` and `signin.<client>`: each client is found, its version against the tested one (a warning), and its subscription sign in. A client is required only when a critic setting needs it, the top level one or a project's own.
- `linear.<client>` and `linear`: a live Linear read from each client found. Either client may lead a ticket, so each one must read Linear. A client found without a subscription sign in fails here too. A Claude Code probe stopped by a broad Linear allow rule in your Claude Code settings fails with the rule's tool part, its file, and how to narrow it.
- `board.team.<team>`, `board.project.<team>.<project>` and `board.status.<team>.<status>`: the team and project of the top level `board` and of each project, and the five status names, against what each client read. Names are compared exactly, as the board skill uses them. Each missing one fails with what to do in Linear or in the config. A name that differs from Linear's only in case, such as `acceptance` for `Acceptance`, fails with the exact spelling to put in the config.
- `critic.<client>`: one critic dry run for each critic the top level and project critic defaults use, in the critique format. A same provider dry run is `critic.<client>.same` when the same client also runs as the other critic.
- `lock`: the ship lock is free or held with a readable holder.

Each failure says what to do. Doctor exits 1 when a required check fails. Warnings do not fail it. `--offline` skips the Linear reads, the board checks and the dry runs. `--json` prints every check as JSON.

## `bollplank update`

`bollplank update [--pre] [--json]` fetches the release tags, checks out the newest `v*` tag by semantic version in the kit, detached, links the skills again for every client found and every client folder that holds a recorded link, and prints that release's section of [CHANGELOG.md](../CHANGELOG.md). Pre-release tags such as `v1.2.0-rc.1` count only with `--pre`.

It refuses and changes nothing when the kit is not a git checkout of its own (`not-a-checkout`, also for a kit folder inside another repo, which git would otherwise move), when the kit's `package.json` or `install.json` cannot be read (`corrupt`), when the kit has local changes (`local-changes`), or when there is no release tag to take (`no-release`). It never goes back: a kit newer than the newest release stays where it is and says so.

## `bollplank uninstall`

`bollplank uninstall [--purge] [--yes] [--json]` removes only the links recorded in `install.json` that still point into the kit. A recorded path that is now something else is left and reported. The clients and their settings are never touched, and a Linear MCP that init added stays. Remove it with `claude mcp remove linear` or `codex mcp remove linear` if you want.

It keeps `~/.bollplank`, with your config, critic state, ledger and the kit. Once the command link is gone, `bollplank` is no longer on your `PATH`, so run it as `~/.bollplank/kit/bin/bollplank`. The `command` field of the result and the closing hint say the same.

`--purge` also removes the home folder, after you confirm on a terminal, or with `--yes` when there is no terminal. With the kit in `~/.bollplank/kit`, that removes the kit too. `--purge` refuses and removes nothing:

- with `lock-held` while the ship lock is held, since a ticket may be shipping.
- with `unsafe-purge` when the folder is your home folder, holds your home folder, or holds no Bollplank `config.json` or `install.json`.

## Files

Everything lives in `~/.bollplank`, or in `$BOLLPLANK_HOME` when that is set:

| Path | What it holds |
|---|---|
| `config.json` | Your settings. See [config.md](config.md). `config.json.bak` is the version before init last wrote it. |
| `kit/` | The clone of this repo. The installed version is its checked out tag. |
| `install.json` | Every link `install.sh` and `init` made, so `uninstall` removes only those. |
| `critics/` | One state file per ticket, critic and mode: the critic's session id and its rounds per subject. A `.lock` folder next to one marks a call in progress. |
| `neutral/` | The empty working folder a critic runs in when it gets no source folder. |
| `ledger/` | Ledger markers, critic session bindings and the rollup of ledgered tickets. |
| `ship.lock` | The shipping lock, when a ticket holds the turn. `shipLock` in the config can move it. |
| `private-names.txt` | Only for maintainers of Bollplank itself. See [CONTRIBUTING.md](../CONTRIBUTING.md). |

Environment variables:

| Variable | Effect |
|---|---|
| `BOLLPLANK_HOME` | The home folder instead of `~/.bollplank`. A relative path is resolved against the current folder. |
| `BOLLPLANK_LEDGER_DIR` | The ledger folder instead of `<home>/ledger`. |
| `CLAUDE_CONFIG_DIR` | Claude Code's folder instead of `~/.claude`, for skills, session files and the settings the Linear probe reads. |
| `BOLLPLANK_CLAUDE_MANAGED_SETTINGS` | The Claude Code managed settings file the Linear probe reads, instead of the system one. For tests. Point it only at the file Claude Code itself reads. |
| `CODEX_HOME` | Codex's folder instead of `~/.codex`, for skills and session files. |
| `BOLLPLANK_PRIVATE_NAMES` | The private names list, for Bollplank's own gate and for projects with `privateScan`. |

## When something fails

- **A client is not found.** Install it, or put it on your `PATH`. Bollplank also looks in the macOS app bundles of the Claude desktop app and the ChatGPT app.
- **A client is not on a subscription.** Run `claude auth status` or `codex login status`. Sign in again with your Claude or ChatGPT account.
- **The Linear read fails.** Open the client, check that its Linear tool works by asking it to list your teams, and run `bollplank init` again. For Codex, add Linear's MCP server with `codex mcp add linear --url https://mcp.linear.app/mcp` and `codex mcp login linear`, which init offers. A ChatGPT connector alone does not pass.
- **The Claude Code probe did not run because your settings allow Linear tools broadly.** An allow rule such as `mcp__claude_ai_Linear`, `mcp__claude_ai_Linear__*` or `mcp__*` in a Claude Code settings file would let the probe run Linear write tools. Replace it with rules that each name one tool, such as `mcp__claude_ai_Linear__list_teams`, or with read verbs only, such as `mcp__claude_ai_Linear__list*`, or remove it. Then run `bollplank doctor`.
- **A board check fails.** The config names a team, project or status that a client cannot see in Linear. Add it in Linear, as the fix says, or run `bollplank init` to choose names that exist.
- **A skill is missing in a client.** Run `bollplank doctor`. A link reported as left alone means a file or a foreign link is in the way. Move it and run `bollplank init` again.
- **A critic call fails with `critic-unavailable`.** The chosen critic's client is missing or not signed in with a subscription. Nothing switches to another critic. Fix the client, or choose another critic yourself.
- **A critic call fails with `session-missing`.** The client no longer has the critic's session. Call it again with `--new-session`. The round counts are kept.
- **A critic call fails with `critic-busy`.** Another call for that ticket and critic is running. If none is, remove the lock folder the detail names.
