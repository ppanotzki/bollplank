# Configuration runs

This mode delivers a configured service and retained evidence without requiring code repositories, worktrees, PRs or software deployments. Read the project's AGENTS.md, registered runbook and current brief on the board first. Existing approval, review and tool permission rules still apply.

## Start and scope

Require the current approved brief and the approver's explicit run instruction. Verify the issue's team and project against `project.board`. Mark the ledger, then use `bollplank run check <project> <TICKET>` for a read only profile check. Only tickets in the project's `allowedTickets` can run. The check does not prove live service access or brief approval.

Move to the in progress status only when starting the authorized run. Save the current approved brief and retain its approval comment and the run instruction reference. Initialize with:

```
bollplank run init <project> <TICKET> --brief <file> --approval <approval reference> --instruction <instruction reference> --review plan --board-readback <file> --agents <source>/AGENTS.md
```

`--agents` is the project's AGENTS.md on disk in the source folder, the file this run reads. The helper refuses any other path, keeps a copy in the baseline folder and records its sha256, so acceptance can show whether it changed. Read the live issue and its approval comment immediately before initialization and write the readback (see bollplank-board). Keep only metadata needed for this ticket. Follow the project rules for permitted work identities and protected records. The helper checks that the readback is no older than 15 minutes, matches the registered identity and the exact brief content. It records the brief version and copies both files to an immutable baseline folder. The lead reads the actual approval on the board, verifies that it covers the current brief version and records its reference. The helper stores this reference without a URL format or substring test. This is a record of the lead's verification, not a separate approval system, and it adds no approvals for each implementation step. A timestamp in a supplied file does not prove live access. This check prevents accidental file mismatches, not fabricated evidence. The helper does not query the board or authenticate approval.

Use the brief's review value. Configuration mode supports none or plan. Init returns an existing record unchanged on resume. It does not approve a brief or call any service. Keep all records in the configured ticket folder. These helpers record evidence and gates. They are not authentication, access controls or an exclusive execution lock. Use one coordinating session per run and serialize journal updates. Do not run two writers at once.

## Plan and review

Refresh actual target identities, shared configuration consumers, before evidence and permissions. Write a versioned implementation plan in the run folder, including operation boundaries, rollback limits and acceptance cases. Record it with `bollplank run plan <project> <TICKET> --path <file>`. The returned sha256 identifies the exact review subject. No artificial Git commit is needed.

When plan review is selected, use bollplank-critique. Freeze the subject, put its snapshot and the needed board context in the prompt body, and pass the actual source folder with `--read-dir`. Critic state stays in Bollplank's home, outside the run folder. Record findings and dispositions on the ticket. Critique never edits the subject automatically. For an approved round, retain the returned result and comment readback in a local file, then record:

```
bollplank run stage <project> <TICKET> plan --revision <plan sha256> --verdict Approve --evidence <review evidence file>
bollplank run gate <project> <TICKET> plan
```

Revise rounds use verdict Revise. Changing the plan resets verification and its review gate. A material brief change needs renewed brief approval. Do not change the approved brief snapshot in place.

## Apply and verify

Use the project's actual scoped MCP, REST or UI path. Refresh the real identity and revision before each write. Manual approvals remain manual. Before an operation, record a stable operation identity and before evidence:

```
bollplank run change <project> <TICKET> --id <operation ID> --target <target alias> --status intent --evidence <before file>
```

Perform that operation once, read it back and record status verified with after evidence. A failed attempt uses status failed and retained error evidence. A target alias is a journal label. `protectedProjects` is guidance for the lead, not an API access restriction. The lead must check the actual service resource against the configured scope. Never assume it enforces remote permissions. Preserve original intent evidence. After a timeout or crash, inspect reality before retrying. Failed or pending operations require reconciliation, not blind replay. Use a new linked operation ID for a genuine new corrective write. Never erase earlier attempts. Every status transition retains its own evidence in the operation's events.

An abandoned or replaced attempt may be marked superseded without being called successful:

```
bollplank run change <project> <TICKET> --id <operation ID> --target <alias> --status superseded --reason <reason> --residual none --evidence <readback file>
```

Use residual none only when readback establishes no unresolved effect. If an effect was corrected by another operation, use `--residual corrected --replacement <operation ID>` instead. The replacement must already be verified, with intact evidence. Readback must show that the combined final state resolves the old effects. A link alone is insufficient. Superseded attempts are terminal journal entries and do not authorize replay. Required final checks still have to pass.

Verify each registered acceptance check with retained evidence:

```
bollplank run verify <project> <TICKET> --check <check name> --status pass --evidence <file>
bollplank run complete <project> <TICKET>
```

Complete requires intact evidence for all operation events and baselines, at least one verified operation, every other attempt verified or safely superseded, and all checks passing against the current plan. It records Acceptance locally. Then post the delivery note, evidence and outstanding questions on the ticket and move it to the acceptance status. It never records human acceptance or moves to Done. Do not call bollplank-ship. The approver's explicit acceptance moves it to Done through bollplank-accept, which keeps the run folder.

## Resume

Read the run record with `bollplank run show` and the live ticket before acting. Check actual configured resources and compare against every pending, failed and verified operation. Do not repeat a write solely because the journal is incomplete. Reconcile a pending intent by recording verified only if readback proves it succeeded. A failed attempt can be marked verified only when readback proves the intended result now holds. Document the intervention or corrective operation. Check that the current live brief still matches the approved snapshot and approval and that the project config has not changed. A changed brief or config requires deliberate reconciliation. Do not edit stored hashes, overwrite baseline files or delete the run.

## Amend an active run

Use the same project, ticket and run folder. This command supports approved brief amendments and corrections to the registered target config. It does not move run storage or change account authentication. Read the current live ticket and relevant approval comment again. Prepare the new approved brief and a fresh readback. Write a short scope comparison establishing what changed and why existing authority covers it, or link the approver's explicit new approval where scope changed.

```
bollplank run rebaseline <project> <TICKET> --brief <file> --approval <approval reference> --review plan --board-readback <file> --agents <source>/AGENTS.md --reason <reason> --authorization <instruction or decision reference> --scope-evidence <comparison file>
```

Pass `--agents` again when AGENTS.md changed. Without it, the new baseline carries the recorded copy forward. The helper preserves prior baseline snapshots, recorded config values, change events and old plan, review and verification references. It records the new baseline and resets the current plan, selected review gate, verification and status to In Progress. Review the effect of previous writes under the new scope, then write and review the new plan and repeat the required final checks. Previously verified writes are not replayed. Reconcile unresolved old attempts using readback or safe supersession.

An identity correction within the same already authorized target can cite the original run instruction with supporting evidence. A different target, broader permissions, new service or changed product scope requires explicit new authority. The command records that authority and evidence but cannot judge their truth. Never use it to turn an unapproved brief into an approved one. The helper rejects Pending briefs, content mismatches, wrong ticket identity and stale readbacks. Logging a stop remains possible when the config differs.

`bollplank run log <project> <TICKET> --event <text>` retains a stop reason. Report any unavailable tool or evidence. A selected review failure, unsafe shared configuration, missing authority, contradiction or unapproved scope change stops affected writes. Ordinary implementation steps within the approved scope need no new process approval.

## Interrupted local save

Use this limited recovery procedure when init or rebaseline stops because its next numbered snapshot folder already exists. It resolves only an interrupted local save. It does not change external resources or grant new scope.

1. Stop other writers and inspect the committed `.run.json`, if present, and any `.run.json.tmp`. Treat the committed file as the journal of completed local saves.
2. Confirm that the conflicting snapshot folder is not referenced by the committed record, including any retained prior baseline. If it is referenced, do not move or alter it. Investigate the mismatch instead.
3. Move the unreferenced folder and any interrupted temporary record into a uniquely named recovery folder under this run. Do not delete them or overwrite an existing recovery folder. Leave the committed record and all its referenced artifacts unchanged. Retain a short recovery note with the time, original paths, destination and reason.
4. Read the current brief and approval again, prepare fresh input and retry init or rebaseline. Record the recovery reference in the run log once a run record is available. Resume external work only from live readback and the existing operation journal. This recovery never authorizes replaying a client write.

A temporary record may describe an uncommitted amendment. Preserve it as evidence rather than treating it as an applied client change. The coordinating lead performs these local moves serially.
