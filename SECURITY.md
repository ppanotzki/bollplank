# Security

## Reporting

Report a vulnerability privately through GitHub's private vulnerability reporting: open the repository's Security tab and choose "Report a vulnerability". Please do not open a public issue for it. Include what you ran, what happened and the Bollplank version from `bollplank version`.

## What Bollplank never does with credentials

- It never asks for, stores or passes an API key, token or password. It has no sign in of its own.
- It never reads the clients' credential files. It asks Claude Code and Codex whether they are signed in with `claude auth status --json` and `codex login status`, and keeps only whether the sign in is a subscription. Codex's raw status output is not passed on, since a key based status can include part of the key.
- It never uses a client signed in with an API key or routed through a cloud provider as a critic. It reports that sign in and fails the call.
- It never lets a critic see your model keys. Every critic call runs with an environment that has lost every variable matching `ANTHROPIC_*`, `OPENAI_*`, `CODEX_API_KEY*`, `CODEX_ACCESS*`, `CLAUDE_CODE_USE_*`, `AWS_BEARER_TOKEN_BEDROCK` and `AZURE_OPENAI*`. Nothing else is removed.
- It never gives a critic write tools, MCP servers or the board. A Claude Code critic gets read tools only, and a Codex critic runs in a read only sandbox.

## Scope

These are in scope:

- **Subscription sign ins.** Any way Bollplank could make a client use a key, another account or a provider route instead of the person's own subscription sign in.
- **The environment scrub.** A key or provider variable that reaches a critic.
- **Installing.** `install.sh` and `bollplank init` must never replace a file or a link they did not make. They link only where nothing exists, record every link in `~/.bollplank/install.json`, and `uninstall` removes only those.
- **The private name check.** A way for a listed name to pass the scan, or for the scan to print a name.
- **Command lines.** A config value or argument that reaches a shell unchecked. `deploy-wait` runs a repo's configured `command` through the shell by design, so that command is as trusted as your config.

Out of scope: the security of Claude Code, Codex, Linear, GitHub and AWS themselves, and what a lead model does with the permissions you gave its client.
