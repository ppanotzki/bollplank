# Bollplank: instructions for agents working on Bollplank

- This repo is public. Never put credentials, tokens, sign in files, or anything from a maintainer's or contributor's private config, projects or clients here. Examples use synthetic names only, such as Acme and `ACME-1`.
- Scripts are plain Node 20 or later with no dependencies, ESM through `package.json`.
- Tests use temporary folders and fake programs only (`test/helpers.mjs`). Never test against a real sign in, a real config or a real remote, and never with conflicting keys.
- Copy style: plain sentences, no em or en dashes, no semicolons, no filler.

## Project profile (Bollplank)

- Tracker: the maintainer's Linear project Bollplank. A GitHub issue the maintainer takes on becomes a ticket there, linked both ways.
- Lead: any tool. Whoever writes the brief is its Responsible agent, and Claude Code or Codex may implement it. The critic is the model not leading that ticket.
- Gates: `node scripts/check.mjs`, run on every PR as the `checks` workflow. It includes the private name check, which needs the maintainer's list.
- Shipping: there is no deploy. Ship by merging the PR with the merge command after the checks and any selected review stage, then pull the installed copy and run the gate there. A release is a `v<version>` tag on the merge commit with its CHANGELOG section.
- Version and build: the version is in `package.json`. Bump the minor in the PR that adds a command, skill or option, and the major when existing use changes. The build is the number of commits on master. `bollplank version` prints both.
- Release notes: none in the tracker beyond the ticket's release note comment. CHANGELOG.md holds them.
- Stop list: changing the repo's visibility, any change to how credentials or sign ins are handled, and anything outside the ticket.
- Risk stance: other people install this and it drives their subscriptions and repos. A leak of private data or a broken install is hard to take back.
- Ticket runs: allowed.
