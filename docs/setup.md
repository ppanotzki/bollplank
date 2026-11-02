# Setup

Bollplank is plain Node with no dependencies. It is used and tested on macOS. On Windows it is untested beyond CI (see [windows.md](windows.md)). Linux runs the gate in CI and is otherwise unused.

`bollplank <command> --help` does not exist. `bollplank help` lists the commands, and [commands.md](commands.md) describes each one.

## What you need

- Node 20 or later, and git.
- Claude Code, Codex or both, each signed in with a subscription: `claude auth login` with a Claude account, `codex login` with ChatGPT. A client signed in with an API key, or routed through a cloud provider, is not used as a critic.
- A Linear account, reachable from each client through Linear's MCP server, a connector or a plugin.
- For ticket runs: the GitHub CLI `gh`, signed in, and push rights to the project's repos. For an Amplify deploy, the AWS CLI with a profile that can list the app's jobs.

## Install

```sh
git clone https://github.com/ppanotzki/bollplank ~/.bollplank/kit && ~/.bollplank/kit/install.sh
```

`install.sh` checks git and Node, links `bin/bollplank` into `~/.local/bin`, and runs `bollplank init`. When `~/.local/bin` is not on your `PATH`, it prints the line to add to your shell profile.

## `bollplank init`

`bollplank init [--answers <file>] [--offline]` asks its questions one at a time and is safe to run again. Running it again is how you reconfigure.

1. **Clients.** It finds Claude Code and Codex on your `PATH` or in their app bundles and reads each one's sign in. When an API key variable is set in your shell, it warns and explains that Bollplank removes it from every critic call.
2. **Linear.** It probes Linear from each client with a live read: a short headless run that must call the client's Linear tool and list your teams. When a client has no Linear tool or the read fails, it offers to add Linear's MCP server to that client. You sign in to Linear in the browser. Linear arriving through a connector or a plugin passes the probe as it is.
3. **Board.** It asks for the team and project from the list the probe returned, and for your names for the five statuses Bollplank uses: draft, ready, in progress, acceptance and done. A missing status is created through the Linear tool after asking. When the tool cannot create one, `init` shows the steps in Linear's settings and checks again.
4. **People and style.** It asks for the approver, whose explicit words approve a brief and accept a ticket, the copy style for briefs and comments, and the default critic. The default is `other`. With only one client it offers `same` and says what that means (see [same-model.md](same-model.md)). It never changes an existing `other` to `same` without asking.
5. **A first project,** if you want one.
6. **Writing.** It writes `~/.bollplank/config.json`, links each skill into `~/.claude/skills` and `~/.codex/skills`, records every link it made in `~/.bollplank/install.json`, and finishes with `bollplank doctor`.

`--answers <file>` takes the answers from a file instead of asking. `--offline` skips the model calls, so the Linear probe does not run.

**Never replace.** When a path `init` would link already exists and is not a link into the kit, `init` leaves it alone and reports it. That covers a skill folder of your own with the same name and a link into somewhere else.

## `bollplank doctor`

`bollplank doctor [--offline] [--json]` checks:

- the Node version
- the Workflow line (`bollplank version`)
- that `bollplank` is on your `PATH`
- the config
- every link recorded in `install.json`
- each client's subscription sign in
- each client's version against the version Bollplank was tested with
- a live Linear read from each client
- one critic dry run for each configured critic
- the ship lock.

Each failure says what to do. `--offline` skips the checks that call a model. `--json` prints the result as JSON.

## `bollplank update`

`bollplank update` fetches the release tags, checks out the newest `v*` tag in `~/.bollplank/kit`, links any new skills, and prints that release's section of [CHANGELOG.md](../CHANGELOG.md).

## `bollplank uninstall`

`bollplank uninstall` removes only the links recorded in `install.json`. It keeps `~/.bollplank`, with your config, critic state and ledger. `bollplank uninstall --purge` also removes the home folder after you confirm.

## Files

Everything lives in `~/.bollplank`, or in `$BOLLPLANK_HOME` when that is set:

| Path | What it holds |
|---|---|
| `config.json` | Your settings. See [config.md](config.md). |
| `kit/` | The clone of this repo. The installed version is its checked out tag. |
| `install.json` | Every link `init` made, so `uninstall` removes only those. |
| `critics/` | One state file per ticket, critic and mode: the critic's session id and its rounds per subject. |
| `neutral/` | The empty working folder a critic runs in when it gets no source folder. |
| `ledger/` | Ledger markers, critic session bindings and the rollup of ledgered tickets. |
| `ship.lock` | The shipping lock, when a ticket holds the turn. `shipLock` in the config can move it. |
| `private-names.txt` | Only for maintainers of Bollplank itself. See [CONTRIBUTING.md](../CONTRIBUTING.md). |

Environment variables:

| Variable | Effect |
|---|---|
| `BOLLPLANK_HOME` | The home folder instead of `~/.bollplank`. |
| `BOLLPLANK_LEDGER_DIR` | The ledger folder instead of `<home>/ledger`. |
| `CLAUDE_CONFIG_DIR` | Claude Code's folder instead of `~/.claude`, for skills and session files. |
| `CODEX_HOME` | Codex's folder instead of `~/.codex`, for skills and session files. |
| `BOLLPLANK_PRIVATE_NAMES` | The private names list, for Bollplank's own gate and for projects with `privateScan`. |

## When something fails

- **A client is not found.** Install it, or put it on your `PATH`. Bollplank also looks in the macOS app bundles of the Claude desktop app and the ChatGPT app.
- **A client is not on a subscription.** Run `claude auth status` or `codex login status`. Sign in again with your Claude or ChatGPT account.
- **The Linear probe fails.** Open the client, check that its Linear tool works by asking it to list your teams, and run `bollplank init` again.
- **A skill is missing in a client.** Run `bollplank doctor`. A link reported as left alone means a file or a foreign link is in the way. Move it and run `bollplank init` again.
- **A critic call fails with `critic-unavailable`.** The chosen critic's client is missing or not signed in with a subscription. Nothing switches to another critic. Fix the client, or choose another critic yourself.
