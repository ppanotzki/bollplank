# Security

## Reporting

Report a vulnerability privately through GitHub's private vulnerability reporting: open the repository's Security tab and choose "Report a vulnerability". Please do not open a public issue for it. Include what you ran, what happened and the Bollplank version from `bollplank version`.

## What Bollplank never does with credentials

- It never asks for, stores or passes an API key, token or password. It has no sign in of its own.
- It never reads the clients' credential files. It asks Claude Code and Codex whether they are signed in with `claude auth status --json` and `codex login status`, and keeps only whether the sign in is a subscription. Codex's raw status output is not passed on, since a key based status can include part of the key.
- It never uses a client signed in with an API key or routed through a cloud provider as a critic. It reports that sign in and fails the call.
- It never lets a critic or a probe see your model keys. Every critic call, Linear probe and sign in check runs with an environment that has lost every variable whose name starts with `ANTHROPIC_`, `OPENAI_`, `CODEX_API_KEY`, `CODEX_ACCESS`, `CLAUDE_CODE_USE_`, `AWS_BEARER_TOKEN_BEDROCK` or `AZURE_OPENAI`. It also loses the markers a running Claude Code session leaves for its children, such as `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_*` and `CLAUDE_CODE_SIMPLE`, so a critic started inside Claude Code is a fresh process. Names are matched ignoring case, as Windows does. `CLAUDE_CODE_OAUTH_TOKEN` is a subscription sign in and stays. Nothing else is removed.

## What the critic can reach

The critic works the board itself. It reads the issue and its comments and posts its critique with its own client's Linear tools. It gets those tools and the one source folder the lead opens with `--read-dir`, and nothing else.

- **Claude Code.** Bollplank lists the client's servers with `claude mcp list` and keeps those whose names say Linear, including the claude.ai Linear connector. Every tool of those servers is allowed. Every other server is denied by name. Your user settings load, since the flags that would hide them also hide the claude.ai connectors, so the deny rules carry the restriction, and a deny rule wins over any allow rule in those settings. The only built in tools are `ToolSearch`, which loads the deferred Linear tools, and with `--read-dir` also `Read`, `Grep` and `Glob`, allowed inside that folder. `Bash`, `Edit`, `Write`, `NotebookEdit`, `PowerShell`, `WebFetch`, `WebSearch` and `Task` are denied by name, so the critic has no shell. It runs with `--permission-mode dontAsk`, so anything not allowed is refused without a prompt.
- **Codex.** It runs `codex exec` in a read only sandbox with `approval_policy="never"` and no network, so nothing can write a file, reach the network or ask to leave the sandbox. It is signed in with ChatGPT only, and `model_provider` is pinned to `openai`, so a profile or provider in its config cannot move it onto a key. The MCP servers whose names say Linear stay on with all their tools, which run without an approval request. Every other server is switched off by name, and the list is read again to confirm it. Connectors (apps), plugins, browsers, computer use, image generation, sub agents, memories, tool suggestions, hooks and skill installs are switched off, and `web_search` is disabled. Codex keeps its shell inside the sandbox, which is how it reads a checkout and runs tests in a code review.
- **At runtime** the event stream is checked. A critic that is given or uses any other tool, an MCP server that is not Linear or a connector is stopped, and the call fails with `critic-used-tools` without returning its text.
- **No Linear server** in the critic's client fails before any model turn as `critic-unavailable`.
- **The subject must have been read.** A critique counts only when the critic made a successful board call that read the issue and one that read its comments. Otherwise the call fails as `board-unreachable`, and the lead never posts it.

Known limits:

- The critic can use every Linear tool, read and write, in every team your Linear sign in reaches. The prompt tells it to post one comment and change nothing else unless the approver's instruction says so. Bollplank does not check which board writes it makes.
- Linear servers are picked by name, so a server named like Linear that is not Linear gets the same access.
- A critic with a source folder can read every file in that folder that your account can read, such as a `.env` file. Open the narrowest folder the review needs.
- Codex's read only sandbox stops writes and network, not reads. Its commands can read the whole disk as far as your account can.

## Setup never writes to the board

`bollplank init`, `doctor`, `update` and `uninstall` start no board write. A Linear project or status that is missing is created by you, in your own Claude Code or Codex session or in Linear, where you see the change. Init then reads Linear again. Doctor's critic dry run gets no board tools.

## The Linear probes

`bollplank init` and `bollplank doctor` start one short headless run per client to check that it can read Linear. The probe passes only when a Linear tool call really happened and returned what the reply claims. A probe that called any tool that is not a Linear read fails, whatever it returned.

- **Claude Code** gets no built in tools. Only the tools of its Linear servers and connectors whose names start with `list`, `get`, `search` or `read` are allowed, by name prefix. It runs with `--permission-mode dontAsk` and `--permission-prompts none`, and nothing is saved as a session. Its other MCP servers are denied by name.
- Your Claude Code settings stay loaded, so before the probe Bollplank reads the allow rules of `settings.json` and `settings.local.json` in your Claude Code folder and in the probe's folder, and of the managed settings file (`/Library/Application Support/ClaudeCode/managed-settings.json` on macOS). It prints no more of a rule than its tool part. A rule that names one Linear tool that is not a read is denied by name. A rule that allows a whole Linear server, or a wildcard such as `mcp__*` that is not limited to read verbs, stops the probe before any model turn, and init and doctor say how to narrow it. A settings file that is not valid JSON stops it too. As a second layer, tools whose names start with a write verb, such as `create`, `update`, `delete` or `save`, are denied on each Linear server.
- **Codex** runs ephemeral with the critic's sandbox and switches. Every MCP server but Linear's is off, and Linear's offers only `list_teams`, `get_team`, `list_issue_statuses`, `get_issue_status`, `list_projects` and `get_project`, through Codex's per server allow list `enabled_tools`. Before the turn, `codex mcp list --json` and `codex mcp get <server> --json` must show exactly that, or the probe does not run.
- A ChatGPT connector cannot be narrowed to read tools, so Codex is never probed through one, and is told to add Linear's MCP server instead.

Known limits: a Linear tool whose name starts with a read verb but writes would pass the name check. Bollplank reads only the settings files named above. A rule that reaches Claude Code another way, such as a managed policy from a device management profile, a `--settings` file or a hook that approves tools, is not seen, and only the deny rules and the check of every call stand against it.

## Scope

These are in scope:

- **Subscription sign ins.** Any way Bollplank could make a client use a key, another account or a provider route instead of the person's own subscription sign in.
- **The environment scrub.** A key or provider variable that reaches a critic or a probe.
- **Critic access.** A way for a critic to reach a tool, an MCP server, a connector or a file outside what is listed above, or for a Claude Code critic to run a shell.
- **Board writes by setup.** Any way a setup command or a probe could write to the board.
- **Installing.** `install.sh` and `bollplank init` must never replace a file or a link they did not make. They link only where nothing exists, record every link in `~/.bollplank/install.json`, and `uninstall` removes only those.
- **The private name check.** A way for a listed name to pass the scan, or for the scan to print a name.
- **Command lines.** A config value or argument that reaches a shell unchecked. `deploy-wait` runs a repo's configured `command` through the shell by design, so that command is as trusted as your config.

Out of scope: the security of Claude Code, Codex, Linear, GitHub and AWS themselves, and what a lead model does with the permissions you gave its client.
