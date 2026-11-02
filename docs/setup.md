# Setup

The reference for installing and setting up Bollplank. [getting-started.md](getting-started.md) walks through it once. Bollplank is used and tested on macOS. Windows is untested beyond CI (see [windows.md](windows.md)).

## What you need

- Node 20 or later, and git.
- Claude Code, Codex or both, signed in with a subscription: `claude auth login` with a Claude account, `codex login` with ChatGPT. A client signed in with an API key or routed through a cloud provider is not used as a critic.
- A Linear account, reachable from each client. Claude Code may use Linear's MCP server or the claude.ai connector. Codex needs Linear's MCP server, since a ChatGPT connector is never used.
- For ticket runs: the GitHub CLI `gh`, signed in, with push rights to the project's repos. For an Amplify deploy, the AWS CLI.

## Install

```sh
git clone https://github.com/ppanotzki/bollplank ~/.bollplank/kit && ~/.bollplank/kit/install.sh
```

`install.sh` checks git and Node, links `bin/bollplank` into `~/.local/bin`, records the link in `~/.bollplank/install.json`, and runs `bollplank init`. When `~/.local/bin` is not on your `PATH`, it prints the line to add to `~/.zshrc`, or `~/.bashrc` for bash. It works from another folder too, and says so.

```sh
./install.sh                              # install, then run bollplank init
./install.sh --no-init                    # install only
./install.sh -- --answers ~/answers.json  # pass everything after -- to init
```

Any other option exits 2. It never replaces a file or a link that is not its own, and running it again is safe.

## `bollplank init`

`bollplank init [--answers <file>] [--offline] [--json]` asks one question at a time. Running it again is how you reconfigure: every earlier answer is the default, and nothing is saved without asking. It needs a terminal, or `--answers`. Init never writes to the board.

1. **Clients.** Finds Claude Code and Codex on your `PATH`, then in the macOS app bundles, with their versions and sign in. It names any model key or provider variable set in your shell, never its value.
2. **Linear.** Reads Linear from each client with a short read only probe (see [SECURITY.md](../SECURITY.md#the-linear-probes)). When a client cannot read it, init offers to add Linear's MCP server (`https://mcp.linear.app/mcp`) and opens the browser for the sign in. When your Claude Code settings allow Linear tools broadly, the probe does not run, and init names the rule and how to narrow it.
3. **Team, project and statuses.** Picks from what the probe read. Names are saved as Linear spells them.
   - A project that is missing offers three choices: `other` to pick another, `session` to create it from your own Claude Code or Codex session (init prints the sentence to type), or `linear` to create it in Linear (init prints the steps). After a create, init reads Linear again, up to three times, and stops with `missing-project` if it is still not there.
   - For each of the five workflow states it lists the team's statuses and suggests Linear's name. A missing status is never created. Init shows the steps in Linear's settings and offers to read again, up to three times. A name kept without a match makes `bollplank doctor` fail until it exists.
4. **You and the critic.** The approver's name, the copy style and the default critic: `other` with both clients, `same` with one. An existing choice stays the default.
5. **A project,** if you want one. The source folder, which may be a repo itself or hold several. The project's name and tickets folder. Its Linear team and project, defaulting to step 3's, and whether it uses the board's statuses or maps its own, which is the default for another team. Per repo: the GitHub `owner/name`, the base branch, the checks that must pass, and the deploy kind. Last, whether runs are on. For a new project they stay off unless you say yes. When you replace a project with the same name, each of its earlier answers is the default, and the settings init does not ask about are kept.
6. **Saving.** Validates the config and writes nothing when it does not validate. An existing config is kept as `config.json.bak`. Links every skill into `~/.claude/skills` and `~/.codex/skills`, leaves alone any path that is not its own link, and removes its links to skills the kit no longer has.
7. **Doctor.** Runs `bollplank doctor`.

`--offline` skips the Linear reads, so names are not checked. `--json` prints one JSON result with init's messages in `messages`, and asks on stderr.

### The answers file

`--answers <file>` reads every answer from one JSON object by key, so automation and tests run the same steps. A key `a.b` is a nested object. A missing key takes the question's default. A question with no default fails with `usage` and names the key.

| Key | Value |
|---|---|
| `addLinear.claude`, `addLinear.codex` | true or false. Default false. |
| `team`, `project` | The Linear team key or name, and the project. |
| `missingProject.<team>.<project>` | `other`, `session` or `linear`. |
| `otherProject.<team>.<project>` | The project to use instead, after `other`. |
| `statuses.<state>` | The status for `draft`, `ready`, `inProgress`, `acceptance` or `done`. |
| `recheck.<state>` | true to read Linear again for a missing status. Default false. |
| `approver`, `copyStyle` | Text. `approver` defaults to `git config user.name`. |
| `critic` | `other`, `same`, `claude` or `codex`. |
| `addProject`, `replaceProject` | true or false. |
| `source`, `projectName`, `tickets` | The source folder, the project's name, the tickets folder. |
| `repos` | A list, or one comma separated string. Default every repo found. |
| `projects.<name>.team`, `projects.<name>.project` | The project's Linear team and project. |
| `projects.<name>.mapping` | `board` or `own`. |
| `projects.<name>.statuses.<state>`, `projects.<name>.recheck.<state>` | As above, for the project's own mapping. |
| `github.<repo>`, `baseBranch.<repo>`, `checks.<repo>` | `owner/name`, the base branch, and a list of check names. |
| `deploy.<repo>` | `none`, `command`, `amplify` or `github-actions`. Default the earlier kind, else `none`. |
| `deployCommand.<repo>`, `deployWorkflow.<repo>` | For `command` and `github-actions`. |
| `amplify.<repo>.appId`, `.region`, `.branch`, `.profile` | For `amplify`. The last two are optional. |
| `runs`, `writeConfig` | true or false. |

```json
{
  "team": "ACME",
  "project": "Acme Shop",
  "missingProject": { "ACME": { "Acme Shop": "linear" } },
  "statuses": { "acceptance": "In Review" },
  "approver": "Ada",
  "critic": "other",
  "source": "~/Code/acme",
  "repos": ["acme-api", "acme-web"],
  "projectName": "acme-shop",
  "projects": { "acme-shop": { "mapping": "board" } },
  "checks": { "acme-api": ["checks"], "acme-web": "checks, e2e" },
  "deploy": { "acme-api": "github-actions", "acme-web": "none" },
  "deployWorkflow": { "acme-api": "deploy" }
}
```

## `bollplank doctor`

`bollplank doctor [--offline] [--json]` runs these checks, and each failure says what to do:

| Check | What it checks |
|---|---|
| `node` | Node 20 or later. |
| `workflow` | The Workflow line. A warning when the build is unknown. |
| `path` | `bollplank` is on your `PATH`. A warning, since the full path works too. |
| `config` | The config validates. |
| `links` | Every link in `install.json` still points into the kit. |
| `skills.<client>` | Every kit skill is linked into that client. |
| `client.<client>`, `version.<client>`, `signin.<client>` | The client is found, its version against the tested one (a warning), and its subscription sign in. Required only when a critic setting needs it. |
| `path.<client>` | The client is on your `PATH`, not only in its app bundle, so the `claude` and `codex` commands in the fixes run as typed. A warning. |
| `linear.<client>`, `linear` | Each client found reads Linear, since either may lead. |
| `board.team.<team>`, `board.project.<team>.<project>`, `board.status.<team>.<state>` | Each team, project and status the config names, against that team's read. Each project is checked with its own effective mapping. A wrong name fails with the config key to change, and a name that differs only in case with Linear's spelling. |
| `critic.<client>`, `critic.<client>.same` | One dry run per critic the config uses, with no board tools. |
| `lock` | The ship lock is free or has a readable holder. |

It exits 1 when a required check fails. `--offline` skips the Linear reads, the board checks and the dry runs. `--json` prints every check.

## `bollplank update`

`bollplank update [--pre] [--json]` fetches the release tags, checks out the newest `v*` tag in the kit, links the skills again and prints that release's changelog section. `--pre` also takes tags such as `v1.2.0-rc.1`. It never goes back. It refuses with `not-a-checkout`, `corrupt`, `local-changes` or `no-release`, and changes nothing then.

## `bollplank uninstall`

`bollplank uninstall [--purge] [--yes] [--json]` removes only the links in `install.json` that still point into the kit. It never touches the clients, and a Linear MCP that init added stays (`claude mcp remove linear`, `codex mcp remove linear`). It keeps `~/.bollplank`, so run the command as `~/.bollplank/kit/bin/bollplank` afterwards.

`--purge` also removes `~/.bollplank`, kit included, after you confirm, or with `--yes` without a terminal. It refuses with `lock-held` while the ship lock is held, and with `unsafe-purge` for a folder that is your home, holds it, or holds no Bollplank config or install record.

## Files and variables

Everything lives in `~/.bollplank`, or in `$BOLLPLANK_HOME`:

| Path | What it holds |
|---|---|
| `config.json`, `config.json.bak` | Your settings ([config.md](config.md)), and the version before init last wrote it. |
| `kit/` | The clone of this repo. |
| `install.json` | Every link `install.sh` and init made. |
| `critics/` | One state file per ticket, critic and mode: its session and rounds. A `.lock` folder marks a call in progress. |
| `neutral/` | The empty folder a critic runs in without `--read-dir`. |
| `ledger/` | Ledger markers, critic bindings and the rollup. |
| `ship.lock` | The shipping lock, while a ticket holds the turn. |
| `private-names.txt` | Only for maintainers. See [CONTRIBUTING.md](../CONTRIBUTING.md). |

| Variable | Effect |
|---|---|
| `BOLLPLANK_HOME` | The home folder instead of `~/.bollplank`. |
| `BOLLPLANK_LEDGER_DIR` | The ledger folder instead of `<home>/ledger`. |
| `CLAUDE_CONFIG_DIR`, `CODEX_HOME` | The clients' folders instead of `~/.claude` and `~/.codex`. |
| `BOLLPLANK_CLAUDE_MANAGED_SETTINGS` | The managed settings file the Linear probe reads. For tests. |
| `BOLLPLANK_PRIVATE_NAMES` | The private names list, for the gate and `privateScan` projects. |

## When something fails

- **A client is not found or not on a subscription.** Install it or put it on your `PATH`. Run `claude auth status` or `codex login status`, and sign in with your Claude or ChatGPT account.
- **The Linear read fails.** Ask the client to list your Linear teams to see that its Linear tool works, then run `bollplank init` again. For Codex, `codex mcp add linear --url https://mcp.linear.app/mcp` and `codex mcp login linear`.
- **Your Claude Code settings allow Linear tools broadly.** Replace a rule such as `mcp__claude_ai_Linear__*` or `mcp__*` with rules that each name one tool, or with read verbs only, such as `mcp__claude_ai_Linear__list*`. Then run `bollplank doctor`.
- **A board check fails.** Add the name in Linear as the fix says, or change the config key it names. See [existing-project.md](existing-project.md).
- **A skill is missing.** A path in the way is left alone. Move it and run `bollplank init` again.
- **A critic call fails.** [commands.md](commands.md#bollplank-critic) lists every failure.
