---
name: bollplank-critique
description: Have a critic model review the current brief, plan or diff of a ticket and post its critique as a comment on the issue. Use when the approver says "critique" (optionally "critique ACME-1", "critique the plan"), and inside a run for a selected plan or code stage. Runs on the person's own Claude and ChatGPT subscriptions only.
---

# Critique

The approver decides when a brief is critiqued. Never start one on your own for a brief. Inside a run, the run skill calls this for a selected plan or code stage.

For a configuration run, identify a plan by its immutable snapshot path and sha256 rather than a Git commit. Read the registered configuration runbook and use the actual project folder as source context. The selected plan review is authorized by the run grant only after its brief is approved and the run is explicitly started. Preparing support alone does not start a review.

## Steps

1. **Find the subject.** Run `bollplank ledger mark <TICKET>` first, then `bollplank context <project>`. The ticket comes from the approver's words or the session. The subject is the current brief version ("brief v3"), unless the approver or the run names the plan or a diff. Its series is `brief`, `plan` or `code`.
2. **Choose the critic.**
   - An approved brief with a `Critic:` line fixes the critic for the ticket. Refuse to run any other, and say that a different critic needs a revised brief approved again.
   - Before approval, use the brief's proposed `Critic:` line. With no line, the default applies: `project.critic.default` from `bollplank context <project>`, which is the project's own setting over the top level one.
   - `--lead` is this session's own tool, `claude` or `codex`.
3. **Read the board** (see bollplank-board): the issue and every comment. The round is counted per series and per critic from the critiques on the board, which carry a `Round:` line: round 1 when this critic has not reviewed this series yet, otherwise one more than its last round on it. A revised subject continues its series.
4. **Build the prompt** from `<kit>/prompts/critic.md`, with `kit` from context. Use `critic-same.md` next to it whenever the critic is the lead's own provider: `same`, or a named provider equal to the lead. The wrapper labels and stores those reviews as same provider. Fill:
   - `{TICKET}`, `{ROUND}`, `{DATE}` as YYYY/MM/DD
   - `{SUBJECT}`: for a brief its version, for a plan its path and commit (or snapshot sha256), for a diff the repos with base and head commits
   - `{SUBJECT_SHORT}`, for example "brief v3" or "implementation plan v2"
   - `{ROUND_NOTE}`: in round 1 "Review the whole subject." Later: "Review what changed since your last round, plus anything you missed. Your earlier rounds and the responses are in the issue's comments."
   - `{BODY}`: what the critic cannot read on the board or in the source folder, such as shared instructions that live elsewhere. The critic reads the issue, its comments and the subject itself. It may be empty.

   Leave `{REVIEWER}`, `{MODEL}`, `{WORKFLOW}`, `{ISSUE}` and `{INSTRUCTION}` as they are. The wrapper fills them before the call. An instruction from the approver for the critic, such as to edit the brief, goes in a file passed with `--instruction-file`, never into the template. Write the prompt to a file in your scratch space.
5. **Call the critic:**
   ```
   bollplank critic --ticket <TICKET> --subject brief|plan|code --round <n> --prompt-file <file> --project <project> [--critic <Critic: line>] --lead claude|codex [--read-dir <folder>] [--instruction-file <file>]
   ```
   Always pass `--project`, so the wrapper resolves the project's default. Pass `--critic` when the brief has a `Critic:` line. It wins over the project's default.
   For a plan or code review, add `--read-dir` with the narrowest source folder the review needs. Put shared instructions that live elsewhere into `{BODY}`. Never ask the critic to read a local file that was not made available.

   In a sandboxed Codex shell, request the supported approved execution outside the sandbox for this subscription CLI call at the first invocation. Keep the configured approval reviewer and never use permission bypass flags. If that request is denied, report it before changing anything. A sandboxed "Not logged in" does not prove the normal sign in is missing.

   The wrapper keeps one critic session per ticket, provider and mode, and removes every API key, provider setting and client session marker from the critic's environment. The critic works the board with the Linear tools of its own client. It gets no other MCP server, no connector beyond Claude Code's Linear one, no web and no file edits. It reads the issue and its comments, posts its critique as one comment and replies with the text it posted. Never pass keys, never run the critic with keys in its environment, and never point it at another sign in.
6. **Read the result.**
   - `ok: false` is a failed call. It is never an approval. Tell the approver what failed. When it says `posted: true`, the critic left a comment anyway. Say so.
   - `critic-unavailable`: the chosen critic's client is missing, not signed in, has no Linear server, or Codex could not switch off its other MCP servers. Give the approver the detail and the `fix`. The selected stage waits. Offer `same` only as their explicit choice. With an approved `Critic:` line, record that choice as a revised brief they approve (bollplank-approve). Nothing switches on its own.
   - `board-unreachable`: the critic did not read the issue and its comments. Its reply is not used and the round is not counted. Report it to the approver. A retry with the same round resumes the session.
   - `round-mismatch`: the board and the wrapper disagree about the round. Read the board again and report. Never change the number until it passes.
   - `session-missing`: the client lost the critic's session. Call again with the same round and `--new-session`. The round counts are kept, and the result says `sessionRestarted`.
   - `critic-busy`: another call for this ticket and critic is running. Wait for it. Never remove the lock folder while a call may be running.
   - `critic-used-tools`: the client gave the critic a tool, an MCP server or a connector it is not allowed, or the critic used one. The reply was not used. Report it and do not retry until the client's setup is fixed.
   - `client-error`: the client reported an error. A quota or usage limit arrives this way. Say so and wait.
   - `exit` with `receivedReview`: a critique arrived before the client failed. It is not a round. Show it to the approver and run the round again.
   - `ok: true` gives the verdict, the text and `posted`. Read the issue's comments again.
     - When the critique is there, apply `modelCorrection` if the result has one: edit that comment's `Model:` line from `posted` to `reported` with the board's comment update tool. Do nothing more.
     - When it is missing, which happens only when posting failed after the critic read the subject, post the returned text unchanged as a comment, read it back, and say in the summary that the lead posted it.
7. **Show the approver a summary:** the verdict, then each point in one line with its severity and likelihood. Do not answer the points here. That is bollplank-address.

## Notes

- A Revise verdict is a normal answer. Approve with no material points ends the rounds.
- After round 3 on a brief, suggest a spike or a code review stage instead of more brief rounds.
- The Reviewer, Model and Workflow lines of a critique come from the wrapper. The Model line ends up as the model the client reported it ran, through `modelCorrection` when needed. Never invent or change any of them otherwise.
