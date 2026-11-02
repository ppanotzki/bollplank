# Security

## Reporting

Report a vulnerability privately through GitHub's private vulnerability reporting: open the repository's Security tab and choose "Report a vulnerability". Please do not open a public issue for it. Include what you ran, what happened and the Bollplank version from `bollplank version`.

## What Bollplank never does with credentials

- It never asks for, stores or passes an API key, token or password. It has no sign in of its own.
- It never reads the clients' credential files. It asks Claude Code and Codex whether they are signed in with `claude auth status --json` and `codex login status`, and keeps only whether the sign in is a subscription. Codex's raw status output is not passed on, since a key based status can include part of the key.
- It never uses a client signed in with an API key or routed through a cloud provider as a critic. It reports that sign in and fails the call.
- It never lets a critic or a probe see your model keys. Every critic call, Linear probe and sign in check runs with an environment that has lost every variable whose name starts with `ANTHROPIC_`, `OPENAI_`, `CODEX_API_KEY`, `CODEX_ACCESS`, `CLAUDE_CODE_USE_`, `AWS_BEARER_TOKEN_BEDROCK` or `AZURE_OPENAI`. These are the model keys and the provider routes. It also loses the markers a running Claude Code session leaves for its children, such as `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_*` and `CLAUDE_CODE_SIMPLE`, so a critic started inside Claude Code is a fresh process. Names are matched ignoring case, as Windows does. `CLAUDE_CODE_OAUTH_TOKEN` is a subscription sign in and stays. Nothing else is removed.

## How the critic is isolated

The critic gets no board, no MCP servers and no connectors, for either provider.

- **Claude Code** runs with `--strict-mcp-config`, so no configured MCP server loads, with `ENABLE_CLAUDEAI_MCP_SERVERS=false`, so no claude.ai connector loads, and with only the local settings of its neutral folder. Without `--read-dir` it has no tools at all. With `--read-dir` it has only `Read`, `Grep` and `Glob`, allowed inside that folder, with `Bash`, `Edit`, `Write`, `NotebookEdit` and `PowerShell` denied.
- **Codex** runs in a read only sandbox, signed in with ChatGPT only, with `model_provider` pinned to `openai` so a profile or provider in its config cannot move it onto a key. Each MCP server Codex lists is switched off by name, and the list is read again to confirm. When one cannot be switched off, the critic is not started. Connectors (apps), plugins, browsers, computer use, image generation, sub agents, memories, tool suggestions, hooks and skill installs are switched off, and `web_search` is disabled.
- **At runtime** the event stream is checked. A critic that is given or uses any other tool, an MCP server or a connector is stopped, and the call fails with `critic-used-tools` without returning its text.

Known limits:

- A critic with a source folder can read every file in that folder that your account can read, such as a `.env` file. Open the narrowest folder the review needs.
- Codex's read only sandbox stops writes, not reads. A Codex critic can run read only commands, and they can read the whole disk as far as your account can. This is a known limit of the sandbox, and Bollplank does not narrow it.

## The Linear probes

`bollplank init` and `bollplank doctor` start one short headless run per client to check that it can read Linear. The probe passes only when a Linear tool call really happened and returned what the reply claims.

Each probe is set up so that it cannot write before it starts:

- **Claude Code** gets no built in tools, and only the tools of its Linear servers and connectors whose names start with `list`, `get`, `search` or `read` are allowed, by name prefix. It runs with `--permission-mode dontAsk` and `--permission-prompts none`, so any tool that is not allowed is denied without a prompt. Nothing is saved as a session.
- Your Claude Code settings stay loaded, since `--setting-sources local` also hides the claude.ai connectors. dontAsk still runs a tool that a saved `permissions.allow` rule approves, so before the probe starts Bollplank reads the allow rules of `settings.json` and `settings.local.json` in your Claude Code folder, of the same two files in the probe's folder, and of the managed settings file (`/Library/Application Support/ClaudeCode/managed-settings.json` on macOS). It prints no more of a rule than its tool part. A rule that names one Linear tool that is not a read is denied by name, since a deny rule wins over an allow rule. A rule that allows a whole Linear server, or a wildcard such as `mcp__*` that is not limited to read verbs, stops the probe before any model turn, and init and doctor say how to narrow it. A settings file that is not valid JSON stops it too. As a second layer, tools whose names start with a common write verb, such as `create`, `update`, `delete` or `save`, with or without a `linear_` prefix, are denied on each Linear server.
- Claude Code's other MCP servers still load. `--strict-mcp-config` would drop every server not given in `--mcp-config`, and the claude.ai Linear connector is an account connector that cannot be given there, so it would drop Linear too. Each of them is denied by name, which wins over any allow rule in your settings.
- **Codex** runs ephemeral, with the critic's isolation: a read only sandbox, ChatGPT sign in only, `model_provider` pinned, connectors (apps), plugins and the other tool features off, and `web_search` disabled. Every MCP server it lists is switched off by name except those whose names say Linear, and each of those offers only `list_teams`, `get_team`, `list_issue_statuses`, `get_issue_status`, `list_projects` and `get_project`, through Codex's per server allow list `enabled_tools`. Before the turn starts, `codex mcp list --json` must show only the Linear servers on and `codex mcp get <server> --json` must show exactly that allow list, or the probe does not run.
- A ChatGPT connector cannot be narrowed to read tools, so Codex is never probed through one. When Linear reaches Codex only as a connector, the probe does not run and says to add Linear's MCP server.
- For both, a probe that called any tool that is not a Linear read, whatever its service, fails, whatever it returned.

Known limits: the Linear servers are picked by name, so a server named like Linear that is not Linear gets the same read only allowance. A Linear tool whose name starts with a read verb but writes would pass the name check, and for Claude Code it would be allowed. Bollplank reads only the settings files named above. A rule that reaches Claude Code another way, such as a managed policy delivered by a device management profile, a `--settings` file or a hook that approves tools, is not seen, and only the deny rules and judge's check of every call stand against it.

## Scope

These are in scope:

- **Subscription sign ins.** Any way Bollplank could make a client use a key, another account or a provider route instead of the person's own subscription sign in.
- **The environment scrub.** A key or provider variable that reaches a critic or a probe.
- **Critic isolation.** A way for a critic to reach the board, an MCP server, a connector, a write tool or a file outside its source folder, beyond the limits above.
- **Installing.** `install.sh` and `bollplank init` must never replace a file or a link they did not make. They link only where nothing exists, record every link in `~/.bollplank/install.json`, and `uninstall` removes only those.
- **The private name check.** A way for a listed name to pass the scan, or for the scan to print a name.
- **Command lines.** A config value or argument that reaches a shell unchecked. `deploy-wait` runs a repo's configured `command` through the shell by design, so that command is as trusted as your config.

Out of scope: the security of Claude Code, Codex, Linear, GitHub and AWS themselves, and what a lead model does with the permissions you gave its client.
