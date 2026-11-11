# Setup

The reference for installing and setting up Bollplank. [getting-started.md](getting-started.md) walks through it once. Bollplank is used and tested on macOS. Windows is untested beyond CI (see [windows.md](windows.md)).

## What you need

- Node 20 or later, and git.
- Claude Code, Codex or both, signed in with a subscription: `claude auth login` with a Claude account, `codex login` with ChatGPT. A client signed in with an API key or routed through a cloud provider is not used as a critic.
- A Linear or Jira account, reachable from each client.
  - Linear: Claude Code may use Linear's MCP server or the claude.ai connector. Codex needs Linear's MCP server, since a ChatGPT connector is never used.
  - Jira: Atlassian's official MCP server, `https://mcp.atlassian.com/v2/mcp`. Add it with `claude mcp add --transport http atlassian https://mcp.atlassian.com/v2/mcp` or `codex mcp add atlassian --url https://mcp.atlassian.com/v2/mcp`, and sign in through the browser. The earlier `https://mcp.atlassian.com/v1/mcp` works too. A server or connector at another URL is never used. Release notes in Confluence need a space key.
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
2. **The board.** First asks the board kind, `linear` or `jira`, default `linear`. Then reads that board from each client with a short read only probe, and never probes the other kind (see [the Linear probes](../SECURITY.md#the-linear-probes) and [the Jira probes](../SECURITY.md#the-jira-probes)). When a client cannot read it, init offers to add the board's official MCP server, `https://mcp.linear.app/mcp` or `https://mcp.atlassian.com/v2/mcp`, and opens the browser for the sign in. Claude Code's sign in needs a terminal, so without one init adds the server and names `claude mcp login <name>` to run in a terminal. Codex runs its sign in while it adds the server, and when that takes longer than 5 minutes init names `codex mcp login <name>`. Run `bollplank init` again after either. When your Claude Code settings allow the board's tools broadly, the probe does not run, and init names the rule and how to narrow it.
3. **Team, project and statuses.** Picks from what the probe read. Names are saved as the board spells them. For Linear it asks the team, the project and the statuses. For Jira it asks the site, such as `acme.atlassian.net`, from the sites the probe read, then the project key, such as `ACM`, the statuses, and an optional Confluence space key for the release notes. After a Jira project or space is chosen, init reads its statuses and the space again with the same read only probe.
   - A project that is missing offers three choices: `other` to pick another, `session` to create it from your own Claude Code or Codex session (init prints the sentence to type), or `linear` to create it in Linear (init prints the steps). After a create, init reads Linear again, up to three times, and stops with `missing-project` if it is still not there.
   - For each of the five workflow states it lists the team's or Jira project's statuses and suggests a name. A missing status is never created. Init shows the steps in the board's settings and offers to read again, up to three times. A name kept without a match makes `bollplank doctor` fail until it exists.
4. **You and the critic.** The approver's name, the copy style and the default critic: `other` with both clients, `same` with one. An existing choice stays the default.
5. **A project,** if you want one. The source folder, which may be a repo itself or hold several. The project's name and tickets folder. Its board kind, defaulting to step 2's. When that kind was not read yet in this init, init probes it now, offers to add its MCP server, and keeps the result for the rest of the run. Then its team and project, defaulting to step 3's for the same kind, and whether it uses the board's statuses or maps its own, which is the default for another team. A project of another kind than the top level gets its own team, project and statuses, and on Jira its own optional space. Per repo: the GitHub `owner/name` and the base branch. Then whether runs are on. For a new project they stay off unless you say yes. Only with runs on does init ask, per repo, for the checks that must pass and the deploy kind. With runs off, earlier checks and deploy settings are kept. When you replace a project with the same name, each of its earlier answers is the default, and the settings init does not ask about are kept. Init sets up repository projects only, so a consulting or configuration project of the same name is kept as it is unless you replace it with a new repository project.
6. **Saving.** Validates the config and writes nothing when it does not validate. An existing config is kept as `config.json.bak`. Links every skill into `~/.claude/skills` and `~/.codex/skills`, leaves alone any path that is not its own link, and removes its links to skills the kit no longer has.
7. **Doctor.** Runs `bollplank doctor`.

`--offline` skips the board reads, so names are not checked. `--json` prints one JSON result with init's messages in `messages`, and asks on stderr.

### The answers file

`--answers <file>` reads every answer from one JSON object by key, so automation and tests run the same steps. A key `a.b` is a nested object. A missing key takes the question's default. A question with no default fails with `usage` and names the key.

| Key | Value |
|---|---|
| `kind` | `linear` or `jira`. Left out, it is the saved config's kind, or `linear` when there is no config yet, so an older answers file runs as before. |
| `addBoard.<kind>.<client>` | true or false, to add the board's MCP server to `claude` or `codex`. Default false. `addLinear.<client>` is still read for Linear. |
| `team`, `project` | Linear: the team key or name, and the project. Jira: the site, such as `acme.atlassian.net`, and the project key, such as `ACM`. |
| `space` | Jira only, optional. The Confluence space key for the release notes. A space's name is saved as its key. A space no client finds stops init with `usage`, and one no client can look up is kept as typed. |
| `missingProject.<team>.<project>` | `other`, `session` or `linear`. |
| `otherProject.<team>.<project>` | The project to use instead, after `other`. |
| `statuses.<state>` | The status for `draft`, `ready`, `inProgress`, `acceptance` or `done`. |
| `recheck.<state>` | true to read the board again for a missing status. Default false. |
| `approver`, `copyStyle` | Text. `approver` defaults to `git config user.name`. |
| `critic` | `other`, `same`, `claude` or `codex`. |
| `addProject`, `replaceProject` | true or false. |
| `source`, `projectName`, `tickets` | The source folder, the project's name, the tickets folder. |
| `repos` | A list, or one comma separated string. Default every repo found. |
| `projects.<name>.kind` | The project's board kind. Default the top level `kind`. |
| `projects.<name>.team`, `projects.<name>.project` | The project's team and project, or on Jira its site and project key. |
| `projects.<name>.space` | Jira only, optional. The project's Confluence space key. |
| `projects.<name>.mapping` | `board` or `own`. |
| `projects.<name>.statuses.<state>`, `projects.<name>.recheck.<state>` | As above, for the project's own mapping. |
| `github.<repo>`, `baseBranch.<repo>`, `checks.<repo>` | `owner/name`, the base branch, and a list of check names. |
| `deploy.<repo>` | `none`, `command`, `amplify` or `github-actions`. Default the earlier kind, else `none`. |
| `deployCommand.<repo>`, `deployWorkflow.<repo>` | For `command` and `github-actions`. |
| `amplify.<repo>.appId`, `.region`, `.branch`, `.profile` | For `amplify`. The last two are optional. |
| `runs`, `writeConfig` | true or false. |

An illustration of the keys, not a setup to copy as it is:

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

When the top level board kind changes, every existing project stays on the board it had, and init writes that board out on the project. To move a project to the new board, set it up again in step 5.

On a terminal, a Jira site, project key or space key that is not valid is asked again. With an answers file it stops init with `usage`, naming the key. When the answers still do not make a valid config, init writes nothing, keeps the answers in `config.kept-answers.json` beside the config, and names it. Init owns that file. It replaces it on the next failure and removes it once a config is saved, so keep answers you write yourself under another name. Fix what the failure names, then run `bollplank init --answers` with that file.

With an answers file, init never waits for Enter. So `missingProject` set to `session` or `linear` reads Linear up to three times at once, and init stops with `missing-project` unless the project is already there. A scripted setup creates the board project first, or names one that exists.

A Jira setup in an answers file, with made up names:

```json
{
  "kind": "jira",
  "addBoard": { "jira": { "claude": true } },
  "team": "acme.atlassian.net",
  "project": "ACM",
  "space": "ACM",
  "approver": "Ada",
  "critic": "other"
}
```

The cloud id and the numeric project id are saved from the probe's results, never typed.

## `bollplank doctor`

`bollplank doctor [--offline] [--json]` runs these checks, and each failure says what to do:

| Check | What it checks |
|---|---|
| `node` | Node 20 or later. |
| `workflow` | The Workflow line. A warning when the build is unknown. |
| `path` | `bollplank` is on your `PATH`, as an executable file. A warning, since the full path works too. The fix names `fish_add_path` for fish, `~/.bash_profile` for bash on macOS, `~/.bashrc` for bash elsewhere, and `~/.zshrc` otherwise. |
| `config` | The config validates. |
| `links` | Every link in `install.json` still points into the kit. |
| `skills.<client>` | Every kit skill is linked into that client. |
| `client.<client>`, `version.<client>`, `signin.<client>` | The client is found, its version against the tested one (a warning), and its subscription sign in. Required only when a critic setting needs it. |
| `path.<client>` | The client is on your `PATH`, not only in its app bundle, so the `claude` and `codex` commands in the fixes run as typed. A warning, with a fix like the one for `path`. |
| `<kind>.<client>`, `<kind>` | Each client found reads each board kind the config uses, since either may lead. The ids are `linear.claude`, `linear.codex` and `linear` as before, and `jira.claude`, `jira.codex` and `jira` for Jira. |
| `board.team.<team>`, `board.project.<team>.<project>`, `board.status.<team>.<state>` | Each team, project and status the config names, against that team's read, grouped by kind. Each project is checked with its own effective mapping. For Jira they check the site, the project key, the cloud id, the numeric project id, each status, and the space when one is set. A wrong name fails with the config key to change, and a name that differs only in case with the board's spelling. The top level statuses are required only when a project takes at least one name from them, otherwise a missing one is a warning. |
| `critic.<client>`, `critic.<client>.same` | One dry run per critic the config uses, with no board tools. |
| `lock` | The ship lock is free or has a readable holder. |

A board read or a dry run that fails in a way a second try can fix runs once more, since a client or its service can fail for a moment. Its check then says it passed on the second try or failed on both. A read that called a tool other than a board read, or a critic that used a tool, is not tried again.

It exits 1 when a required check fails. `--offline` skips the board reads, the board checks and the dry runs. `--json` prints every check.

## `bollplank update`

`bollplank update [--pre] [--json]` fetches the release tags, checks out the newest `v*` tag in the kit, links the skills again and prints that release's changelog section. `--pre` also takes tags such as `v1.2.0-rc.1`. It never goes back. It refuses with `not-a-checkout`, `corrupt`, `local-changes` or `no-release`, and changes nothing then.

## `bollplank uninstall`

`bollplank uninstall [--purge] [--yes] [--json]` removes only the links in `install.json` that still point into the kit. It never touches the clients, and a board MCP that init added stays (`claude mcp remove linear` or `claude mcp remove atlassian`, and the same with `codex mcp remove`). It keeps `~/.bollplank`, so run the command as `~/.bollplank/kit/bin/bollplank` afterwards.

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
| `BOLLPLANK_CLAUDE_MANAGED_SETTINGS` | The managed settings file the board probes read. For tests. |
| `BOLLPLANK_PRIVATE_NAMES` | The private names list, for the gate and `privateScan` projects. |

## When something fails

- **A client is not found or not on a subscription.** Install it or put it on your `PATH`. Run `claude auth status` or `codex login status`, and sign in with your Claude or ChatGPT account.
- **The Linear read fails.** Ask the client to list your Linear teams to see that its Linear tool works, then run `bollplank init` again. For Codex, `codex mcp add linear --url https://mcp.linear.app/mcp` and `codex mcp login linear`.
- **The Jira read fails.** Check that the client's Atlassian server uses `https://mcp.atlassian.com/v2/mcp` or `https://mcp.atlassian.com/v1/mcp`, and that its sign in reaches the site. Then run `bollplank init` again. For Codex, `codex mcp add atlassian --url https://mcp.atlassian.com/v2/mcp` and `codex mcp login atlassian`.
- **Your Claude Code settings allow Linear tools broadly.** Replace a rule such as `mcp__claude_ai_Linear__*` or `mcp__*` with rules that each name one tool, or with read verbs only, such as `mcp__claude_ai_Linear__list*`. Then run `bollplank doctor`.
- **A board check fails.** Add the name on the board as the fix says, or change the config key it names. See [existing-project.md](existing-project.md).
- **A skill is missing.** A path in the way is left alone. Move it and run `bollplank init` again.
- **A critic call fails.** [commands.md](commands.md#bollplank-critic) lists every failure.
