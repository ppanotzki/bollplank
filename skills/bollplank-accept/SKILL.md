---
name: bollplank-accept
description: Close a shipped or delivered ticket after the approver's acceptance test. Use when the approver says "accept" or "accept ACME-1" for a ticket in the acceptance status. Adds the release note, moves the issue to Done, posts the ticket ledger, and removes the ticket folder for repository runs.
---

# Accept a ticket

Only the approver accepts, in so many words ("accept", "accepted"). Take their name from `bollplank context <project>`. A failed test is not acceptance. It sends the ticket back to the in progress status under the same run grant.

## Steps

1. **Check.** Run `bollplank ledger mark <TICKET>` first, then `bollplank context <project>`. The issue is in the acceptance status, and the run record agrees: for a repository run `bollplank run check-shipped <project> <TICKET>` exits 0, so every repo the ticket changes is merged and deployed with status `succeeded`, and for a consulting or configuration run `bollplank run show <project> <TICKET>` shows the record complete. Otherwise say what is missing.
   Read the project's AGENTS.md fresh now, never a copy from earlier in the session, the run folder or the brief:
   - Repository project: from the latest base branch of the repo that holds it: `git -C <repo> fetch`, then `git -C <repo> show origin/<base branch>:AGENTS.md`. Never from a working tree, which can be behind and miss a line such as a further release note destination.
   - Consulting or configuration project: it is `<source>/AGENTS.md`, with the source from `bollplank context <project>`, the same file the run read. If the source folder is inside a Git work tree, fetch and read it from the latest base branch at its path in that repo. Otherwise read the file from disk. An AGENTS.md in a nested repo under the source, such as `<source>/repos/acme-api/AGENTS.md`, is that repo's own, never the project's.

   For a plain folder, the file must resolve inside the source folder. A missing, empty or unreadable file stops the accept before any board write, and the ticket stays in acceptance.

   For a consulting or configuration run, compare the sha256 of the file you read with `agents.sha256` in `bollplank run show <project> <TICKET>`:
   - Equal: carry on.
   - Different: show the approver the difference between the run's copy at `agents.path` and the file you read, and ask before any board write. Then use the file you read, since it holds the current rules. In a Git source this also shows a run that used local changes not on the base branch.
   - `agents` is null: the run recorded no profile. Say so and carry on with the file you read.
2. **Release note.** Make sure the run's "Release note" comment exists. Write it now if the run did not. Then add it to the project's "Release notes" document on the board (see bollplank-board), unless the project's AGENTS.md says release notes stay on the ticket:
   - a new section at the top, headed `## ACME-1 · <ticket title>`
   - a line `Accepted <date>.` followed by the builds this ticket itself deployed, from the run record or the run report, for example `acme-api build 248, acme-web build 270.` Name a component the ticket did not deploy as unchanged, never as the build that happens to be live.
   - the note text.

   If the section for this ticket is already there (a retry), confirm it instead of adding a second one.
3. **Further destination.** If the project's AGENTS.md names a further release note destination, publish the note there as it says, with the builds this ticket deployed, then read it back. A failure or an unknown answer stops the accept here: the ticket stays in acceptance and its folder stays. A retry reads the destination first and confirms or finishes the note, never adding a second one.
4. **Done.** Move the issue to the done status, and post "Accepted by <approver> on <date>" with your Model line and the Workflow line from `bollplank version`. For a consulting or configuration project, add a line naming the AGENTS.md read in step 1: its path, sha256 and last modified time.
5. **Ledger**, last, after Done:
   - Read from the board: the issue's created and Done times, the approval comment's time (the Approval line links it), and the raised issues, every issue whose brief header has a `Raised by:` line naming this ticket.
   - `bollplank ledger collect <TICKET> --created <iso> --approved <iso> --done <iso> --run <ticket folder> --raised <list> --title "<title>" --write --markdown` prints the comment and replaces the ticket's rollup entry.
   - Post it as the issue's one "Ticket ledger" comment, with your Model and Workflow lines under its title when the printed text has none. If one exists (a retry), update that comment instead of adding a second.
   - "rollup" from the approver means `bollplank ledger rollup`, shown as it prints.
6. **Clean up.**
   - Repository run: `bollplank ticket remove <project> <TICKET>`. It refuses when anything could be lost: uncommitted or untracked changes, ignored files other than `node_modules` and the repo's `disposable` paths, or commits on the worktree or the ticket branch after the merged head. Disposable paths need no question, and the output names them. Report a refusal to the approver. Pass `--force-ignored` only when the approver says the ignored files it lists may be deleted. Nothing else forces a removal.
   - Consulting or configuration run: keep the run folder, as their references say.
