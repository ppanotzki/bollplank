---
name: bollplank-approve
description: Record the approver's approval of a ticket's brief. Use only when the approver explicitly approves ("I approve", "approve brief v3", "approved"). Writes the approval comment, the Approval header line, the settled Cross-model review and Critic choices, and moves the issue to the ready status.
---

# Record an approval

Only the approver approves, and only in so many words. Run `bollplank context <project>` and take the approver's name from it. Anyone else's word, or "this looks good" and "we can try it", is not approval. If unsure, ask.

## Steps

1. **Mark.** Run `bollplank ledger mark <TICKET>` first, so this session's tokens count for the ticket in its ledger.
2. **Check the version.** The approval covers the brief version the approver named, or the current one. If they named an older version than the current one, ask before recording anything.
3. **Settle the choices.**
   - Cross-model review: if the approver named one ("with cross-model review: plan"), use it. Otherwise keep the brief's recommended value and say so in the comment.
   - Critic: if the approver named one ("critic: same"), use it and write the `Critic:` line. Otherwise keep the brief's line, or leave it out so the config default applies.
4. **Post the approval comment,** and read it back:
   ```
   Approval of brief v<N>
   Responsible: <your tool>
   Model: <your model>
   Workflow: <what `bollplank version` prints>

   <approver> approved brief v<N> in the <tool> session on <date> ("<their words>"). Cross-model review for this ticket is <value>. Critic is <value, or "the configured default">.
   ```
5. **Update the header:** `Approval: Approved by <approver> on <date> ([approval comment](<comment url>))`, `Cross-model review: <value>. <reason>`, and the `Critic:` line when one was settled. Write the link as that markdown link, since a board can wrap a bare URL in link syntax of its own. Read the description back.
6. **Move the issue to the ready status.**
7. Plans need no approval. Starting work is a separate instruction from the approver ("run ACME-1", or a plain go ahead outside runs).
