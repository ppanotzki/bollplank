# Changelog

## 0.5.1 (2026-11-06)

- `bollplank ticket remove` now checks inside submodules. Before, it looked only at the repo itself, so an ignored file such as `lib/.env` or a stash inside an initialized submodule was deleted without asking. Now every submodule git folder the worktree holds is checked, nested ones included: each gitlink in the index with a checkout, an embedded repo without a `.gitmodules` entry too, and each git folder that `git submodule deinit` left without a checkout. A checked out submodule refuses on changes, untracked and ignored files the same way as the repo, and on a checkout that is not the commit the repo records. Every such git folder refuses on a stash, on linked worktrees of its own, and on commits on HEAD or a local branch that are in the history of nothing its remotes advertise now, branch or tag. Remove asks each remote rather than trusting remote tracking refs, which a branch deleted on the remote can leave behind. It fetches first, and completes a shallow clone, since its boundary hides that history. That includes a commit the repo's merged gitlink points to that was never pushed to the submodule's own remote. Paths are named from the repo root, and `disposable` patterns such as `lib/dist/` reach into submodules. A check that cannot run refuses. A repo whose submodules were never initialized behaves as before.

## 0.5.0 (2026-11-06)

- A repo can list `disposable` paths in the config, such as `["dist/", "**/*.tsbuildinfo"]`. `bollplank ticket remove` deletes ignored files that match without asking and names them in its output, so build output the gates made no longer stops every acceptance. Any other ignored file still refuses as before, and `--force-ignored` still deletes all of them. Patterns are matched from the repo root, with `*` within a folder name, `**` for zero or more folders and a trailing `/` for a folder only. Validation refuses absolute paths, `..`, other glob characters and patterns without a letter or digit, such as `*.*`, which match almost anything.
- `ticket remove` now asks git for untracked files even when the repo or the person sets `status.showUntrackedFiles=no`. Before, that setting hid untracked and ignored files from the check, so remove could delete them without asking.

## 0.4.1 (2026-11-06)

- A `github-actions` deploy no longer waits until its timeout for a merge the workflow's push filters exclude. It reads the push trigger from the workflow file at the merge commit, with its `branches`, `branches-ignore`, `paths` and `paths-ignore` lists, and checks them the way GitHub does against the merged pull request's base branch and the commit's changed files, when the commit is the squash merge of one pull request and no other branch or tag push could start the workflow on it. When they exclude the merge and no run is there, it returns `succeeded` at once with a note that no run was started. Whenever it cannot tell for sure, such as for a workflow with another trigger than `push` and `workflow_dispatch`, it waits for the run as before, and a timeout says why.

## 0.4.0 (2026-11-06)

- A `command` deploy now runs in a clean, detached checkout of the merge commit, made for the call in a temporary folder and removed after it, with `node_modules` cloned in when the repo has `cloneNodeModules`. Before, it ran in the repo's own folder, whatever revision and local edits sat there, so a command that checked the deploy against the code could fail a good deploy or pass an old one. A command that read local, ignored or uncommitted files from that folder no longer finds them.
- `deploy-wait` accepts only a commit on `origin/<baseBranch>`, and fetches origin first when the commit is not there yet. It fails with `no-checkout`, `commit-missing`, `checkout-failed` or `interrupted` where it used to run the command anyway or leave it running. Programs the command leaves running are stopped before the result, since their checkout goes next: SIGTERM, then SIGKILL after five seconds.

## 0.3.5 (2026-11-04)

- The repository is public, so the getting started guide no longer asks for an invite or a GitHub sign in before the clone.

## 0.3.4 (2026-11-04)

- Doctor also tries Claude Code's Linear read once more when `claude mcp list` does not list the Linear server, since its health check can miss a server for a moment.

## 0.3.3 (2026-11-04)

- Doctor tries a failed Linear read or test critique once more before it reports a failure, since Claude Code, Codex or their services can fail for a moment. The check says when it passed on the second try or failed on both. A read that called a tool other than a Linear read is never tried again, even when it then ran out of time.

## 0.3.2 (2026-11-04)

- The getting started guide adds Draft, Ready and Acceptance in section 1, together with the Inbox rename, while you are already in the team's Workflow settings. Init then finds all five statuses.

## 0.3.1 (2026-11-04)

- The getting started guide renames a new team's Backlog status to Inbox, where ideas wait until one gets a brief.

## 0.3.0 (2026-11-04)

Fixes from a Hello World walk through the getting started guide.

- The getting started guide is written for the Claude app, step by step. Terminal is used only to make the project folder and to install. It keeps the team key Linear suggests, here ACM, and its first ticket is one an empty repo can ship. The docs check allows `ACM-<n>` keys next to `ACME-<n>`.
- Init asks for runs before checks and a deploy, and asks for those only when runs are on. With runs off a repo needs no checks, and `bollplank merge` refuses a repo without them. A config with runs on still needs checks.
- Init says a Linear project is not the team when the team has none yet, and lists a team's projects to pick from. The steps to add every missing status come once, before the status questions, with the team's name as Linear's settings show it. Doctor's steps name the team the same way.
- Init's sentence for creating a project from a session says to start a new session and to check its reply, since a client may run the call without asking.
- The project's status question says what board and own mean. The runs question says what a run stops for.
- The default copy style is "Plain sentences. No em or en dashes. No semicolons. No filler."
- Without a pinned model, the critic's Model line is the model the client last reported, from doctor's dry run or an earlier critique, instead of `Unverified`.
- Doctor says that its checks take a few minutes and names each slow check as it starts, on stderr.
- An Approve critique says in a sentence or two what the critic checked. The approval header links its comment as a markdown link.

## 0.2.1 (2026-11-03)

Fixes from a fresh setup on an empty home.

- A client that is not signed in is named once, with one fix, in init and doctor. "Bollplank will not use it this way" is said only for a sign in that is not a subscription.
- Doctor's Linear check asks you to sign in to each client first when one is signed out, instead of sending you to init.
- Init names only the suggested statuses the team really lacks, and says nothing when it has them all. The steps to add a status are shown once, not again after each read.
- The getting started guide says that the clone needs access to the repo while it is private, and git signed in to GitHub.

## 0.2.0 (2026-11-02)

- The critic works the board itself. It reads the issue and its comments with its own client's Linear tools and posts its critique as one comment. A round counts only when it read the issue and its comments, otherwise the call fails with `board-unreachable` and the session is kept for a retry. A client with no Linear server fails with `critic-unavailable` before any model turn. `posted` says whether the comment was saved.
- The critic gets the Linear tools of its client and nothing else beyond its source folder. Claude Code gets no shell, with every other MCP server and the shell, edit and web tools denied by name, and your user settings loaded with the deny rules winning and every hook switched off. Managed settings that could keep hooks on stop it. Codex keeps its shell inside the read only sandbox, with no network and no approvals, and every other MCP server switched off. Its Linear tools run without an approval request, which only the Linear servers get, so it can post its comment.
- `bollplank critic --instruction-file` passes an instruction from the approver to the critic. The prompts gain `{ISSUE}` and `{INSTRUCTION}`. When the client reports another model than the pinned one, the result carries `modelCorrection`. When the posted header lacks or misstates its Reviewer, Model or Workflow line, the result carries `headerCorrection` and the critique skill fixes the posted comment's header.
- Statuses per project. A project can map the five workflow states to its own team's statuses in `projects.<name>.board.statuses`. Each state's name comes from the project's mapping, then the top level one, then Linear's suggestion of Draft, Ready, In Progress, Acceptance and Done. `bollplank context <project>` returns the project's mapping, team and project, and doctor checks each project against its own team. A key under `board.statuses` other than the five states fails validation. A run's profile hash leaves out the statuses a project takes from the top level, so a run started on 0.1.0 goes on.
- Init asks for each project's Linear team and project, and whether it maps its own statuses. It explains each workflow state and which suggested statuses a new Linear team lacks. A project set up again keeps its earlier answers as the defaults. A consulting or configuration project of the same name is kept as it is unless you replace it.
- Doctor warns with `path.<client>` when a client is found only in its app bundle, and gives the line to put it on `PATH`, with `fish_add_path` for fish and `~/.bash_profile` for bash on macOS.
- Init never writes to the board. For a missing Linear project it offers another project, a sentence to type in your own Claude Code or Codex session, or the steps in Linear, and then reads Linear again. It stops with `missing-project` after three reads without it. The board skill gains two operations you ask for: create a project, after confirming the team and the name, and check a project's statuses.
- New guides: getting started and an existing project. The reference pages are shorter.
- The gate checks the docs, skills, prompts, `AGENTS.md` and `.github/` for ticket keys other than `ACME-<n>` in any case and with any dash, standards such as `UTF-8` left out, and for internal names, and requires `{ISSUE}` and `{INSTRUCTION}` in the critic prompts.

## 0.1.0 (2026-11-02)

The first version.

- One command, `bollplank`, in plain Node 20 or later with no dependencies. Every command prints one JSON result, except the setup commands, which talk to a person. `bollplank <command> --help` prints each command's usage.
- Setup: `install.sh` (with `--no-init` and `-- <init options>`), `bollplank init`, `doctor`, `update` and `uninstall`. Init finds Claude Code and Codex and their subscription sign in, reads Linear from each client, writes `~/.bollplank/config.json` and links the skills, in seven steps that an answers file can drive. It never creates a Linear status and never replaces a file or link it did not make. Doctor checks every kit skill in each client, Linear from each client found, and the configured team, projects and statuses against Linear. The Linear probes start with only Linear read tools. Claude Code's probe denies Linear write tools that a saved allow rule names, and does not run while a saved allow rule covers Linear tools broadly. Board names are compared exactly, and init saves them as Linear returned them. Codex is probed only through Linear's MCP server, never a ChatGPT connector. `update --pre` takes pre-releases, and update never goes back. `uninstall --purge` refuses a folder that is not a Bollplank home and a held ship lock.
- One validated config with the approver, copy style, board team, project and statuses, critic setting, ship lock and projects. Relative paths resolve against the config's folder. `bollplank context` gives skills everything they need from it, including each project's board and its critic default. A project may set its own `critic.default`, and a `shipOrder` lists every repo once.
- The Workflow line `Bollplank <version>, build <n>` from `bollplank version`, on every brief and comment.
- The critic, `bollplank critic`, for Claude Code and Codex on subscriptions only. Model keys, provider routes and client session markers are removed from its environment. It gets no board, no MCP servers and no connectors with either client, and fails with `critic-used-tools` if a client gives it a tool anyway. The wrapper writes the critique's Reviewer, Model and Workflow lines, with the model the client reported. One session per ticket is reused across the brief, plan and code, with rounds counted per subject, one call at a time, and `--new-session` for a session the client lost.
- Same model mode: a separate session of the lead's own client with a harder prompt, used only when chosen, and labelled in the Reviewer line. Nothing switches the critic on its own.
- Eight skills: `bollplank-brief`, `-critique`, `-address`, `-approve`, `-run`, `-ship`, `-accept` and `-board`, with Linear as the only board.
- Ticket runs in three modes: repository, consulting and configuration. Runs are off unless a project sets `runs` to `true`.
- `bollplank ticket` for worktrees per repo with a base branch per repo, `bollplank run` for the run record and its review gates, `bollplank turn` for the shipping lock, which another kit writing the same record can share, and `bollplank merge`, which merges only on green configured checks and complete review stages, for the run's own ticket and repo and a PR from the ticket branch in the configured repo, never a fork, and with a selected code stage only when the PR head carries the change approved for that repo by verbatim patch id, which keeps whitespace. A code round names the reviewed head of each repo with `--revisions`, and `bollplank run check-shipped` says whether every changed repo is merged and deployed, by a deploy of its configured kind.
- `bollplank deploy-wait` with the deploy kinds `none`, `command`, `amplify` and `github-actions`, each returning a status of `succeeded`, `failed` or `timeout` and a ref that `bollplank run deploy` records.
- `bollplank ledger` for tokens per model and the timeline of each ticket, reading Bollplank's markers and those of another tool that writes the same kind of marker.
- The gate `scripts/check.mjs`, run in CI on Ubuntu and Windows with Node 20 and 22 and locally on macOS before every PR, with a private name check whose list lives outside the repo. It reads whole messages, authors and committers, binary and `-diff` files and merge changes, and fails on a shallow clone or an invalid pattern. Projects can opt in to the same check at merge with `privateScan`, which also scans the PR title and body that become the squash message.
