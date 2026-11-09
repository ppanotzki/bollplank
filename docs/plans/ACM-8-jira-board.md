# ACM-8 plan: Jira as a second board kind

Status: v1
Brief: ACM-8 brief v4, approved by joxzaren on 2026-11-10.

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
  - Jira, Claude Code: allow rules name the tools one by one: `getJiraIssue`, `addOrEditJiraIssueComment`, `executeRead`. Everything else on the server is denied by name prefix, including `executeWrite`, `executeDestructive`, `discover` and every Confluence tool.
  - Jira, Codex: `enabled_tools` on the kept server is the same three tools.
  - Event checks in both: `executeRead` is allowed only when its inner tool is `listJiraIssueComments`. `addOrEditJiraIssueComment` is allowed only without a comment id, so the critic adds and never edits. Any other call fails the round as `critic-used-tools`, and the reply is not used.
- Fix texts come from `BOARDS[kind]`.

### Critic evidence (lib/commands/critic.mjs)

- `run` resolves the kind from `--project` with `kindOf`, and passes it to `review` and to the prompt as `{BOARD}`.
- `boardKind(tool, args, kind)`: per kind tables. Jira: `getJiraIssue` is the issue read. `executeRead` of `listJiraIssueComments` is the comments read. `getJiraIssue` with comments in its result also counts as the comments read. `addOrEditJiraIssueComment` is the post.
- `namesIssue` accepts `issueIdOrKey`. `resultIssue` accepts `key`. The posted text is read from `commentBody` or `body`.
- The existing post then fail path, which counts a posted critique once and does not post again on retry, works for Jira through the same `boardWork` result. A test proves it.

### Prompts

- `prompts/critic.md` and `critic-same.md` say "your {BOARD} tools". `{BOARD}` is added to the placeholder list in `scripts/check.mjs` and filled by the wrapper.

### init and doctor

- init: a new first question in step 3, `kind`, default `linear`. A project added with `askProject` gets `projects.<name>.kind`, default the top level kind. Step 2 probes the kinds that have been chosen. A Linear only setup gets exactly the questions it gets today, in the same order, so existing answer files keep working.
- Jira questions: site (from `getAccessibleAtlassianResources`), project key, statuses, optional Confluence space. The cloud id and project id are saved from the probe's tool results.
- New answer keys: `kind`, `projects.<name>.kind`, `addBoard.<kind>.<client>` (with `addLinear.<client>` still read), `space`, `projects.<name>.space`.
- doctor: probe every kind the config uses, with check ids `<kind>.<client>` and `<kind>`. `linear.*` ids stay as they are. Board checks group by kind, then team and project. For Jira they check site, project key, cloud id, project id, each status, and the space when set.

### Readback (lib/configuration-run.mjs, lib/commands/run.mjs)

- `BOARD_NAMES.jira = 'Jira'`. `run.mjs` passes the project's kind.
- The Jira readback has the same shape: `id` is the issue key, `teamId` the cloud id, `projectId` the numeric project id, and `description` the description as read with markdown format. Identity and exact text checks stay as they are.

### Skills and references

- `skills/bollplank-board/references/jira.md`, one row per operation:
  - Read the issue: `getJiraIssue` with `responseContentFormat: "markdown"` and the comment field.
  - Read the comments: `executeRead` of `listJiraIssueComments`, every page, markdown.
  - Create the issue: `createJiraIssue` in the project key, then transition to the draft status.
  - Write the description: `editJiraIssue` with `contentFormat: "markdown"`, then read back and compare exactly. If the text does not compare equal, stop and tell the approver. No normalising.
  - Post a comment: `addOrEditJiraIssueComment` without a comment id. Update a comment: the same tool with the id.
  - Set a status: `executeRead` of `listJiraIssueTransitions`, find the transition whose target status name equals the configured name, run `transitionJiraIssue`. If none reaches it in one step, stop and say which statuses are reachable.
  - Release notes: when `space` is set, `searchConfluence` for the title "Release notes" in the space, create it with `createConfluenceContent` when missing, or read it with `getConfluenceContent` and write it with `updateConfluenceContent`, new section on top. Read back and check that the old content is still there unchanged after the new section. If it is not, stop and report. Without a space, say that release notes are only in the comment and the CHANGELOG.
  - Find raised issues: `searchJiraIssuesUsingJql` with `project = <KEY> AND text ~ "Raised by: <TICKET>"`, then read each hit.
  - Readback: as above.
- `skills/bollplank-board/SKILL.md`: take the kind from `bollplank context <project>`, not from the top level. Remove "the only kind is linear".
- `skills/bollplank-accept/SKILL.md`: the release notes step follows the board reference, and skips with a sentence when the Jira project has no space.
- `skills/bollplank-critique/SKILL.md`: "no usable board server" instead of Linear.

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
6. (after 1) Skills, references and docs.
7. CHANGELOG, version, full gate.

Steps 2 and 3 both edit the provider files, so they run one after the other, not in parallel. Steps 5 and 6 run in parallel with them.

## Tests (fake programs only)

- Config: mixed kinds pass, a kind only override fails, same kind inheritance unchanged, site, key and space formats.
- Context: the resolved kind per project.
- Probe: a Jira read passes. `executeRead` of a Confluence tool fails. `executeWrite` fails. A server with a matching name but another URL is not used.
- doctor: a Linear and a Jira project together pass. A missing Jira status gives the Jira steps. An unreadable space fails.
- init: a Jira board from scratch. A Jira project added to a Linear config. An old Linear answer file still works unchanged.
- Critic: a full Jira round counts reads and the post. A post then client failure is counted once and not posted again. `executeRead` of a Confluence tool, `executeWrite`, and a comment edit each fail as `critic-used-tools`, in both clients. A Linear round is unchanged.
- Readback: a valid Jira baseline passes. The same key from another cloud id or project id is refused. A description that differs is refused.

## Risks for the run

- The markdown round trip on a real Jira site cannot be proven with fakes. The board reference stops on any mismatch, so a failure is visible, not silent. The approver checks it on a real site at acceptance.
- `executeRead` cannot be limited by inner tool in the Claude Code allow rules, only after the fact in the event check. A critic that calls a Confluence read through it has its round refused, the same rule as any other forbidden call today.
