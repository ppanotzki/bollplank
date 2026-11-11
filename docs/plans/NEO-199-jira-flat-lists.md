# NEO-199 plan: flat lists on Jira

Status: v1, 2026-11-11. Brief v1, approved.

1. `lib/commands/critic.mjs`, `replyOnly`: add one sentence asking the Jira critic for flat text, no nested list and no indented line under a list item, with a point that needs more continuing as plain sentences in the same item or as its own numbered point. Linear prompts are untouched.
2. `skills/bollplank-board/references/jira.md`: a paragraph saying every description and comment written to Jira uses flat lists, and why. The Release notes row says `updateConfluenceContent` needs `getContentFormatGuide` and a `snapshotToken` from a draft read with `getConfluenceContent`.
3. Tests in `test/critic.test.mjs`: the Jira reply only prompt asks for flat lists, the Linear prompt does not.
4. CHANGELOG 0.7.0 entry.
5. Gate, Codex code round, PR, ship, then a live Claude round on a BPT issue confirmed without a decision from Paul.
