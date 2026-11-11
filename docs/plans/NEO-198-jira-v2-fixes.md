# NEO-198 plan: Jira fixes from the NEO-197 live test

Status: v1, 2026-11-11. Brief v3, approved.

## Steps

1. **Jira text rules, `lib/jira-text.mjs`.** One module for what Jira's markdown does to text:
   - `jiraCanonical(text)`: CRLF and CR to LF, trailing spaces and tabs off each line, a leading `*`, `+` or `-` list marker followed by a space becomes `- ` (indent kept), trailing newlines off. Nothing else.
   - `htmlUnsupported(html)`: the tags and attributes in an HTML description that markdown does not round trip. Allowed tags: `p`, `br`, `h1` to `h6`, `ul`, `ol`, `li`, `pre`, `code`, `blockquote`, `hr`, `strong`, `em`, `a`. Allowed attributes: `href` on `a`, `class="language-<name>"` on `code`, `data-unique-id` on `pre`, `start` on `ol`. Any `data-type` is reported by its value, such as `panel-info`. Table tags are reported as `table`. Any other tag by its name, any other attribute as `<tag> <attr>`, an HTML comment as `comment`. Each once, in the order met.
2. **`board safe-write jira --html <file>`** in `lib/commands/board.mjs`. The file is the raw `getJiraIssue` result or the description string. From a JSON result it takes the issue's `fields.description` and refuses a result whose `appliedContentFormat` is not `html`. An empty or missing description passes. `--adf` stays as it is, and exactly one of the two is given.
3. **`board compare jira --sent <file> --got <file>`** in the same command. Exits 0 when both canonical texts are equal, else fails `differs` with the first differing line number and both lines, cut to 200 characters.
4. **Claude critic tools,** `lib/providers/claude.mjs`. `JIRA_CRITIC_DENIED` gains the v2 reads `getCollaborators`, `getGraphContext`, `getGraphObject`, `getLoomObjectsContent`, `getPeopleInfo`, `getWorkActivity`, `getWorkPortfolio`, `search`. In `toolsUsed`, on Jira only, an offered tool of the board server that is not allowed is not counted as extra when its name starts with a read verb. A call to it still fails the round.
5. **The critic reads the brief,** `lib/commands/critic.mjs`. `replyOnly` asks for `fields: ["description"]`, `fieldsByKeys: true` and markdown. `jiraWork` counts a `getJiraIssue` read only when its result holds the description, or the call asked for the description by key, since the server leaves out an empty one.
6. **Baseline compare,** `lib/configuration-run.mjs`. On Jira, `readBaseline` compares `jiraCanonical` of both texts. Linear keeps `trimEnd`.
7. **init sign ins.** Claude `addBoardMcp` takes `tty`, default `process.stdin.isTTY`. Without a terminal it adds the server, skips the login and names `claude mcp login <name>`. Codex `addBoardMcp` tells a timed out `codex mcp add` apart, checks whether the server is there now, and names `codex mcp login <name>`. Both say to run `bollplank init` again.
8. **Skills and docs.** jira.md: read the description as HTML for safe-write, `fields`, compare for every readback, release notes by `listConfluenceContent`, `getContentFormatGuide`, the Done time. The critique skill: on Jira, the compare replaces the exact match in the post and recovery steps, and confirm takes the pending file. docs/commands.md, SECURITY.md and the 0.7.0 CHANGELOG entry.
9. **Tests.** `test/board.test.mjs` for the HTML check and the compare, with the BPT-1 and BPT-2 shapes as synthetic fixtures. Critic tests for the offered read tool rule and the description evidence. A configuration run test on Jira with hard breaks. Setup tests for the tty and timeout messages.

## Gates

`node scripts/check.mjs` on the Mac, then the `checks` workflow on Ubuntu and Windows with Node 20 and 22.
