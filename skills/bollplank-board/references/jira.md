# Jira

Jira arrives through Atlassian's official remote MCP server. Its URL is `https://mcp.atlassian.com/v2/mcp`. The earlier `https://mcp.atlassian.com/v1/mcp` still works. Each client names the tools differently, for example `getJiraIssue`, `mcp__atlassian__getJiraIssue` or `atlassian.getJiraIssue`. Find each tool by its name in the tools this session has. Load deferred tools before calling them. If no tool can do an operation, stop and say which one is missing.

The server shows a few tools directly, such as `getJiraIssue`, `createJiraIssue`, `editJiraIssue`, `transitionJiraIssue`, `addOrEditJiraIssueComment`, `searchJiraIssuesUsingJql` and the Confluence tools. On the v2 server `listJiraIssueComments` is a direct tool too. Every other tool, such as `listJiraIssueTransitions`, `getConfluenceSpace` and `listConfluenceContent`, runs through `executeRead`, which names the inner tool in its arguments.

Every call takes a `cloudId`. `getAccessibleAtlassianResources` lists the cloud id of each site. Use the one for the project's site, the `board.team` of `bollplank context <project>`, such as `acme.atlassian.net`.

Read Jira text with `responseContentFormat: "markdown"` and write it with `contentFormat: "markdown"`. Send markdown with real newlines, never escaped `\n`. The only other format is `"html"`, which is lossless. A markdown read of text that markdown cannot represent, such as a panel, a status or a mention, comes back as HTML with a warning, and `appliedContentFormat` in the result says which format you got.

`getJiraIssue` leaves the description out of its default view. Pass `fields: ["description"]` and `fieldsByKeys: true` whenever you need it. An empty description is left out even then.

Write every description and comment on Jira with flat lists: no nested list, and no indented line under a list item. Jira re-indents those when it stores them, so their readback never matches. A subpoint becomes its own numbered item or plain sentences in the same item.

Jira changes markdown on the way back: every single newline comes back as two trailing spaces and a newline, `- ` bullets come back as `* `, and a trailing newline is added. So a readback is never compared byte for byte. Save what you sent and what Jira returned to two files in your scratch space, unchanged, and run `bollplank board compare jira --sent <file> --got <file>`. It allows only those rewrites, and no bullet change inside a fenced code block. Exit 0 is a match. Otherwise it names the first line that differs. Then stop and tell the approver. Never edit either text to make them match.

Source: https://support.atlassian.com/atlassian-rovo-mcp-server/docs/supported-tools/ and https://github.com/atlassian/atlassian-mcp-server, read on 10 November 2026, and the tools' own schemas and live calls on the v2 server on 11 November 2026.

## Operations

| Operation | The Jira tool | Notes |
|---|---|---|
| Read the issue | `getJiraIssue` with `responseContentFormat: "markdown"`, and `fields` with `description` and the other fields you need, with `fieldsByKeys: true` | Keep its key, id, project, status, created time and resolution time. Never count the comments in this result as all of them. When the result has no resolution time after Done, the Done time is the time of the "Accepted" comment. |
| Read the comments | `listJiraIssueComments`, directly or through `executeRead`, in markdown | Read every page, until a page says `isLast: true` or the pages reach `total`. Order by created time. Keep each comment's id and link. |
| Create the issue | `createJiraIssue` in the project key | The project key is `board.project` of `bollplank context <project>`. Then set the draft status as below. |
| Write the description | `getJiraIssue`, `bollplank board safe-write jira`, then `editJiraIssue` | First read the description with `responseContentFormat: "html"`, `fields: ["description"]` and `fieldsByKeys: true`, and save the whole result unchanged to a file in your scratch space. Run `bollplank board safe-write jira --html <file>`. It exits 0 only when everything in it is something markdown round trips. A result with no description field fails as `no-description`, since it shows nothing about the description. The server also leaves out an empty description, so read again with `fields: ["description"]` and `fieldsByKeys: true`. If it is still missing, the description is empty: tell the approver and write only on their word. The one exception is the first write onto an issue you created with no description, which needs no check. Otherwise it names what is in the way, such as `table`, `img`, `panel-info`, `status` or `mention`. Then stop, write nothing, and tell the approver what is in the way. On exit 0, send the whole description with `editJiraIssue` and `contentFormat: "markdown"`. Read it back as markdown and check it with `bollplank board compare jira`, as above. |
| Post a comment | `addOrEditJiraIssueComment` without a comment id | Then read the comments and find it by id. Check its text against what you sent with `bollplank board compare jira`, as above. Its link is the approval link and the like. |
| Update a comment | `addOrEditJiraIssueComment` with the comment's id | Used for the one "Ticket ledger" comment on a retry. Read it back and check it with `bollplank board compare jira`, as above. |
| Set a status | `executeRead` of `listJiraIssueTransitions`, then `transitionJiraIssue` | Find the transition whose target status name equals the configured name exactly and run it. If no transition reaches that status in one step, stop and say which statuses are reachable. Read the issue back. |
| Release notes | `executeRead` of `getConfluenceSpace` and of `listConfluenceContent`, `getConfluenceContent`, `createConfluenceContent` and `updateConfluenceContent` | Only when `board.space` is set in `bollplank context <project>`. Get the space's numeric id with `getConfluenceSpace`, then list the space's pages with `listConfluenceContent`, every page of the list, and find the one titled exactly "Release notes". Never decide that it is missing from a `searchConfluence` result, since search can miss a page for minutes after it is made. Create it in the space when the list has no such page. `createConfluenceContent` and `updateConfluenceContent` ask for `executeRead` of `getContentFormatGuide` first, and an update needs the `snapshotToken` from a draft read with `getConfluenceContent`. Otherwise read it and write it with the new section at the top. Read it back and check that the old content is still there unchanged after the new section. If it is not, stop and report. Without a space, say that release notes are only in the "Release note" comment and the CHANGELOG, and write nothing. |
| Find raised issues | `searchJiraIssuesUsingJql` | Search with `project = <KEY> AND text ~ "Raised by: <TICKET>"`, then read each hit and keep only those whose header line names this ticket. |

## Setup operations, only when the user asks

| Operation | The Jira tool | Notes |
|---|---|---|
| Check the statuses | `executeRead` of `listJiraStatuses` for the project | Compare each name from `board.statuses` exactly. Jira's MCP tools cannot create a status. For each missing one, give these steps: open the Jira project, go to Project settings, then Workflows, and add a status with that exact name in its category. The category follows the state the name is mapped to: draft and ready under To Do, inProgress and acceptance under In Progress, and done under Done. A new Jira project usually has To Do, In Progress and Done, so Draft, Ready and Acceptance are the ones to add. |

## Readback for consulting and configuration runs

Read the live issue with `getJiraIssue`, `responseContentFormat: "markdown"`, `fields: ["description"]` and `fieldsByKeys: true` immediately before `bollplank run init` or `bollplank run rebaseline`, and write a JSON file in the run's scratch space:

```
{
  "id": "ACME-1",
  "teamId": "<the site's cloud id>",
  "projectId": "<the issue's numeric project id>",
  "observedAt": "<ISO time of the read>",
  "description": "<the description exactly as Jira returned it in markdown>"
}
```

`id` is the issue key. On Jira, `teamId` is the cloud id of the site and `projectId` the numeric id of the Jira project. They must equal `project.board.teamId` and `project.board.projectId` from `bollplank context <project>`. Write both ids as strings, so the project id is `"10001"`, not `10001`. The helper compares them as text, so a number Jira returns still matches. Keep nothing else. The helper compares the description with the approved brief after Jira's markdown rewrites, as `board compare jira` does, so keep it exactly as Jira returned it. The helper refuses a readback older than 15 minutes, so read again rather than reuse an old file.

The approval reference for these runs is the link of the approval comment, read from the comments as above.
