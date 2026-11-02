# Ticket runs

A ticket run takes an approved brief from plan to shipped with little supervision. It is off by default. A project allows runs only with `"runs": true` in its config, and a run starts only on the approver's explicit words for one ticket, such as "run ACME-1".

## The guard

Before anything else, `bollplank-run` checks three things and stops when one fails:

1. The project's `runs` is `true`. That is the only switch: there is no list of tickets per project for repository runs.
2. The instruction is the approver's own word for this ticket.
3. The brief is approved, with its Approval line naming the approver from the config, and has a Cross-model review line.

Bollplank cannot tell who typed a message. The approver is the person at the keyboard of the session, and the guard trusts the words in it.

## The grant and the stops

"Run ACME-1" is a standing grant for that ticket until it is Done. It covers commits, branches, PRs, merges, pushes and deploys in the project's repos, and updates on the ticket. The run stops and asks before anything on the project's `stopList`. With an empty list it stops for destructive operations on real content, anything outside the ticket, public releases, new permissions, and a contradiction in the brief. A stop is a question, recorded with `bollplank run log`, not a failure. "Run ACME-1, hold for acceptance" stops before shipping.

## Repository runs

The default mode, for projects whose work is code in git repos on GitHub.

1. **Start.** The issue moves to in progress and gets a "Run started" comment.
2. **Ticket folder.** `bollplank ticket create` makes one worktree per repo the brief changes, plus read only checkouts of the repos they validate against. `bollplank run init` writes the run record with the review stages the brief selected, and with the brief's `Critic:` line as `--critic` when it has one.
3. **Overlap.** The run reads the other active ticket folders and waits only when another run changes the same behaviour, or when this ticket depends on work that has not shipped.
4. **Plan.** The plan is committed in `docs/plans/` of a changed repo and recorded with `bollplank run plan`. Plans need no approval.
5. **Plan review**, when the brief selected `plan` or `both`. The critic reviews the plan commit, the lead addresses each round, and implementation waits until `bollplank run gate ... plan` passes.
6. **Implement**, with parallel subagents where steps are independent. Changes that other repos or deployed clients depend on only add. Removals wait for a later ticket.
7. **Review, test and hunt.** A reviewer reads the whole diff against the brief, a tester runs the gates and the brief's acceptance cases, and a bug hunter looks for edge cases.
8. **Code review**, when the brief selected `code` or `both`, on the diff's head commits. Each round names the reviewed head of every changed repo with `--revisions`. A later change to covered behaviour reopens the stage. At merge, `bollplank merge` checks that each PR head carries the change approved for its repo by verbatim patch id, so a clean rebase keeps the approval, and a changed change, an indentation change included, needs the stage reopened and reviewed again.
9. **PRs.** One PR per changed repo. The run waits for every check, and rebases a PR that conflicts with its base, since GitHub runs no checks on one.
10. **Ship.** See below.
11. **Release note and report**, as comments on the issue.
12. **Acceptance.** The issue moves to acceptance only when `bollplank run check-shipped` passes: every repo the ticket changes is merged and its merge commit deployed with status `succeeded`, by a deploy of the repo's configured kind (`none` for a repo with no deploy). A `merge` or `release` record does not count.

The approver tests and says "accept ACME-1". `bollplank-accept` adds the release note to the project's "Release notes" document, moves the issue to done, posts the ticket ledger and removes the ticket folder. `bollplank ticket remove` refuses when anything could be lost.

### Shipping

`bollplank-ship` runs inside the run:

1. `bollplank turn take` takes the machine's one shipping lock. Another ticket's lock is never removed.
2. `bollplank ticket refresh` fetches every repo, and each ticket branch is rebased on its latest base branch.
3. The rebased branches are pushed, and the run waits for the PR checks on the new heads.
4. For each changed repo in `shipOrder`, which lists every repo of the project: `bollplank merge --run`, which merges only the ticket's own PR from the ticket branch in the configured repo, never a fork, then `bollplank deploy-wait` on the merge commit, then `bollplank run deploy` with the `kind`, `status` and `ref` that `deploy-wait` returned, also for a repo with no deploy. The next repo ships only after this one's deploy has status `succeeded`. A merge refused with `review-stale` reopens the code stage for another round. A step the config does not describe, such as an infrastructure change, follows the project's own ship procedure inside the turn, or is waited for with a `command` deploy.
5. `bollplank turn release`, never while a started deploy has no known end.

A failed deploy is recorded, the turn is released, the remaining repos are not merged, and the ticket stays in progress.

### Resuming

"Resume ACME-1", or a stopped run, starts from `bollplank run show`. The run checks the real state of each PR, base branch and deploy, corrects the record where it differs, and continues from the first step not done. Each deploy is looked at with `bollplank deploy-wait --timeout 30`, which only looks for 30 seconds. A `timeout` status there means the deploy has no end yet, so the run waits for it with `deploy-wait` and no `--timeout` before it records anything. Merges and deploys are never repeated.

## Consulting and configuration runs

Two modes for work that is not, or not only, code in a repo. Both keep an evidence journal in the run record instead of worktrees, and neither uses the shipping turn.

- **Consulting** is for research, service configuration and code deliverables in one project. Every ticket with the project's `ticketPrefix` can run. Review can be `none`, `plan`, `code` or `both`.
- **Configuration** is for delivering a configured service with retained evidence, with no repos. Only the tickets in `allowedTickets` can run. Review can be `none` or `plan`.

What the journal enforces:

- **A fresh, matching brief.** `bollplank run init` takes the approved brief as a file, the approval and instruction references, and a board readback of the live issue. It refuses a readback older than 15 minutes, a readback whose ticket, team id or project id differs from the config, a description that differs from the brief file, and a brief whose Approval line does not name the approver or whose Cross-model review line differs from `--review`. The brief and readback are copied into a numbered baseline folder.
- **Subjects by hash.** A plan or code subject is a file, identified by its sha256. A review round must cover the current hash and comes with its evidence file. Changing the plan resets its review, the code gate and verification.
- **Operations with evidence.** Each external change is recorded as intent with before evidence, then as verified or failed with after evidence. A recorded operation is never replayed. An abandoned attempt can be marked superseded only with readback that shows no remaining effect, or a verified corrective operation.
- **Completion.** `bollplank run complete` needs the selected reviews, intact evidence for every baseline and operation, at least one verified operation and every registered check passing against the current plan. It records Acceptance, never Done.
- **Amendments.** `bollplank run rebaseline` records an approved change to the brief or the project's config, keeps every earlier baseline and operation, and resets the plan, reviews and verification.

These records prove that files did not change. They do not authenticate anyone and are not access controls. The lead verifies live access, approvals and identities and passes the evidence in. The full procedures are in the run skill's [consulting](../skills/bollplank-run/references/consulting.md) and [configuration](../skills/bollplank-run/references/configuration.md) references. Both modes keep the run folder after acceptance.
