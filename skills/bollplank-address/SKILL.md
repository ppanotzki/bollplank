---
name: bollplank-address
description: Answer the critic's critique of a ticket's brief, plan or diff. Use when the approver says "address", "address it" or "respond to the critique", and inside a run after a Revise round. Sorts every point into fix, flag or drop, revises the subject, and posts the response comment.
---

# Address a critique

The responsible agent answers. The critic only comments.

## Steps

1. **Read the latest critique.** Run `bollplank ledger mark <TICKET>` first, then `bollplank context <project>` for the approver and the copy style. Read the latest critique on the issue and the subject it reviewed (see bollplank-board).
2. **Sort every point:**
   - **fix**: it is material and the fix is in scope. Change the subject.
   - **flag**: real but unlikely, or it would need machinery out of proportion to the risk. Add one line to the subject's "Known edge cases" list. Do not design for it.
   - **drop**: wrong, out of scope, or it reopens a settled decision. Say why in one sentence. Declining is a normal answer.

   When the only material points left are about machinery added earlier for an unlikely case, remove that machinery and flag the case. A point that needs a product decision goes to the approver before the next round.
3. **Revise the subject.** For a brief: bump the version in the header, update "Last revised", and keep "Approval" accurate (an approved brief that changes a settled decision goes back to Pending). For a plan: bump the plan's Status line. For code: commit the fixes on the ticket branch.
4. **Post the response comment,** and read it back:
   ```
   Response to <critic>'s critique of <subject>
   Responsible: <your tool>
   Model: <your model, and effort when the tool exposes it>
   Workflow: <what `bollplank version` prints>
   Outcome: Incorporated in <new version>

   1. **<point id>, <short name>. Accepted / Flagged / Dropped.** What changed, or why not.
   ```
5. **Tell the approver** in a few lines what changed and whether another round looks worth it. Another round is worth it when this round found a material point on something that matters.
