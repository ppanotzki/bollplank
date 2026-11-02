# Changelog

## 0.1.0 (unreleased)

The first version.

- One command, `bollplank`, in plain Node 20 or later with no dependencies. Every command prints one JSON result, except the setup commands, which talk to a person.
- Setup: `install.sh`, `bollplank init`, `doctor`, `update` and `uninstall`. Init finds Claude Code and Codex and their subscription sign in, probes Linear from each client, writes `~/.bollplank/config.json` and links the skills. It never replaces a file or link it did not make.
- One validated config with the approver, copy style, board statuses, critic setting, ship lock and projects. `bollplank context` gives skills everything they need from it.
- The Workflow line `Bollplank <version>, build <n>` from `bollplank version`, on every brief and comment.
- The critic, `bollplank critic`, for Claude Code and Codex on subscriptions only. Model keys and provider settings are removed from its environment. It gets no board, no MCP servers and read tools only. One session per ticket is reused across the brief, plan and code, with rounds counted per subject.
- Same model mode: a separate session of the lead's own client with a harder prompt, used only when chosen, and labelled in the Reviewer line. Nothing switches the critic on its own.
- Eight skills: `bollplank-brief`, `-critique`, `-address`, `-approve`, `-run`, `-ship`, `-accept` and `-board`, with Linear as the only board.
- Ticket runs in three modes: repository, consulting and configuration. Runs are off unless a project sets `runs` to `true`.
- `bollplank ticket` for worktrees per repo with a base branch per repo, `bollplank run` for the run record and its review gates, `bollplank turn` for the shipping lock, which another kit writing the same record can share, and `bollplank merge`, which merges only on green configured checks and complete review stages.
- `bollplank deploy-wait` with the deploy kinds `none`, `command`, `amplify` and `github-actions`.
- `bollplank ledger` for tokens per model and the timeline of each ticket, reading markers from both Bollplank and the kit it replaces.
- The gate `scripts/check.mjs`, run in CI on Ubuntu, macOS and Windows with Node 20 and 22, with a private name check whose list lives outside the repo. Projects can opt in to the same check at merge with `privateScan`.
