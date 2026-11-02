---
name: bollplank-critique
description: Have a critic model review the current brief, plan or diff of a ticket, then post its critique as a comment. Use when the approver says "critique" (optionally "critique ACME-1", "critique the plan"), and inside a run for a selected plan or code stage. Runs on the person's own Claude and ChatGPT subscriptions only.
---

# Critique

The approver decides when a brief is critiqued. Never start one on your own for a brief. Inside a run, the run skill calls this for a selected plan or code stage.

For a configuration run, identify a plan by its immutable snapshot path and sha256 rather than a Git commit. Read the registered configuration runbook and use the actual project folder as source context. The selected plan review is authorized by the run grant only after its brief is approved and the run is explicitly started. Preparing support alone does not start a review.

## Steps

1. **Find the subject.** Run `bollplank ledger mark <TICKET>` first, then `bollplank context <project>`. The ticket comes from the approver's words or the session. The subject is the current brief version ("brief v3"), unless the approver or the run names the plan or a diff. Its series is `brief`, `plan` or `code`.
2. **Choose the critic.**
   - An approved brief with a `Critic:` line fixes the critic for the ticket. Refuse to run any other, and say that a different critic needs a revised brief approved again.
   - Before approval, use the brief's proposed `Critic:` line. With no line, use `critic.default` from context.
   - `--lead` is this session's own tool, `claude` or `codex`.
3. **Read the board** (see bollplank-board): the issue and every comment. The round is counted per series and per critic from the critiques on the board, which carry a `Round:` line: round 1 when this critic has not reviewed this series yet, otherwise one more than its last round on it. A revised subject continues its series.
4. **Build the prompt** from `<kit>/prompts/critic.md`, with `kit` from context. Use `critic-same.md` next to it whenever the critic is the lead's own provider: `same`, or a named provider equal to the lead. The wrapper labels and stores those reviews as same provider. Fill:
   - `{TICKET}`, `{ROUND}`, `{DATE}` as YYYY/MM/DD
   - `{SUBJECT}`: for a brief its version, for a plan its path and commit (or snapshot sha256), for a diff the repos with base and head commits
   - `{SUBJECT_SHORT}`, for example "brief v3" or "implementation plan v2"
   - `{ROUND_NOTE}`: in round 1 "Review the whole subject." Later: "Review what changed since your last round, plus anything you missed. Your earlier rounds and the responses are below."
   - `{BODY}`: the full subject text, then every earlier critique and response on this series, copied from the board. The critic has no board access, so it knows only what is here.

   Leave `{REVIEWER}`, `{MODEL}` and `{WORKFLOW}` as they are. The wrapper fills them. Write the prompt to a file in your scratch space.
5. **Call the critic:**
   ```
   bollplank critic --ticket <TICKET> --subject brief|plan|code --round <n> --prompt-file <file> --critic <choice> --lead claude|codex [--read-dir <folder>]
   ```
   For a plan or code review, add `--read-dir` with the narrowest source folder the review needs. Put shared instructions that live elsewhere into `{BODY}`. Never ask the critic to read a local file that was not made available.

   In a sandboxed Codex shell, request the supported approved execution outside the sandbox for this subscription CLI call at the first invocation. Keep the configured approval reviewer and never use permission bypass flags. If that request is denied, report it before changing anything. A sandboxed "Not logged in" does not prove the normal sign in is missing.

   The wrapper keeps one critic session per ticket, provider and mode, and removes every API key and provider setting from the critic's environment. Never pass keys, never run the critic with keys in its environment, and never point it at another sign in.
6. **Read the result.**
   - `ok: false` is a failed call. It is never an approval. Tell the approver what failed.
   - `critic-unavailable`: the chosen critic's client is missing or not signed in. The selected stage waits. Tell the approver, and offer `same` only as their explicit choice. With an approved `Critic:` line, record that choice as a revised brief they approve (bollplank-approve). Nothing switches on its own.
   - `round-mismatch`: the board and the wrapper disagree about the round. Read the board again and report. Never change the number until it passes.
   - Quota: say so and wait.
   - `ok: true` gives the verdict and the text. Post the text unchanged as a comment on the issue and read it back.
7. **Show the approver a summary:** the verdict, then each point in one line with its severity and likelihood. Do not answer the points here. That is bollplank-address.

## Notes

- A Revise verdict is a normal answer. Approve with no material points ends the rounds.
- After round 3 on a brief, suggest a spike or a code review stage instead of more brief rounds.
- The Model and Workflow lines of a critique come from the wrapper. Never invent either.
