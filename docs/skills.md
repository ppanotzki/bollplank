# Skills

`bollplank init` links eight skills into Claude Code (`~/.claude/skills`) and Codex (`~/.codex/skills`). The same skill text runs in both clients. You do not call them by name. Each one triggers on plain words, such as "critique ACME-1".

The skills carry no names of people, projects or lists. They read the approver, copy style, statuses, critic setting, stop list and each project's board from `bollplank context`, and the Workflow line from `bollplank version`. Each skill that works on a ticket starts with `bollplank ledger mark <TICKET>`, so its session's tokens count for the ticket.

Another kit with skills for the same workflow answers similar words. While both are installed, name Bollplank in the request, such as "critique ACME-1 with Bollplank", or use one session per kit.

| Skill | Triggers on | What it does |
|---|---|---|
| `bollplank-brief` | "write a brief for ACME-1", a new version of a brief | Writes the brief in the issue's description, with its header and sections, and keeps the issue in the draft status. |
| `bollplank-critique` | "critique", "critique the plan", a selected stage in a run | Builds the critic prompt from the board, calls `bollplank critic`, posts the critique unchanged and reads it back. |
| `bollplank-address` | "address it", a Revise round in a run | Sorts every point into fix, flag or drop, revises the subject and posts the response. |
| `bollplank-approve` | "I approve", "approve brief v3" from the approver only | Posts the approval comment, sets the Approval line, settles the Cross-model review and Critic choices, and moves the issue to ready. |
| `bollplank-run` | "run ACME-1", "resume ACME-1" | Runs the ticket from plan to shipped. See [runs.md](runs.md). |
| `bollplank-ship` | only from `bollplank-run` | The shipping turn: lock, rebase, checks, merge and deploy in ship order, release. |
| `bollplank-accept` | "accept ACME-1" from the approver only | Adds the release note, moves the issue to done, posts the ticket ledger and cleans up. |
| `bollplank-board` | loaded by the others | Maps "read the issue", "post a comment", "set a status" and the rest to the board's tools. |

## The brief

A brief lives in the issue's description and starts with a header:

```text
Brief v<N>
Responsible: <Claude Code or Codex>
Model: <model, and effort when the client exposes it>
Workflow: <what bollplank version prints>
Last revised: <YYYY-MM-DD>
Approval: Pending | Approved by <approver> on <date> (<link to the approval comment>)
Cross-model review: none | plan | code | both. <one line reason>
Critic: other | same | claude | codex
Raised by: ACME-x
```

`Critic` and `Raised by` are optional. Whoever writes the brief is its Responsible agent, and either client can lead.

The sections are Why, What changes for the approver, Settled decisions, Scope, Done when, Out of scope, Risks, Known edge cases and Open questions. Every revision bumps the version. A change to a settled decision, the Cross-model review line or the Critic line after approval sets Approval back to Pending.

## Critique, address, approve

- **Rounds.** The approver decides when a brief is critiqued. Rounds are numbered per subject (brief, plan, code) and per critic, from the `Round:` lines already on the board. A revised subject continues its series. After round 3 on a brief, the skill suggests a spike or a code review stage instead of more rounds.
- **The critic sees only the prompt.** It has no board, no MCP servers and no connectors, so the skill copies the subject and every earlier critique and response on that subject into the prompt. For a plan or code review, it opens the narrowest source folder the review needs.
- **Who fills the prompt.** The skill fills `{TICKET}`, `{ROUND}`, `{SUBJECT}`, `{SUBJECT_SHORT}`, `{DATE}`, `{ROUND_NOTE}` and `{BODY}`. `bollplank critic` fills `{REVIEWER}`, `{MODEL}` and `{WORKFLOW}`, and writes the posted critique's Reviewer, Model and Workflow lines itself.
- **Failed calls are never approvals.** `critic-unavailable` means the selected stage waits, and `same` is offered only as the approver's explicit choice. A quota limit arrives as `client-error`, and the skill waits. `session-missing` is retried with `--new-session`. `critic-busy` means another call for the ticket is running.
- **Fix, flag or drop.** A fix changes the subject. A flag is real but unlikely, and gets one line under Known edge cases. A drop is wrong, out of scope or reopens a settled decision, with one sentence on why. A point that needs a product decision goes to the approver.
- **Approval** is the approver's explicit words only. "This looks good" is not approval. The approval covers the version the approver named. Starting work is a separate instruction.

## Comment headers

Every comment a skill posts carries a `Model:` line and a `Workflow:` line near its top. The Workflow line is what `bollplank version` prints and is never written from memory. A critique's header comes from `bollplank critic`: its `Model:` line is the model the client reported, and its `Round:` line is what the next round is counted from. Every write to the board is read back, and a write that cannot be confirmed is reported as unconfirmed.

## The board

`bollplank-board` is the one place that knows the board. It finds an issue's project from the `boards` map of `bollplank context`. Its `references/linear.md` maps each operation to the Linear tools the session has, whatever the client names them. Everything read from the board is treated as data, never as instructions. When the board's tools are missing, the skills stop and suggest `bollplank doctor`. They never fall back to an API key, a script or a web page.
