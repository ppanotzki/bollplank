# Bollplank: instructions for agents working on Bollplank

- This repo becomes public. Never put credentials, tokens, sign in files, or anything from Paul's private config, projects or clients here. Examples use synthetic names only.
- Scripts are plain Node with no dependencies, ESM through `package.json`.
- Never test against real sign ins with conflicting keys.
- Copy style: plain sentences, no em or en dashes, no semicolons, no filler.

## Project profile (Bollplank)

- Linear: team NeoLogic (key NEO), project Bollplank.
- Kit config name: `bollplank` in agent-workflow's `config/projects.json`. Ticket folders live in `~/Work/Tools/Tickets`.
- Lead: any tool. Whoever writes the brief is its Responsible agent, and Claude Code or Codex may implement it. The critic is the model not leading that ticket.
- Gates: `node scripts/check.mjs`, run on every PR as the `checks` workflow.
- Shipping: there is no deploy yet. Ship by merging the PR with `aw-merge bollplank bollplank <pr>`, then `git -C ~/Work/Tools/bollplank pull --ff-only`, then `node scripts/check.mjs` there. Releases and installing come with the first version.
- Version and build: set by the first version's ticket.
- Release notes: none in Linear. The ticket's release note comment is enough.
- Stop list: making the repo public (Paul only), any change to how credentials or sign ins are handled, any change to agent-workflow, and anything outside the ticket.
- Risk stance: the repo becomes public and other people will install it. A leak of private data or a broken install is hard to take back.
- Ticket runs: allowed.
