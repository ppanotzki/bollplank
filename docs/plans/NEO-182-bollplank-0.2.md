# NEO-182 implementation plan: Bollplank 0.2.0

Plan v5
Status: Revised after Codex's plan v4 round (five points accepted), for the next round
Ticket: NEO-182, brief v9, approved 2026-11-02, Cross-model review both
Responsible: Claude Code
Model: Claude Opus 5.5
Workflow: agent-workflow 1.0, build 27
Repo: `ppanotzki/bollplank` (private), branch `neo-182-v1` from master at 98eee2e (v0.1.0), worktree `~/Work/Tools/Tickets/NEO-182/bollplank`

Brief v9 changes Bollplank 0.1.0 in four ways: settled decisions 16 (the critic works the board), 17 (statuses per project) and 18 (board setup on request), and the Phase 5 docs rework. This plan covers only those changes. Everything else in 0.1.0 stays as plan v3 built it. This file is removed from the repo by the last commit of the branch, since the repo holds no internal plans, so the squash merge on master never contains it.

## 1. The critic works the board (decision 16)

The critic reads the issue and its comments itself and posts its own critique, as in agent-workflow. The human stays in charge: an explicit instruction from the approver in the prompt can have it edit the brief or write elsewhere on the board.

**What it gets.** The board's MCP tools in its own client, every tool of the board's servers, read and write. No file edits, no web and no other MCP server. Claude Code gets no shell. With `--read-dir` it also gets Read, Grep and Glob inside that folder, as today. Codex keeps its shell inside the read only sandbox, as in agent-workflow and 0.1.0, because that shell is how Codex reads a checkout and runs its tests in a code review. The sandbox stops every file write and every network call from that shell. Brief v9 says "no shell" without that distinction, so Paul is told of this reading, and the brief line is clarified when he agrees.

* **Claude Code** (`lib/providers/claude.mjs`, `review`): drop `--strict-mcp-config`, `ENABLE_CLAUDEAI_MCP_SERVERS=false` and `--setting-sources local`, since that flag hides the claude.ai connectors (found in 0.1.0's probe). User settings then load, so the deny rules below carry the restriction: a deny rule wins over any allow rule in those settings. List servers with `claude mcp list` as the probe does, keep those whose name says Linear, and allow `mcp__<id>__*` for each of them. Deny every other server by name (`denyOthers`), deny `Bash,Edit,Write,NotebookEdit,PowerShell,WebFetch,WebSearch,Task`, and run with `--permission-mode dontAsk`. ToolSearch stays available, since Claude Code defers MCP tools behind it. `toolsUsed` accepts the read tools, ToolSearch and `mcp__<linear id>__*`, and still ends the turn as `critic-used-tools` on anything else, including an MCP server in the init event that is not a Linear one. A test covers a critic whose only Linear connection is the claude.ai connector.
* **Codex** (`lib/providers/codex.mjs`, `review` and `isolate`): keep the read only sandbox, `approval_policy=never` and every feature switched off as today. Instead of switching every MCP server off, keep the Linear MCP servers on with all their tools and switch the rest off. Connectors stay off (`apps` disabled), so Codex reaches Linear only through its Linear MCP server, as the probe already requires. `ALLOWED_ITEMS` gains `mcp_tool_call` for a Linear server only. Any other item type, or a call to another server, is `critic-used-tools`. `command_execution` stays allowed as in 0.1.0, inside the read only sandbox. A test checks the sandbox flags that stop writes and network are on the argv.
* **No Linear server** in the critic's client fails before the turn as `critic-unavailable`, with the same fix text the probe gives (`bollplank init`, or `claude mcp add` / `codex mcp login linear`).
* **The subject must have been read.** A critique counts only when the critic made a successful board call that read the issue (a `get_issue` style tool whose arguments name `{ISSUE}`) and one that read its comments (a `list_comments` style tool for the same issue). Without both, the call fails as `board-unreachable`, the round is not counted, and the session is kept, so a retry resumes it. This covers a late connector start as agent-workflow's preflight does, without a separate turn. The lead never posts a critique whose subject the critic did not read.

**Prompts** (`prompts/critic.md`, `prompts/critic-same.md`): the critic reads the issue `{ISSUE}`, its comments and the subject, posts the critique as one comment with its board tool, and replies with exactly the text it posted. The header lines `Reviewer`, `Model` and `Workflow` are filled by the wrapper before the call, as today. A new placeholder `{INSTRUCTION}` carries an optional instruction from the approver, empty by default.

**The wrapper** (`lib/commands/critic.mjs`): new option `--instruction-file f`, whose text fills `{INSTRUCTION}` under a line saying it comes from the approver. The wrapper no longer rewrites the header after the call. It checks the reply starts with `Critique of` and has a Verdict, as today, and returns the text. It reports `posted: true` when the critic made a successful call to a board tool that saves or creates a comment on `{ISSUE}`, else `posted: false`.

**The Model line.** The wrapper fills `Model` before the call with the pinned model and effort, or `Unverified`, as today. After the call it compares the model the client reported. When they differ, the returned text has the reported model, and the result carries `modelCorrection: { posted, reported }`. The skill then edits the posted comment's Model line to the reported model with the board's comment update tool, so the comment and the returned text match. Round counting, sessions, locks, `--new-session` and the ledger binding are unchanged.

**The skill** (`skills/bollplank-critique`): after the call, read the issue's comments. When the critique is there, apply a `modelCorrection` if there is one, and do nothing more. When it is missing, which happens only when posting failed after the subject was read, post the returned text unchanged and say in the summary that the lead posted it. `board-unreachable` is a failed call, reported to the approver like any other. An instruction from the approver goes through `--instruction-file`, never into the template.

**Same model mode** works the same way, with the lead's own client.

## 2. Statuses per project (decision 17)

* **Board kinds** (`lib/boards.mjs`, new): `BOARDS = { linear: { label: 'Linear', statuses: { draft: 'Draft', ready: 'Ready', inProgress: 'In Progress', acceptance: 'Acceptance', done: 'Done' }, newTeam: ['Backlog', 'Todo', 'In Progress', 'Done', 'Canceled'] } }`. `DEFAULT_STATUSES` in `lib/config.mjs` is replaced by the board kind's suggestion. `newTeam` is used only in init's and doctor's explanations.
* **Config** (`lib/config.mjs`): `projects.<name>.board.statuses` is validated like `board.statuses` (an object of the five keys, each a name). `withDefaults` fills each project's effective statuses: the project's own, then the top level `board.statuses`, then the board kind's suggestion. A project in another team is no longer forced to share status names.
* **Context** (`lib/commands/context.mjs`): `context <project>` returns `board.statuses` for that project, its effective mapping. `boards` gains each project's `statuses`. Without a project, `board.statuses` stays the top level one.
* **Doctor** (`lib/commands/doctor.mjs`, `boardChecks`): checks each project's team, project and effective statuses against that team's read. The fix names the right key, `projects.<name>.board.statuses.<key>` or `board.statuses.<key>`, by where the name came from.
* **Init** (`lib/commands/init.mjs`): step 3 keeps the board wide team, project and mapping, now offered as the board kind's suggestion. Step 5, for each project, asks for the project's team and Linear project, defaulting to step 3's, and then asks "Use the same statuses as the board, or map this project's own?" When the team differs from step 3's, it maps by default. The mapping question lists the team's statuses as read, explains what each workflow state means in one line, and says which suggested names a new Linear team lacks. Answers file keys `projects.<name>.team`, `projects.<name>.project` and `projects.<name>.statuses.<key>`.
* **Board skill** (`skills/bollplank-board`): uses `board.statuses` from `context <project>` only, which is now the project's own.

## 3. Board setup on request (decision 18)

* **Create a project.** In init step 3 and step 5, when the named Linear project does not exist in the team read, init asks "Create the Linear project <name> in <team>?" (default no). On yes it runs one write call through Claude Code, allowed only Linear tools whose name is `save_project` or `create_project` (with or without a `linear_` prefix), with the same isolation as the probe otherwise. Allow rules cannot check arguments, and Linear's `save_project` also updates an existing project when given an id, so the call also gets a `PreToolUse` hook through `--settings`. The hook is a small Node script in Bollplank that runs before every tool call and denies it unless: the tool is one of those two, the input has no `id`, the project name equals the confirmed name, the team list names only the confirmed team (by its key, name or id from the read), and no earlier call in this run succeeded. So an update to another project never runs, even if a later readback finds the new one. Init then reads Linear again with the read only probe and continues only when the project is there. Codex has no such pre call check for MCP arguments, so with only Codex installed init gives the steps to create the project in Linear instead. Answers file key `createProject.<team>.<project>`.
* **Statuses.** Linear's MCP server has no tool to create a status. For each missing status init gives the steps in Linear's settings (Settings, Teams, the team, Workflow, the status group) and offers to read again, as today, up to three times.
* `judge()` and the read only probe are unchanged. The write call has its own judge: at most one allowed call, all others denied by the hook, and a readback that shows the project.

## 4. Docs (Phase 5)

Short and to the point. Each page says what to do and why in as few lines as it can. Detail that only matters for security lives in SECURITY.md.

* **README.md**, at most about 900 words: what it is with the article link, the loop diagram, **the five workflow states** in a small table (state, what it means, Linear's suggested status), the synthetic example ticket, a quickstart that links to the guide, a short FAQ and the docs list.
* **docs/getting-started.md**, new, the Hello World guide: Linear's free workspace and a team, install, `bollplank init` including adding Draft, Ready and Acceptance in Linear's settings and init reading them back, creating the project from init, then a first ticket `ACME-1` through brief, critique, address and approve, with the commands to type in the client. About one page.
* **docs/existing-project.md**, new: point Bollplank at an existing team and project, map the five states to the statuses you have, a project in another team with its own mapping, rerunning init to change it, and what doctor says when a name is wrong. About half a page.
* **docs/setup.md, commands.md, config.md, runs.md, skills.md, same-model.md, windows.md**: trimmed to reference pages, roughly half their current length, every flag and failure still named once.
* **Removed:** `docs/parity.md` (copied to the ticket folder for Paul's private config repo) and `docs/plans/`. Every link to them goes.
* **No internal references:** the gate gains a docs check over the README, CONTRIBUTING, SECURITY, CHANGELOG, `docs/`, `skills/` and `prompts/`. It fails on a ticket key of the form `[A-Z]+-\d+` other than the synthetic `ACME-n`, and on `agent-workflow` or `aw-`. It skips `docs/plans/` so this plan can sit on the branch while the work runs. The shipping turn refuses to merge while `docs/plans/` exists on the branch. Code that reads the other kit's lock and marker (`lib/commands/turn.mjs`, `lib/commands/ledger.mjs`, `lib/ledger/`) and its tests are not docs and keep their names.

## 5. Version and changelog

`package.json` 0.2.0. CHANGELOG `## 0.2.0 (unreleased)` with the four changes in plain words, dated in the shipping turn as for 0.1.0.

## 6. Order of work

1. Statuses per project, with tests (config, context, doctor, init answers).
2. The critic on the board, with tests against the fake clients, then a real smoke run of each critic on a synthetic issue-less prompt that only reads `list_teams` and posts nothing, plus one real critique of this plan's next round if the plan gate is still open.
3. Board setup, with tests: the write call's allowed tools, refusal of any other tool, and the readback.
4. Docs, after 1 to 3 so they describe the code.
5. Gate, full tests, review, test and hunt subagents, Codex code rounds, then removal of `docs/plans/` as the last commit.

Steps 1 and 3 touch `init.mjs` both, so they run in order, not in parallel. Docs can start drafts in parallel with 2 and 3.

## 7. Acceptance cases

* A Claude and a Codex critic, faked, each call a Linear read and a comment tool and pass. A call to another server's tool, a shell call, or an MCP server that is not Linear fails as `critic-used-tools`.
* `posted` is true only after a successful comment call. The skill text says the lead posts the returned text when the comment is missing.
* `--instruction-file` text reaches the prompt under the approver line, and an empty one leaves `{INSTRUCTION}` empty.
* No Linear server in the critic's client fails as `critic-unavailable` before any model turn.
* Two projects in different teams with different status names validate, `context` returns each project's own mapping, and doctor checks each against its own team.
* A project with no mapping of its own uses the top level one, and with none at all, Linear's suggestion.
* Init with an answers file creates a missing project only on `createProject` yes, allows only the create project tool, and reads it back. A no leaves Linear untouched.
* The hook denies `save_project` with an `id`, with another name, with another team or a second team, and a second create, and allows exactly the confirmed create. A fake Claude that tries an update first never gets it run.
* A critic that never read the issue, or whose read failed, fails as `board-unreachable` and the round count stays. A critic that read the subject but whose post failed returns `posted: false` and counts.
* A reported model that differs from the pinned one comes back as `modelCorrection` and in the returned header.
* The docs check fails on a real ticket key and on `aw-` in docs, and passes on `ACME-1`.
* The gate passes, every test passes, and `bollplank version` reports 0.2.0.
