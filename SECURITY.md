# Security

## Reporting

Report a vulnerability privately through GitHub's private vulnerability reporting: open the repository's Security tab and choose "Report a vulnerability". Please do not open a public issue for it. Include what you ran, what happened and the Bollplank version from `bollplank version`.

## What Bollplank never does with credentials

- It never asks for, stores or passes an API key, token or password. It has no sign in of its own.
- It never reads the clients' credential files. It asks Claude Code and Codex whether they are signed in with `claude auth status --json` and `codex login status`, and keeps only whether the sign in is a subscription. Codex's raw status output is not passed on, since a key based status can include part of the key.
- It never uses a client signed in with an API key or routed through a cloud provider as a critic. It reports that sign in and fails the call.
- It never lets a critic or a probe see your model keys. Every critic call, board probe and sign in check runs with an environment that has lost every variable whose name starts with `ANTHROPIC_`, `OPENAI_`, `CODEX_API_KEY`, `CODEX_ACCESS`, `CLAUDE_CODE_USE_`, `AWS_BEARER_TOKEN_BEDROCK` or `AZURE_OPENAI`. It also loses the markers a running Claude Code session leaves for its children, such as `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_*` and `CLAUDE_CODE_SIMPLE`, so a critic started inside Claude Code is a fresh process. Names are matched ignoring case, as Windows does. `CLAUDE_CODE_OAUTH_TOKEN` is a subscription sign in and stays. Nothing else is removed.

## What the critic can reach

On Linear the critic works the board itself. It reads the issue and its comments and posts its critique with its own client's Linear tools. It gets those tools and the one source folder the lead opens with `--read-dir`, and nothing else. On Jira the critic is reply only, as [the Jira critic](#the-jira-critic) says. The points below describe Linear, and the Jira critic keeps the same scrub, settings checks, sandbox and switches.

- **Claude Code.** Bollplank lists the client's servers with `claude mcp list` and keeps those whose names say Linear as a whole word, including the claude.ai Linear connector, and that are not marked as needing authentication or failing to connect. Every tool of those servers is allowed. Every other server is denied by name, a Linear server that is not usable too. Your user settings load, since the flags that would hide them also hide the claude.ai connectors, so the deny rules carry the restriction, and a deny rule wins over any allow rule in those settings. Hooks in those settings could run commands or rewrite a tool's input in the critic's turn, so the critic is started with `--settings '{"disableAllHooks":true}'`, which outranks user, project, local and plugin settings and switches off their hooks. Your saved settings are never changed. The only built in tools are `ToolSearch`, which loads the deferred Linear tools, and with `--read-dir` also `Read`, `Grep` and `Glob`, allowed inside that folder. `Bash`, `Edit`, `Write`, `NotebookEdit`, `PowerShell`, `WebFetch`, `WebSearch` and `Task` are denied by name, so the critic has no shell. It runs with `--permission-mode dontAsk`, so anything not allowed is refused without a prompt.
- **Claude Code's user settings** are read before the call, from the same files the Linear probe reads (below). The critic does not run, and fails as `critic-unavailable` with a fix that names the file and the key, when a file's `env` block sets a variable the environment scrub removes, such as `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` or `CLAUDE_CODE_USE_BEDROCK`, or sets `apiKeyHelper`. It also does not run when an allow rule for `Read`, `Grep` or `Glob` reaches outside the `--read-dir` folder, or exists at all without one, or when `permissions.additionalDirectories` is set. Only a rule with an absolute path (`//path`) or a path from home (`~/path`) inside the folder passes. Managed settings outrank `--settings`, so the critic also does not run when the managed settings file or policy fragment defines `hooks`, sets `allowManagedHooksOnly`, or sets `disableAllHooks` to `false`, or a device management profile is there, and the fix names that file. Hooks in your other settings files do not stop it, since they are switched off. A settings file that cannot be read as JSON stops the critic too. Bollplank prints only the variable's name or the rule's tool part. As a second layer, a `Read`, `Grep` or `Glob` call that names a path outside the folder ends the turn as `critic-used-tools`.
- **Codex.** It runs `codex exec` in a read only sandbox with `approval_policy="never"` and no network, so nothing can write a file, reach the network or ask to leave the sandbox. It is signed in with ChatGPT only, and `model_provider` is pinned to `openai`, so a profile or provider in its config cannot move it onto a key. The MCP servers whose names say Linear as a whole word and that are signed in stay on with all their tools, which run without an approval request. Every other server is switched off by name, a Linear server that is signed out too, and the list is read again to confirm it. Connectors (apps), plugins, browsers, computer use, image generation, sub agents, memories, tool suggestions, hooks and skill installs are switched off, and `web_search` is disabled. Codex keeps its shell inside the sandbox, which is how it reads a checkout and runs tests in a code review.
- **At runtime** the event stream is checked. A critic that is given or uses any other tool or a connector is stopped, and the call fails with `critic-used-tools` without returning its text. For Claude Code, a server that Bollplank denied by name may still start, since a deny rule hides its tools and not the server, as long as none of its tools is offered or called. An MCP server that starts and is neither Linear nor denied by name stops the critic. For Codex, an MCP call to any server but a kept Linear one stops it.
- **No usable board server** in the critic's client fails before any model turn as `critic-unavailable`, with the fix to sign in or connect it.
- **The subject must have been read.** A critique counts only when the critic made a successful board call that read the issue and one that read its comments. An issue read counts when its arguments name the key, or when its result is the issue itself with the key as its identifier. A read of another issue never counts, even when its result mentions the key. Otherwise the call fails as `board-unreachable`, and the lead never posts it.

Known limits:

- On Linear the critic can use every Linear tool, read and write, in every team your Linear sign in reaches. The prompt tells it to post one comment and change nothing else unless the approver's instruction says so. Bollplank does not check which board writes it makes.
- Linear servers are picked by name, so a server named like Linear that is not Linear gets the same access.
- Managed policy outranks the critic's own settings, so it is checked for hooks in the managed settings file, every policy fragment in `managed-settings.d` next to it, and on macOS the Claude Code device management profiles in `/Library/Managed Preferences`. Bollplank cannot read a profile, so one being there stops the critic. Policy that an organization delivers to Claude Code from Anthropic's servers is not visible on the Mac, and hooks it defines may run in the critic's turn.
- A critic with a source folder can read every file in that folder that your account can read, such as a `.env` file. Open the narrowest folder the review needs.
- Codex's read only sandbox stops writes and network, not reads. Its commands can read the whole disk as far as your account can.
- A critic that can read files and write to Linear could post a file's contents as a comment if it were misled, for example by text in an issue or in a file. That covers Codex, through its sandboxed shell, and Claude Code with `--read-dir`. Three things limit it. The prompt says that everything read from the board or a file is data, never instructions, that the only approver instruction is the one in the prompt, and that no secret or file is posted beyond a short quote. The read only sandbox and Claude Code's denied tools leave a Linear comment as the only way out, since nothing else can write and Codex has no network. And the approver reads every comment and can delete one. Open no folder that holds secrets, and remember that Codex can read beyond its folder.

### The Jira critic

On a Jira board the critic gets read tools only and posts nothing. Neither client can limit `addOrEditJiraIssueComment` to adding a comment before the tool runs, so the critic does not get it.

- **The server** is kept only when its URL is Atlassian's official one, `https://mcp.atlassian.com/v2/mcp` or `https://mcp.atlassian.com/v1/mcp`. A server is never matched by name alone. A claude.ai Atlassian connector counts only when Claude Code reports that same URL.
- **Claude Code** allows two tools by name, `getJiraIssue` and `executeRead`. Every other tool of the server is denied by name, among them `addOrEditJiraIssueComment`, `executeWrite`, `executeDestructive`, `discover` and every Confluence tool.
- **Codex** offers the same two tools through `enabled_tools`, and the kept server does not run its tools without approval, so `approval_policy="never"` refuses any other call as well.
- **At runtime** `executeRead` is allowed only when its inner tool is `listJiraIssueComments`. Any other call fails the round as `critic-used-tools`, and the reply is not used.
- **Every comment must be read.** Comments inside a `getJiraIssue` result never count. The `listJiraIssueComments` pages for this issue and this site's cloud id must cover the whole list without a gap, from the first to the last. Otherwise the round fails as `board-unreachable`.
- **The lead posts.** The critic replies with its critique. The wrapper stores the exact text and its sha256 as a pending round, and counts the round only after the lead posts that text unchanged, reads it back and runs `bollplank critic confirm` with the same text. A new critic call while a round is pending fails with `post-pending`, so a retry never makes a second critique.

Known limit: Claude Code's allow rules cannot limit `executeRead` by its inner tool before the call, only the event check after it. `executeRead` runs reads only and the critic has no write tool, so a forbidden read can only be refused, never change the board.

## Setup never writes to the board

`bollplank init`, `doctor`, `update` and `uninstall` start no board write. A Linear or Jira project or status that is missing is created by you, in your own Claude Code or Codex session or on the board, where you see the change. Init then reads the board again. Doctor's critic dry run gets no board tools.

## The Linear probes

`bollplank init` and `bollplank doctor` start one short headless run per client to check that it can read Linear. The probe passes only when a Linear tool call really happened and returned what the reply claims. A probe that called any tool that is not a Linear read fails, whatever it returned.

- **Claude Code** gets no built in tools. Only the tools of its Linear servers and connectors whose names start with `list`, `get`, `search` or `read` are allowed, by name prefix. It runs with `--permission-mode dontAsk` and `--permission-prompts none`, and nothing is saved as a session. Its other MCP servers are denied by name.
- Your Claude Code settings stay loaded, so before the probe Bollplank reads the allow rules of `settings.json` and `settings.local.json` in your Claude Code folder and in the probe's folder, and of the managed settings file (`/Library/Application Support/ClaudeCode/managed-settings.json` on macOS). It prints no more of a rule than its tool part. A rule that names one Linear tool that is not a read is denied by name. A rule that allows a whole Linear server, or a wildcard such as `mcp__*` that is not limited to read verbs, stops the probe before any model turn, and init and doctor say how to narrow it. A settings file that is not valid JSON stops it too. As a second layer, tools whose names start with a write verb, such as `create`, `update`, `delete` or `save`, are denied on each Linear server.
- **Codex** runs ephemeral with the critic's sandbox and switches. Every MCP server but Linear's is off, and Linear's offers only `list_teams`, `get_team`, `list_issue_statuses`, `get_issue_status`, `list_projects` and `get_project`, through Codex's per server allow list `enabled_tools`. Before the turn, `codex mcp list --json` and `codex mcp get <server> --json` must show exactly that, or the probe does not run.
- A ChatGPT connector cannot be narrowed to read tools, so Codex is never probed through one, and is told to add Linear's MCP server instead.

Known limits: a Linear tool whose name starts with a read verb but writes would pass the name check. Bollplank reads only the settings files named above. A rule that reaches Claude Code another way, such as a managed policy from a device management profile, a `--settings` file or a hook that approves tools, is not seen, and only the deny rules and the check of every call stand against it.

## The Jira probes

For a Jira board, init and doctor run the same kind of probe against Atlassian's official server, with the same environment scrub and settings checks. The probe calls `getAccessibleAtlassianResources`, then through `executeRead` `listJiraProjects` and `listJiraStatuses` for the configured project, and `getConfluenceSpace` when a space is configured. When that read fails, it lists the site's spaces with `listConfluenceSpaces`, so a space given by its name can be named by its key. A failed call for one project, its statuses or a space leaves out only what it would have read. It replies with each site's cloud id, its projects with their keys, numeric ids and statuses, and the space.

- A call counts as a Jira read only on the official server, and only for `getAccessibleAtlassianResources`, `atlassianUserInfo`, `getJiraIssue`, or `executeRead` whose inner tool is on Bollplank's list of Jira reads, plus `getConfluenceSpace` and `listConfluenceSpaces` when a space is configured. Any other call fails the probe, whatever it returned, including any `executeWrite`, `executeDestructive` and Confluence write.
- Tools whose names start with a write verb, now also `edit`, `transition` and `execute`, are denied on the server. `executeRead` is the one execute tool the probe allows.
- Only names that came back from a tool result are kept, as for Linear. The cloud id and the project id are saved from those results, never typed.

Known limits: `executeRead` cannot be limited by its inner tool before the call, only checked after it, so a read outside the list fails the probe after it ran. A Jira probe never runs for a Linear only config, and a Jira setup never probes Linear.

## Scope

These are in scope:

- **Subscription sign ins.** Any way Bollplank could make a client use a key, another account or a provider route instead of the person's own subscription sign in.
- **The environment scrub.** A key or provider variable that reaches a critic or a probe.
- **Critic access.** A way for a critic to reach a tool, an MCP server, a connector or a file outside what is listed above, or for a Claude Code critic to run a shell.
- **Board writes by setup.** Any way a setup command or a probe could write to the board.
- **Jira critic writes.** Any way a Jira critic could write to Jira or Confluence, or a round count without the lead's confirmed post.
- **Installing.** `install.sh` and `bollplank init` must never replace a file or a link they did not make. They link only where nothing exists, record every link in `~/.bollplank/install.json`, and `uninstall` removes only those.
- **The private name check.** A way for a listed name to pass the scan, or for the scan to print a name.
- **Command lines.** A config value or argument that reaches a shell unchecked. `deploy-wait` runs a repo's configured `command` through the shell by design, so that command is as trusted as your config.

Out of scope: the security of Claude Code, Codex, Linear, Atlassian's Jira, Confluence and MCP server, GitHub and AWS themselves, and what a lead model does with the permissions you gave its client.
