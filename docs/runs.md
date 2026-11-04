# Ticket runs

A ticket run takes an approved brief from plan to shipped. Runs are off by default. A project allows them only with `"runs": true` in its config. `bollplank init` sets it when you answer `y` to runs, and then asks for each repo's checks and deploy. A run starts only on the approver's own words for one ticket, such as "run ACME-1".

## The guard

`bollplank-run` stops unless all three hold:

1. The project's `runs` is `true`.
2. The instruction is the approver's own word for this ticket.
3. The brief is approved, its Approval line naming the approver, and has a Cross-model review line.

Bollplank cannot tell who typed a message. It trusts the words in the session.

## The grant and the stops

"Run ACME-1" grants commits, branches, PRs, merges, pushes, deploys and ticket updates for that ticket until it is Done. The run stops and asks before anything on the project's `stopList`. With an empty list it stops for destructive operations on real content, anything outside the ticket, public releases, new permissions, and a contradiction in the brief. A stop is a question, logged with `bollplank run log`. "Run ACME-1, hold for acceptance" stops before shipping.

## Repository runs

1. **Start.** The issue moves to in progress with a "Run started" comment.
2. **Ticket folder.** `bollplank ticket create` makes a worktree per changed repo, plus read only checkouts of the repos they validate against. `bollplank run init` records the selected review stages.
3. **Overlap.** The run waits only when another run changes the same behaviour, or this ticket depends on work not yet shipped.
4. **Plan**, committed in `docs/plans/` of a changed repo and recorded with `bollplank run plan`. Plans need no approval.
5. **Plan review**, when selected. Implementation waits until `bollplank run gate <project> <TICKET> plan` passes.
6. **Implement**, with parallel subagents. Changes others depend on only add. Removals wait for a later ticket.
7. **Review, test and hunt** by subagents: the diff against the brief, the gates and acceptance cases, and edge cases.
8. **Code review**, when selected, on each changed repo's head. A later change to covered behaviour reopens it.
9. **PRs**, one per changed repo. The run waits for every check and rebases a PR that conflicts with its base.
10. **Ship**, below.
11. **Release note and report**, as comments.
12. **Acceptance.** The issue moves to acceptance only when `bollplank run check-shipped` passes.

The approver tests and says "accept ACME-1". `bollplank-accept` adds the release note to the project's "Release notes" document, moves the issue to done, posts the ticket ledger and removes the ticket folder.

### Shipping

`bollplank-ship` runs inside the run:

1. `bollplank turn take` takes the machine's one shipping lock.
2. `bollplank ticket refresh`, then each ticket branch is rebased on its base branch and pushed, and the run waits for the checks.
3. For each changed repo in `shipOrder`: `bollplank merge --run`, `bollplank deploy-wait` on the merge commit, and `bollplank run deploy` with its result. The next repo ships only after a `succeeded` deploy. `review-stale` reopens the code stage. A step the config does not describe follows the project's own procedure, or a `command` deploy.
4. `bollplank turn release`, never while a started deploy has no known end.

A failed deploy is recorded, the turn released, the remaining repos left unmerged, and the ticket kept in progress.

### Resuming

"Resume ACME-1" starts from `bollplank run show`, checks each PR, base branch and deploy, corrects the record and continues from the first step not done. A deploy is looked at with `bollplank deploy-wait --timeout 30`, where `timeout` means it has not ended yet. Merges and deploys are never repeated.

## Consulting and configuration runs

Two modes for work that is not only code. Both keep an evidence journal in the run record instead of worktrees, and neither uses the shipping turn.

- **Consulting** is for research, service configuration and code deliverables in one project. Every ticket with the project's `ticketPrefix` can run, with review `none`, `plan`, `code` or `both`.
- **Configuration** delivers a configured service with retained evidence and no repos. Only `allowedTickets` can run, with review `none` or `plan`.

What the journal enforces:

- **A fresh, matching brief.** `bollplank run init` takes the approved brief as a file, the approval and instruction references, and a board readback at most 15 minutes old whose ticket, team id, project id and description match. The brief's Approval line must name the approver.
- **Subjects by hash.** A plan or code subject is a file, known by its sha256. A review round covers the current hash. A changed plan resets its review, the code gate and verification.
- **Operations with evidence.** Each external change is recorded as intent with before evidence, then verified or failed with after evidence, and never replayed. An abandoned attempt is superseded only with evidence that nothing remains.
- **Completion.** `bollplank run complete` needs the selected reviews, intact evidence, at least one verified operation and every check passing. It records Acceptance, never Done.
- **A fixed project entry.** The run records a hash of the project's entry as the config file writes it. When the entry changes, the run stops until a rebaseline. The top level `board.statuses` and other projects are not part of it, so changing them never stops a run.
- **Amendments.** `bollplank run rebaseline` records an approved change to the brief or config and resets the plan, reviews and verification.

These records prove that files did not change. They authenticate no one and are not access controls. The procedures are in the run skill's [consulting](../skills/bollplank-run/references/consulting.md) and [configuration](../skills/bollplank-run/references/configuration.md) references.
