# ACM-8 plan: Jira as a second board kind

Status: v3
Brief: ACM-8 brief v4, approved by joxzaren on 2026-11-10.

Approver decision during the run, 2026-11-10: on a Jira board the critic is reply only. It gets read tools only, replies with its critique, and the lead posts that text unchanged. Neither client can limit `addOrEditJiraIssueComment` to adding before the tool runs, since the critic's hooks are switched off on purpose. This replaces the brief's "add a comment" in the critic's Jira tool list, and the brief's post then fail test applies to Linear only.

## Facts from Atlassian, read on 10 November 2026

From https://support.atlassian.com/atlassian-rovo-mcp-server/docs/supported-tools/ and https://github.com/atlassian/atlassian-mcp-server.

- The official server is `https://mcp.atlassian.com/v2/mcp`. `https://mcp.atlassian.com/v1/mcp` still works and serves v2 tools from 1 March 2027. Add commands: `claude mcp add --transport http atlassian https://mcp.atlassian.com/v2/mcp` and `codex mcp add atlassian --url https://mcp.atlassian.com/v2/mcp`. Sign in is OAuth in a browser.
- v2 shows a few Primary tools directly: `getAccessibleAtlassianResources`, `atlassianUserInfo`, `getJiraIssue`, `createJiraIssue`, `editJiraIssue`, `transitionJiraIssue`, `addOrEditJiraIssueComment`, `searchJiraIssuesUsingJql`, `getConfluenceContent`, `createConfluenceContent`, `updateConfluenceContent`, `searchConfluence`, plus `discover`, `executeRead`, `executeWrite` and `executeDestructive`. Every other tool, such as `listJiraIssueComments`, `listJiraProjects`, `listJiraStatuses`, `listJiraIssueTransitions` and `getConfluenceSpace`, runs through `executeRead` or `executeWrite`, which name the inner tool in their arguments.
- Every call takes a `cloudId`, which `getAccessibleAtlassianResources` lists per site.
- Jira text is read with `responseContentFormat: "markdown"` and written with `contentFormat: "markdown"`. This comes from third party docs and a community report, not an Atlassian page. The report says embedded media in a description is dropped on write.

## Design

### Kinds and config (lib/boards.mjs, lib/config.mjs, lib/commands/context.mjs, schema)

- `BOARDS.jira`: label `Jira`, suggested statuses `Draft`, `Ready`, `In Progress`, `Acceptance`, `Done`, and `newTeam` `To Do`, `In Progress`, `Done`. Add `server: { urls: [v2, v1] }` and `fix` text per client, so callers stop hard coding Linear.
- New helper `kindOf(config, projectName)`: the project's `board.kind`, else the top level `board.kind`.
- `validate` accepts any key of `BOARDS` at the top level and in a project's `board`. A project whose kind differs from the top level must set its own `team`, `project` and all five statuses, or validation fails with that message. For a Jira board, `team` must look like a site host (`<name>.atlassian.net`) and `project` like a project key (upper case letters and digits). `space` is allowed only on a Jira board and must look like a space key.
- `withDefaults`: a project of the top level kind keeps today's inheritance. A project of another kind gets no team, project or statuses from the top level.
- `statusKeyOf`: a different kind counts as a different board.
- `context`: `board.kind` and each `boards` entry carry the resolved kind, and `space` when set.
- Consulting and configuration projects keep requiring `teamId` and `projectId`. On Jira they mean the cloud id and the numeric project id.

### Probe (lib/setup/probe.mjs)

- Split the Linear specifics into a per kind table: URL, prompt, read predicate, allowed read tools, result reader and status steps. Linear keeps its exports as aliases so nothing else moves in this ticket.
- Jira probe prompt: call `getAccessibleAtlassianResources`, then through `executeRead` `listJiraProjects` and `listJiraStatuses` for the configured project, and `getConfluenceSpace` when a space is given. Reply `{"sites":[{"site","cloudId","projects":[{"key","id","statuses":[...]}]}],"space":...}`.
- `isJiraRead(call)`: the server is the official one, and the tool is `getAccessibleAtlassianResources`, `atlassianUserInfo`, `getJiraIssue`, or `executeRead` whose inner tool is on a named Jira read list (plus `getConfluenceSpace` when a space is configured). Anything else fails the probe, including any `executeWrite`, `executeDestructive` and Confluence write.
- The reader keeps only names that came back from a tool result, as for Linear.
- Jira status steps: open the Jira project, Project settings, Workflows, add the status in the named category (To Do for draft and ready, In Progress for in progress and acceptance, Done for done).

### Providers (lib/providers/claude.mjs, lib/providers/codex.mjs)

- Board server match by kind. For Jira the server is the official one only when its URL is one of the official URLs. A server is never matched by name alone. A claude.ai Atlassian connector counts only if Claude Code reports that same URL.
- `probeLinear` becomes `probeBoard(kind)`, with `probeLinear` kept as a wrapper. `WRITE_VERBS` gains `edit`, `transition` and `execute` for the deny rules, and `executeRead` is the one execute tool the Jira probe allows.
- `addLinearMcp` becomes `addBoardMcp(kind)` with a wrapper.
- `review({ board })`: the critic keeps the board's server only.
  - Linear: unchanged.
  - Jira, Claude Code: allow rules name the tools one by one: `getJiraIssue` and `executeRead`. Everything else on the server is denied by name, including `addOrEditJiraIssueComment`, `executeWrite`, `executeDestructive`, `discover` and every Confluence tool. The critic has no write tool at all.
  - Jira, Codex: `enabled_tools` on the kept server is the same two tools, and the kept server does not get `default_tools_approval_mode="approve"`, so any write would be refused by `approval_policy="never"` as well.
  - Event checks in both: `executeRead` is allowed only when its inner tool is `listJiraIssueComments`. Any other call fails the round as `critic-used-tools`, and the reply is not used.
  - Reply only: on Jira the wrapper expects no post. The critic prompt for Jira says to reply with the critique and not to post it. `review` returns the reply text with `posted: false` and a new field `delivery: "reply"`. The existing `mode` field keeps meaning other, same or named. Linear results get `delivery: "posted"`.
  - Pending round: a well formed Jira reply does not advance the wrapper's round count. The wrapper stores it in its state as `pending: { subject, round, sha256, at }` and returns `pending: true`.
  - Confirm: after the lead posts the text unchanged and reads it back, it runs `bollplank critic confirm --ticket <T> --subject <s> --round <n> --text-file <file> --comment <link>`. The text's sha256 must equal the pending one, the subject and round must match, or it fails and nothing changes. On success the round is counted, as a posted round is today, and `pending` is cleared.
  - A new critic call while a round is pending fails with `post-pending`, naming the round, before any client starts.
  - Recovery after an interrupted post or confirm: the critique skill first lists the comments and looks for one whose body equals the pending text exactly. If one is there, it confirms with that comment and posts nothing. Only when none is there does it post. So a retry never posts the same critique twice.
- Fix texts come from `BOARDS[kind]`.

### Critic evidence (lib/commands/critic.mjs)

- `run` resolves the kind from `--project` with `kindOf`, and passes it to `review` and to the prompt as `{BOARD}`.
- `boardKind(tool, args, kind)`: per kind tables. Jira: `getJiraIssue` is the issue read. `executeRead` of `listJiraIssueComments` is the comments read. Comments embedded in a `getJiraIssue` result never count, since they may be one page only.
- Every comment is read: on Jira the comments read counts only when the pages seen cover the whole list without gaps. Pages are those `listJiraIssueComments` results that name this issue and the project's cloud id. Sorted by `startAt`, the first starts at 0, each next one starts where the one before ended (`startAt` plus the comments it returned), and the last says `isLast: true` or ends at `total`. Otherwise the round is `board-unreachable`.
- `namesIssue` accepts `issueIdOrKey`. `resultIssue` accepts `key`.
- No post is looked for on Jira. The existing post then fail path stays for Linear and is unchanged.

### Prompts

- `prompts/critic.md` and `critic-same.md` say "your {BOARD} tools". `{BOARD}` is added to the placeholder list in `scripts/check.mjs` and filled by the wrapper.

### init and doctor

- init sequence:
  1. Step 2 opens with the question `kind`, default `linear`. An answer file without `kind` gets `linear`, so it runs exactly as today.
  2. Step 2 then probes that kind only. A Jira setup never probes Linear.
  3. Step 3 asks that kind's questions. Linear: team, project, statuses as today. Jira: site (from `getAccessibleAtlassianResources`), project key, statuses, then the optional space.
  4. After a Jira project or space is chosen, init reads that project's statuses and the space again with the same read only probe, as it does today for a late Linear project.
  5. `askProject` asks `projects.<name>.kind`, default the top level kind. When that kind has not been probed in this init run, init probes it then, offering to add its MCP server, and caches the result per kind. A Linear project added to a Jira setup works the same way.
- The cloud id and project id are saved from the probe's tool results, never typed.
- New answer keys: `kind`, `projects.<name>.kind`, `addBoard.<kind>.<client>` (with `addLinear.<client>` still read), `space`, `projects.<name>.space`.
- doctor: probe every kind the config uses, with check ids `<kind>.<client>` and `<kind>`. `linear.*` ids stay as they are. Board checks group by kind, then team and project. For Jira they check site, project key, cloud id, project id, each status, and the space when set.

### Readback (lib/configuration-run.mjs, lib/commands/run.mjs)

- `BOARD_NAMES.jira = 'Jira'`. `run.mjs` passes the project's kind.
- The Jira readback has the same shape: `id` is the issue key, `teamId` the cloud id, `projectId` the numeric project id, and `description` the description as read with markdown format. Identity and exact text checks stay as they are.

### Safe write helper (new, lib/commands/board.mjs)

- `bollplank board safe-write jira --adf <file>`: reads an ADF document and lists any node or mark type outside the round trip list above. JSON result `{ok, unsupported: [...]}`. Exit 0 only when the list is empty, and also for an empty or missing description. A file that is not ADF fails. It never touches the network.

### Skills and references

- `skills/bollplank-board/references/jira.md`, one row per operation:
  - Read the issue: `getJiraIssue` with `responseContentFormat: "markdown"` and the comment field.
  - Read the comments: `executeRead` of `listJiraIssueComments`, every page, markdown.
  - Create the issue: `createJiraIssue` in the project key, then transition to the draft status.
  - Write the description: first read the description as ADF with `responseContentFormat: "adf"`, save it to a file, and run `bollplank board safe-write jira --adf <file>`. It exits 0 only when every ADF node is one that markdown round trips (doc, paragraph, text with strong, em, code and link marks, heading, bulletList, orderedList, listItem, codeBlock, rule, hardBreak, blockquote). Any other node, such as media, mention, panel, table or status, makes it exit non zero with the node types, and the skill stops and tells the approver without writing. Then `editJiraIssue` with `contentFormat: "markdown"`, read back as markdown and compare exactly. If it differs, stop and tell the approver. No normalising.
  - Post a comment: `addOrEditJiraIssueComment` without a comment id. Update a comment: the same tool with the id.
  - Set a status: `executeRead` of `listJiraIssueTransitions`, find the transition whose target status name equals the configured name, run `transitionJiraIssue`. If none reaches it in one step, stop and say which statuses are reachable.
  - Release notes: when `space` is set, `searchConfluence` for the title "Release notes" in the space, create it with `createConfluenceContent` when missing, or read it with `getConfluenceContent` and write it with `updateConfluenceContent`, new section on top. Read back and check that the old content is still there unchanged after the new section. If it is not, stop and report. Without a space, say that release notes are only in the comment and the CHANGELOG.
  - Find raised issues: `searchJiraIssuesUsingJql` with `project = <KEY> AND text ~ "Raised by: <TICKET>"`, then read each hit.
  - Readback: as above.
- `skills/bollplank-board/SKILL.md`: take the kind from `bollplank context <project>`, not from the top level. Remove "the only kind is linear".
- `skills/bollplank-accept/SKILL.md`: the release notes step follows the board reference, and skips with a sentence when the Jira project has no space.
- `skills/bollplank-critique/SKILL.md`: "no usable board server" instead of Linear, and the Jira reply only step: when the result has `delivery: "reply"`, look for an existing comment with exactly that text, post it unchanged only when there is none, read it back, then run `bollplank critic confirm`. On `post-pending`, do the same recovery before a new call.

### Docs and release

- README, docs/setup.md, docs/config.md, docs/getting-started.md, docs/commands.md, docs/existing-project.md, docs/skills.md and SECURITY.md describe Jira beside Linear, the per project kind, the space, and the Jira probe and critic limits. Examples use ACME and ACM keys only, for the docs check.
- `examples/config.example.json` stays Linear. A Jira project example goes in docs/config.md.
- CHANGELOG section and the version goes from 0.6.0 to 0.7.0.

## Steps

The steps that can run on their own after step 1 are marked.

1. Kinds and config: boards.mjs, config.mjs, context.mjs, schema, `kindOf`, with core and config tests. Everything else depends on this.
2. (after 1) Probe and providers: probe.mjs, claude.mjs, codex.mjs probe and add paths, with init and doctor fakes for Jira.
3. (after 1) Critic: providers' `review`, critic.mjs, prompts, check.mjs placeholder, with Jira fakes in critic.test.mjs. Touches the providers' review path only, not the probe path in step 2.
4. (after 2) init and doctor with their tests.
5. (after 1) Readback: configuration-run.mjs, run.mjs, with tests.
6. (after 1) Skills, references, docs, and the safe write helper with its tests.
7. CHANGELOG, version, full gate.

Steps 2 and 3 both edit the provider files, so they run one after the other, not in parallel. Steps 5 and 6 run in parallel with them.

## Tests (fake programs only)

- Config: mixed kinds pass, a kind only override fails, same kind inheritance unchanged, site, key and space formats.
- Context: the resolved kind per project.
- Probe: a Jira read passes. `executeRead` of a Confluence tool fails. `executeWrite` fails. A server with a matching name but another URL is not used.
- doctor: a Linear and a Jira project together pass. A missing Jira status gives the Jira steps. An unreadable space fails.
- init: a Jira board from scratch. A Jira project added to a Linear config. An old Linear answer file still works unchanged.
- Critic: a full Jira round counts its reads and returns the reply with `mode: "reply"` and no post. A call to `addOrEditJiraIssueComment` never reaches the fake server in either client, since it is not offered. `executeRead` of a Confluence tool and `executeWrite` each fail as `critic-used-tools`, in both clients. Comments embedded in `getJiraIssue` alone, a comments read that stops before the last page, a read of only the final page, a read that skips a middle page, and pages for another issue or cloud id each fail as `board-unreachable`. An empty comments list with `isLast: true` passes.
- Pending round: a Jira reply leaves the round pending and not counted. A new call fails with `post-pending` before any client starts. Confirm with the wrong text, subject or round fails and changes nothing. Confirm with the right text counts the round, and the next call runs the next round. A post with no confirm, then recovery that finds the comment, confirms without a second post. A Linear round, including post then fail, is unchanged.
- Safe write: a plain brief in ADF passes. ADF with a media node, a mention, and a table each fail and name the node. Not ADF fails.
- init: an answer file without `kind` produces the same calls and config as today. A Jira setup never probes Linear. A Jira project added to a Linear config probes Jira at that point.
- Readback: a valid Jira baseline passes. The same key from another cloud id or project id is refused. A description that differs is refused.

## Risks for the run

- The markdown round trip on a real Jira site cannot be proven with fakes. The board reference stops on any mismatch, so a failure is visible, not silent. The approver checks it on a real site at acceptance.
- `executeRead` cannot be limited by inner tool in the Claude Code allow rules, only after the fact in the event check. It runs reads only, and the critic has no write tool on Jira, so a forbidden read can only be refused, never cause a change. A critic that calls a Confluence read through it has its round refused, the same rule as any other forbidden call today.
