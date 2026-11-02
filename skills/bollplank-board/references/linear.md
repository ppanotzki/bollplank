# Linear

Linear arrives through an MCP server, a connector or a plugin, and each client names its tools differently, for example `get_issue`, `mcp__linear__get_issue` or `linear.get_issue`. Find each tool by its Linear purpose in the tools this session has, not by a fixed name. Load deferred tools before calling them. If no tool can do an operation, stop and say which one is missing.

Send markdown with real newlines, never escaped `\n`.

## Operations

| Operation | The Linear tool that | Notes |
|---|---|---|
| Read the issue | gets one issue by its key, such as `ACME-1` | Keep its id, team, project, status, created time and Done time. |
| Read the comments | lists the comments of an issue | Read every page. Order by created time. Keep each comment's id and link. |
| Create the issue | saves or creates an issue | Team and project from the project's entry in `boards` of `bollplank context`, which falls back to the top level `board.team` and `board.project`. Start it in the draft status. |
| Write the description | saves or updates an issue, given its id | Send the whole description. Then read the issue again and compare the text. |
| Post a comment | saves or creates a comment on an issue | Then list the comments and find it by id. Its text must match what you sent. Its link is the approval link and the like. |
| Update a comment | saves a comment, given the comment's id | Used for the one "Ticket ledger" comment on a retry. |
| Set a status | lists the team's issue statuses, and saves an issue with a status | Find the status whose name equals the configured name exactly, then set it by its id. Read the issue back. |
| Release notes | lists or searches documents, gets a document, and saves or creates a document | Search the project's documents for the title "Release notes". Create it in the project when it is missing. Put the new section at the top and keep everything else unchanged. Read it back. |
| Find raised issues | lists or searches issues | Search the team for `Raised by: <TICKET>`, then read each hit and keep only those whose header line names this ticket. |

Linear's Releases feature is not used. It needs a paid plan and CI pipelines, and groups by deploy, not by ticket.

## Readback for consulting and configuration runs

Read the live issue immediately before `bollplank run init` or `bollplank run rebaseline`, and write a JSON file in the run's scratch space:

```
{
  "id": "ACME-1",
  "teamId": "<the issue's team id>",
  "projectId": "<the issue's project id>",
  "observedAt": "<ISO time of the read>",
  "description": "<the description exactly as Linear returned it>"
}
```

`id` is the ticket key. `teamId` and `projectId` must equal `project.board.teamId` and `project.board.projectId` from `bollplank context <project>`. Keep nothing else. The helper refuses a readback older than 15 minutes, so read again rather than reuse an old file.

The approval reference for these runs is the link of the approval comment, read from the comments as above.
