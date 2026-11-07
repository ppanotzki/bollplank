# Consulting runs

This mode records a project ticket's approved scope, selected reviews, operations and delivery evidence. It supports research, service configuration and code deliverables. Read the project's AGENTS.md, registered runbook, current brief on the board and coordination comments first.

## Authority and initialization

The project's `ticketPrefix` enables its tickets without an individual allowlist. Eligibility does not approve a brief or start work. Require the current approved brief, its recorded review choice and the approver's explicit run instruction for the named ticket. A finished ticket is historical and is not automatically reopened. Check the issue's actual team and project against `project.board`.

Use `bollplank run check <project> <TICKET>` for a read only profile check. It creates no run folder and does not prove service permissions. Only after the explicit start instruction, mark the ledger, move the ticket to the in progress status and capture a fresh approved brief and the board readback (see bollplank-board). Initialize with:

```
bollplank run init <project> <TICKET> --brief <file> --approval <reference> --instruction <reference> --review none|plan|code|both --board-readback <file> --agents <source>/AGENTS.md
```

`--agents` is the project's AGENTS.md as the run reads it, on disk in the source folder, in a Git source as well. The run keeps a copy so acceptance can show whether it changed. A rebaseline without it carries the recorded copy forward. The readback requires id, teamId, projectId, observedAt and the exact description. Approval references are evidence of the lead's live verification, not a separate approval system. A `Critic:` line in the brief does not change the Cross-model review check. Initialization preserves existing records on resume. Use one coordinating writer.

## Plan and code reviews

Record an immutable local implementation plan with `bollplank run plan <project> <TICKET> --path <file>`. The returned hash is the plan subject. No artificial Git repository is needed. If plan review is selected, use bollplank-critique, retain the actual result and comment readback and record it with:

```
bollplank run stage <project> <TICKET> plan --revision <plan hash> --verdict Approve --evidence <file>
bollplank run gate <project> <TICKET> plan
```

For code review, freeze a review subject file identifying the exact repository URLs, base and head commits and the retained diff or immutable source references. The critic must read the actual changed source through `--read-dir`. A manifest alone is not a code review. Record the subject with:

```
bollplank run code <project> <TICKET> --path <subject file>
bollplank run stage <project> <TICKET> code --revision <code subject hash> --verdict Approve --evidence <file>
bollplank run gate <project> <TICKET> code
```

Record Revise rounds honestly and address findings within the run mandate. Do not integrate while a selected review is incomplete or stale. Changed covered code needs a new frozen subject and review. Recording a new code subject resets its gate and final verification. A changed plan also invalidates the code gate. Use reopen with plan or code and a reason when needed. Material brief changes need the applicable renewed approval.

## Work and dependencies

Follow the approved brief and plan for exact resources, repositories, branches, tests, pull requests, checks and any deployment. The project's targets are journal labels, not remote access grants. Use the person's actual approved service access and preserve manual tool approvals. Neither the ticket prefix nor an organization label authorizes all resources there. Repository work follows its own instructions and policies. No consulting run implies a production deployment.

Use `bollplank run change` to record intent before each external operation and verified readback afterward, as the configuration reference describes. For integration or delivery governed by code review, pass `--gate code` to the change command as well as checking the gate before the action. Other work uses the plan gate. Retain stable operation identities and reconcile ambiguous outcomes before retrying. Software checks and merge or deployment outcomes are retained as evidence of the actual revision. Do not use bollplank-ship or assume the journal has the repository record format.

Read the ticket's dependency comments and actual handoff evidence at start and resume. A missing prerequisite stops the affected phase. Record the completed milestone, remaining dependency and next action on the ticket and with `bollplank run log`. Return control to the approver. Do not start sibling tickets, schedule work, create another chat or resume automatically when the prerequisite later appears. A partial milestone is not ticket completion.

## Delivery and resume

Use the approved brief's actual acceptance criteria. The generic brief-acceptance check retains a dated result covering each applicable criterion, its actual evidence and remaining limits. Do not reuse another ticket's checklist. Record verification with `bollplank run verify`, then `bollplank run complete`. Completion requires the selected reviews, intact operation and baseline evidence and the registered checks. A research or documentation artifact can be the verified change. Do not invent a service write, pull request or deployment for it.

Complete records Acceptance, not Done. Publish the delivery and evidence on the ticket and move it to the acceptance status. The approver's separate explicit acceptance is required for Done, through bollplank-accept. Preserve the run folder and actual usage limits.

For resume, read the existing record, live ticket, dependency comments and actual external outcomes before acting. Never replay successful operations. Approved baseline amendments, evidence preservation and interrupted local save recovery follow the configuration reference. A former configuration run may be shown read only through the consulting project, but is not silently converted or reopened.
