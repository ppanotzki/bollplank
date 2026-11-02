---
name: bollplank-ship
description: The shipping turn inside a Bollplank ticket run. Takes the single shipping lock, refreshes and rebases, waits for the PR checks on the rebased branches, merges and deploys each repo in the project's ship order, and verifies each deploy by its merge commit. Only used from bollplank-run. Not for manual pushes, which use the project's own ship procedure.
---

# The shipping turn

## Guard

This only runs inside a ticket folder with a run record (`.run.json`), for a project whose runs are allowed (see bollplank-run's guard). Outside that, use the project's own ship procedure, with its approval per push.

## Steps

1. **Take the turn:** `bollplank ledger mark <TICKET>`, then `bollplank turn take <TICKET>`. If another ticket holds it, wait and try again every few minutes. Never remove someone else's lock. If one has been held for more than two hours, tell the approver.
2. **Fresh state:** `bollplank ticket refresh <project> <TICKET>`. That fetches every repo and moves validation checkouts to their base branch. Rebase each changed repo's ticket branch on its latest base branch.
   - A rebase with no conflicts needs no local gate run. Go straight to step 3, where the PR checks are the gates.
   - Resolve conflicts in shared files by keeping both sides' additions, then rerun the local gates.
   - If a resolution changes behaviour, the reviewer looks at it again. When the code stage is selected, run `bollplank run reopen <project> <TICKET> code --reason <text>` and do another critic round. If that round has to wait for quota, release the turn first (step 6) and start again from step 1 later.
3. **Gates:** force push the rebased branches and wait for every PR check to pass on the new head.
4. **Ship in order.** Run `bollplank context <project>` and take each changed repo in `project.shipOrder`, which lists every repo of the project. Skip repos this ticket did not change. Every repo it changes is merged and deployed in this turn. For each one:
   1. `bollplank merge <project> <repo> <pr> --run <ticket folder>`. It refuses while a selected stage is incomplete or a check is not green.
      - `review-stale`: the PR head is not the change the last approved code round reviewed. A clean rebase keeps the approval, so this means the change itself changed. Run `bollplank run reopen <project> <TICKET> code --reason <text>`, do another critic round on the PR head, and merge again once the stage is complete.
      - `run-mismatch` or `corrupt`: the run record or ticket folder is not this ticket's, the PR is not from the ticket branch in the configured repo (a fork with the same branch name does not count) or not the PR recorded for the repo, or a record cannot be read. Stop and report. Never edit the record to get past it.
   2. `bollplank deploy-wait <project> <repo> <merge commit>`. It waits the way the repo's configured deploy kind says, and returns at once with kind `none` and status `succeeded` for a repo with no deploy.
   3. Record the result with `bollplank run deploy <project> <TICKET> <repo> --kind <kind from deploy-wait> --status <status from deploy-wait> --ref <ref from deploy-wait> --commit <merge commit>`. Record it for a repo with no deploy too, with kind `none`.
   4. Continue to the next repo only when its status is `succeeded`.

   When the last repo is done, run `bollplank run check-shipped <project> <TICKET>`. It exits 0 only when every repo the ticket changes is merged and a deploy of the repo's configured kind (`none` for a repo with no deploy) is recorded for its merge commit with status `succeeded`. A `merge` or `release` record never counts as a repo's deploy. Until it exits 0, the ticket is not shipped: finish the repo it names before the turn is released for good.

   Stop and ask the approver before any step on `project.stopList`, such as a public release. Bollplank has no ship step for infrastructure. A change that needs a step the config does not describe, such as an infrastructure change, follows the project's own ship procedure inside the turn, or is waited for with a `command` deploy. Review its preview first, and stop for permission or security changes the brief did not foresee.
5. **On a failed deploy,** status `failed`: record it, release the turn, keep the ticket in progress, and report what failed with the job or run id. Do not merge the remaining repos.
6. **Release the turn:** `bollplank turn release <TICKET>`. Release after success, after a recorded failure, or before any wait. **Never release while a started deploy has no known end state.** A `timeout` status is not an end. Wait for it with `bollplank deploy-wait` again first.

A resumed turn starts again from step 1 and reconciles with the run record. Merges and deploys already recorded are checked, never repeated.
