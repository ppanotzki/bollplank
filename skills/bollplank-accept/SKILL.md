---
name: bollplank-accept
description: Close a shipped or delivered ticket after the approver's acceptance test. Use when the approver says "accept" or "accept ACME-1" for a ticket in the acceptance status. Adds the release note, moves the issue to Done, posts the ticket ledger, and removes the ticket folder for repository runs.
---

# Accept a ticket

Only the approver accepts, in so many words ("accept", "accepted"). Take their name from `bollplank context <project>`. A failed test is not acceptance. It sends the ticket back to the in progress status under the same run grant.

## Steps

1. **Check.** Run `bollplank ledger mark <TICKET>` first, then `bollplank context <project>`. The issue is in the acceptance status, and `bollplank run show <project> <TICKET>` agrees: for a repository run every deploy succeeded, for a consulting or configuration run the record is complete. Otherwise say what is missing.
   Read the project's AGENTS.md from the latest base branch of the repo that holds it: `git -C <repo> fetch`, then `git -C <repo> show origin/<base branch>:AGENTS.md`. Never from a working tree, which can be behind and miss a line such as a further release note destination.
2. **Release note.** Make sure the run's "Release note" comment exists. Write it now if the run did not. Then add it to the project's "Release notes" document on the board (see bollplank-board), unless the project's AGENTS.md says release notes stay on the ticket:
   - a new section at the top, headed `## ACME-1 · <ticket title>`
   - a line `Accepted <date>.` followed by the builds this ticket itself deployed, from the run record or the run report, for example `acme-api build 248, acme-web build 270.` Name a component the ticket did not deploy as unchanged, never as the build that happens to be live.
   - the note text.

   If the section for this ticket is already there (a retry), confirm it instead of adding a second one.
3. **Further destination.** If the project's AGENTS.md names a further release note destination, publish the note there as it says, with the builds this ticket deployed, then read it back. A failure or an unknown answer stops the accept here: the ticket stays in acceptance and its folder stays. A retry reads the destination first and confirms or finishes the note, never adding a second one.
4. **Done.** Move the issue to the done status, and post "Accepted by <approver> on <date>" with your Model line and the Workflow line from `bollplank version`.
5. **Ledger**, last, after Done:
   - Read from the board: the issue's created and Done times, the approval comment's time (the Approval line links it), and the raised issues, every issue whose brief header has a `Raised by:` line naming this ticket.
   - `bollplank ledger collect <TICKET> --created <iso> --approved <iso> --done <iso> --run <ticket folder> --raised <list> --title "<title>" --write --markdown` prints the comment and replaces the ticket's rollup entry.
   - Post it as the issue's one "Ticket ledger" comment, with your Model and Workflow lines under its title when the printed text has none. If one exists (a retry), update that comment instead of adding a second.
   - "rollup" from the approver means `bollplank ledger rollup`, shown as it prints.
6. **Clean up.**
   - Repository run: `bollplank ticket remove <project> <TICKET>`. It refuses when anything could be lost, such as uncommitted changes or commits after the merged head. Report a refusal to the approver, and never force it.
   - Consulting or configuration run: keep the run folder, as their references say.
