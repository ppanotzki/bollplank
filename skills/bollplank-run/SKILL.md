---
name: bollplank-run
description: Run a ticket autonomously from plan to shipped. Use when the approver says "run ACME-1" (or "run ACME-1, hold for acceptance"), or "resume ACME-1" for a run that stopped. Only works for projects whose Bollplank config allows runs and for tickets with an approved brief.
---

# Run a ticket

## Guard: check this first, every time

1. Run `bollplank context <project>`. Runs are allowed only when `project.runs` is `true`. Otherwise stop and tell the approver: "Ticket runs are not enabled for <project>. Nothing was started." Do nothing else.
2. The instruction must be the approver's own explicit word for this ticket.
3. The brief must be approved (its Approval line names the approver from context) and have a Cross-model review line. If not, stop and say so.

Until the guard passes, every repo's own rules apply unchanged.

## Consulting and configuration projects

For `project.mode` `consulting`, follow [references/consulting.md](references/consulting.md) and the project runbook. For `configuration`, follow [references/configuration.md](references/configuration.md) and the project runbook. Do not use the repository steps below for either. A request to prepare run support is not a run instruction.

## The grant

"Run ACME-1" is a standing grant for that ticket until it is Done. It covers commits, branches, PRs, merges, pushes and deploys in the project's repos, and board updates on the ticket.

Stop and ask for anything on `project.stopList`. When the list is empty, stop and ask for:
- destructive operations on real content
- anything outside the ticket
- public releases
- new permissions, and which roles should carry them
- a contradiction in the brief.

A stop is a question to the approver, not a failure. Record it with `bollplank run log <project> <TICKET> --event <text>` and wait.

## Steps

1. **Status.** Run `bollplank ledger mark <TICKET>` first. Move the issue to the in progress status. Post a short "Run started" comment with your Model line and the Workflow line from `bollplank version`.
2. **Ticket folder and record.** Run `bollplank ticket create <project> <TICKET> --slug <slug> --change <repos>`, with the repos the brief changes. Validation repos are added automatically. Then run `bollplank run init <project> <TICKET> --review <value from the brief>`, adding `--critic <the brief's Critic line>` when the brief has one. If the record already exists, this is a resume: go to "Resuming".
3. **Overlap.** Read the other active ticket folders' `.ticket.json` and `.run.json` under `project.tickets`.
   - Additions to shared files, such as locale files, indexes and schema documents, run in parallel.
   - Wait only when another run changes the same behaviour, or when this ticket depends on a change that has not shipped. Say which, and wait.
   - Check again whenever your scope grows.
4. **Plan.** Write the plan in `docs/plans/` of a changed repo inside the ticket folder, commit it on the ticket branch, and record it with `bollplank run plan <project> <TICKET> --commit <sha> --path <file>`. Plans need no approval. If the approver asked to see it, show it and wait.
5. **Plan gate.** If the plan stage is selected, run bollplank-critique on the plan commit. Record each round with `bollplank run stage <project> <TICKET> plan --revision <commit> --verdict <v> --points <n>`. On Revise, sort every point into fix, flag or drop (bollplank-address), revise the plan, and run the next round until the critic approves or confirms nothing material is left. Then record `--complete`. **Do not start implementers until `bollplank run gate <project> <TICKET> plan` exits 0.**
6. **Implement.**
   - Use parallel subagents, one per plan step that can run on its own, each told its files and its ticket folder paths.
   - Changes that other repos or deployed clients depend on only add. Removals wait for a later ticket.
   - Follow the project's own procedures with ticket folder paths.
7. **Review, test, hunt.**
   - A reviewer subagent reads the whole diff against the brief.
   - A tester runs the gates in the ticket folder and the brief's acceptance cases. It may drive a browser on localhost only.
   - Gate cadence: while iterating on fixes, run only the gates for the area changed. Run the full suite once per repo, under the runtime version CI uses, before that repo's first push. After that, the PR check is the full run.
   - A bug hunter looks for edge cases.
   - Fix related small bugs. Note big or unrelated ones for the report.
8. **Code gate.** If the code stage is selected, run the critic on the diff's head commits, with rounds recorded as in step 5 under `code`. A code round names the reviewed head of each changed repo: `bollplank run stage <project> <TICKET> code --revisions <repo>=<sha>,<repo>=<sha> --verdict <v> --points <n>`. `--revision <sha>` is enough when the ticket changes one repo. `bollplank merge` checks each repo's PR against its own entry. Any later change to covered behaviour means `bollplank run reopen <project> <TICKET> code --reason <text>` and another round. `bollplank merge` refuses while the stage is incomplete.
9. **PRs.** Push each changed repo's ticket branch and open one PR per repo. Wait for every check to pass. Fix failures on the branch. GitHub runs no check on a PR that conflicts with its base (`gh pr view --json mergeable` says CONFLICTING), so never wait on one: rebase that branch on the latest base branch now, keep both sides' additions in shared files, rerun the local gates, and force push. A rebase with no conflicts needs no local rerun. A resolution that changes behaviour reopens a selected code stage.
10. **Ship.** Follow bollplank-ship. Unless the approver said "hold for acceptance", ship as soon as the work is complete.
11. **Release note and report.**
    - The release note is a comment titled "Release note", with your Model and Workflow lines, in plain product language. bollplank-accept later copies it into the project's "Release notes" document.
    - The report covers what shipped, deviations from the plan, bugs fixed, bugs found for the approver's decision, Known edge cases, and an acceptance checklist of three to five items.
12. **Acceptance.** Move the issue to the acceptance status only when `bollplank run check-shipped <project> <TICKET>` exits 0: every repo the ticket changes is merged and the deploy of its merge commit, of the repo's configured deploy kind, has status `succeeded`. A `not-shipped` result names what is missing. A failed deploy keeps it in progress with a clear report.

## Resuming

A stopped run, or the approver saying "resume ACME-1", starts here. Never repeat a merge or a deploy.

1. Run `bollplank ledger mark <TICKET>`, then `bollplank run show <project> <TICKET>`.
2. Check the real state: each PR (open or merged, with its merge commit), the base branch in each repo, and each deploy by its commit with `bollplank deploy-wait <project> <repo> <commit> --timeout 30`, which only looks for 30 seconds. A `timeout` status there means the deploy has no end yet, not that it failed. Wait for it with `deploy-wait` and no `--timeout`, then record that result.
3. Correct the record where reality differs, then continue from the first step that is not done.

A failed acceptance test returns the ticket to in progress. The same grant covers the fix within the approved scope.
