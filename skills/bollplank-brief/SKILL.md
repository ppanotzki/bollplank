---
name: bollplank-brief
description: Write or revise a ticket's brief on the board the Bollplank way. Use when the approver asks for a brief, a ticket write up, or a new version of a brief. Covers the header lines, including the Cross-model review and Critic lines, the sections and the status.
---

# Write a brief

Create the issue first when it does not exist yet (see bollplank-board), then run `bollplank ledger mark <TICKET>`, so this session's tokens count for the ticket in its ledger. Run `bollplank context <project>` for the approver's name, the copy style, the statuses and the critic setting.

A brief lives in the issue's description. Any tool can lead: whoever writes the brief is its Responsible agent.

## Header

```
Brief v<N>
Responsible: <Claude Code or Codex>
Model: <model name, and effort when the tool exposes it>
Workflow: <what `bollplank version` prints>
Last revised: <YYYY-MM-DD>
Approval: Pending | Approved by <approver> on <date> (<link to the approval comment>)
Cross-model review: none | plan | code | both. <one line reason>
Critic: other | same | claude | codex
Raised by: ACME-x
```

**Approval** names the approver exactly as `bollplank context` gives it, since the run helper matches that name.

**Cross-model review** is your recommendation, and the approver settles it when they approve. Recommend `plan`, `code` or `both` only when the work is complex or risky enough: several repos, shipping or data migration, permissions, concurrency, anything hard to undo. Otherwise `none`. A selected stage is a gate in the run. It must complete before implementation (plan) or before merging (code). Keep this line's format exactly as shown.

**Critic** is optional and sits on its own line under Cross-model review. It names who reviews this ticket: `other` is the model not leading, `same` is a separate session of the leading model, `claude` and `codex` name one. Leave the line out to use the project's critic default, `project.critic.default` from `bollplank context <project>`. Once approved, the line wins for the ticket.

**Raised by** names the ticket whose work gave rise to this one. Leave the line out when there is none. The ledger's Raised list reads only this line.

## Sections

Why, What changes for the approver (when it changes how they work), Settled decisions (numbered, the ones the approver made, which critics do not reopen), Scope (phases when there are several), Done when, Out of scope, Risks, Known edge cases (one line each, from flagged critique points), Open questions (the approver's product decisions, answered before round 2).

## Rules

- Plain sentences in the project's copy style. No filler.
- A brief goes to the draft status while it is being written and critiqued, and the ready status once the approver approves.
- Every revision bumps the version and "Last revised". A change to a settled decision, the Cross-model review line or the Critic line after approval resets Approval to Pending.
- Approval is only the approver's explicit word ("I approve", "approved"). Enthusiasm is not approval.
