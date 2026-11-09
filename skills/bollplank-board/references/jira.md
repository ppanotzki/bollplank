# Jira

Jira arrives through Atlassian's official remote MCP server. Its URL is `https://mcp.atlassian.com/v2/mcp`. The earlier `https://mcp.atlassian.com/v1/mcp` still works. Each client names the tools differently, for example `getJiraIssue`, `mcp__atlassian__getJiraIssue` or `atlassian.getJiraIssue`. Find each tool by its name in the tools this session has. Load deferred tools before calling them. If no tool can do an operation, stop and say which one is missing.

The server shows a few tools directly, such as `getJiraIssue`, `createJiraIssue`, `editJiraIssue`, `transitionJiraIssue`, `addOrEditJiraIssueComment`, `searchJiraIssuesUsingJql` and the Confluence tools. Every other tool, such as `listJiraIssueComments` and `listJiraIssueTransitions`, runs through `executeRead`, which names the inner tool in its arguments.

Every call takes a `cloudId`. `getAccessibleAtlassianResources` lists the cloud id of each site. Use the one for the project's site, the `board.team` of `bollplank context <project>`, such as `acme.atlassian.net`.

Read Jira text with `responseContentFormat: "markdown"` and write it with `contentFormat: "markdown"`. Send markdown with real newlines, never escaped `\n`.

Source: https://support.atlassian.com/atlassian-rovo-mcp-server/docs/supported-tools/ and https://github.com/atlassian/atlassian-mcp-server, read on 10 November 2026. The markdown formats come from third party docs and a community report, not an Atlassian page.

## Operations

| Operation | The Jira tool | Notes |
|---|---|---|
| Read the issue | `getJiraIssue` with `responseContentFormat: "markdown"` and the comment field | Keep its key, id, project, status, created time and resolution time. Never count the comments in this result as all of them. |
| Read the comments | `executeRead` of `listJiraIssueComments`, in markdown | Read every page, until a page says `isLast: true` or the pages reach `total`. Order by created time. Keep each comment's id and link. |
| Create the issue | `createJiraIssue` in the project key | The project key is `board.project` of `bollplank context <project>`. Then set the draft status as below. |
| Write the description | `getJiraIssue`, `bollplank board safe-write jira`, then `editJiraIssue` | First read the description with `responseContentFormat: "adf"` and save it to a file in your scratch space. Run `bollplank board safe-write jira --adf <file>`. It exits 0 only when every node is one that markdown round trips. Otherwise it names the node types, such as media, mention, panel, table or status. Then stop, write nothing, and tell the approver which types are in the way. On exit 0, send the whole description with `editJiraIssue` and `contentFormat: "markdown"`. Read it back as markdown and compare it exactly with what you sent. If it differs, stop and tell the approver. Never normalise either text to make them match. |
| Post a comment | `addOrEditJiraIssueComment` without a comment id | Then read the comments and find it by id. Its text must match what you sent. Its link is the approval link and the like. |
| Update a comment | `addOrEditJiraIssueComment` with the comment's id | Used for the one "Ticket ledger" comment on a retry. Read it back. |
| Set a status | `executeRead` of `listJiraIssueTransitions`, then `transitionJiraIssue` | Find the transition whose target status name equals the configured name exactly and run it. If no transition reaches that status in one step, stop and say which statuses are reachable. Read the issue back. |
| Release notes | `searchConfluence`, `getConfluenceContent`, `createConfluenceContent` and `updateConfluenceContent` | Only when `board.space` is set in `bollplank context <project>`. Search the space for the title "Release notes". Create it in the space when it is missing. Otherwise read it and write it with the new section at the top. Read it back and check that the old content is still there unchanged after the new section. If it is not, stop and report. Without a space, say that release notes are only in the "Release note" comment and the CHANGELOG, and write nothing. |
| Find raised issues | `searchJiraIssuesUsingJql` | Search with `project = <KEY> AND text ~ "Raised by: <TICKET>"`, then read each hit and keep only those whose header line names this ticket. |

## Setup operations, only when the user asks

| Operation | The Jira tool | Notes |
|---|---|---|
| Check the statuses | `executeRead` of `listJiraStatuses` for the project | Compare each name from `board.statuses` exactly. Jira's MCP tools cannot create a status. For each missing one, give these steps: open the Jira project, go to Project settings, then Workflows, and add a status with that exact name in its category. The category follows the state the name is mapped to: draft and ready under To Do, inProgress and acceptance under In Progress, and done under Done. A new Jira project usually has To Do, In Progress and Done, so Draft, Ready and Acceptance are the ones to add. |

## Readback for consulting and configuration runs

Read the live issue with `getJiraIssue` and `responseContentFormat: "markdown"` immediately before `bollplank run init` or `bollplank run rebaseline`, and write a JSON file in the run's scratch space:

```
{
  "id": "ACME-1",
  "teamId": "<the site's cloud id>",
  "projectId": "<the issue's numeric project id>",
  "observedAt": "<ISO time of the read>",
  "description": "<the description exactly as Jira returned it in markdown>"
}
```

`id` is the issue key. On Jira, `teamId` is the cloud id of the site and `projectId` the numeric id of the Jira project. They must equal `project.board.teamId` and `project.board.projectId` from `bollplank context <project>`. Keep nothing else. The helper refuses a readback older than 15 minutes, so read again rather than reuse an old file.

The approval reference for these runs is the link of the approval comment, read from the comments as above.
