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

   Leave `{REVIEWER}`, `{MODEL}`, `{WORKFLOW}`, `{ISSUE}`, `{BOARD}` and `{INSTRUCTION}` as they are. The wrapper fills them before the call. An instruction from the approver for the critic, such as to edit the brief, goes in a file passed with `--instruction-file`, never into the template. Write the prompt to a file in your scratch space.
5. **Call the critic:**
   ```
   bollplank critic --ticket <TICKET> --subject brief|plan|code --round <n> --prompt-file <file> --project <project> [--critic <Critic: line>] --lead claude|codex [--read-dir <folder>] [--instruction-file <file>]
   ```
   Always pass `--project`, so the wrapper resolves the project's default. Pass `--critic` when the brief has a `Critic:` line. It wins over the project's default.
   For a plan or code review, add `--read-dir` with the narrowest source folder the review needs. Put shared instructions that live elsewhere into `{BODY}`. Never ask the critic to read a local file that was not made available.

   In a sandboxed Codex shell, request the supported approved execution outside the sandbox for this subscription CLI call at the first invocation. Keep the configured approval reviewer and never use permission bypass flags. If that request is denied, report it before changing anything. A sandboxed "Not logged in" does not prove the normal sign in is missing.

   The wrapper keeps one critic session per ticket, provider and mode, and removes every API key, provider setting and client session marker from the critic's environment. The critic works the board with its own client's tools for the project's board kind. It gets no other MCP server, no connector beyond Claude Code's board one, no web and no file edits.
   - Linear: it reads the issue and its comments, posts its critique as one comment and replies with the text it posted.
   - Jira: it is reply only. It gets the read tools `getJiraIssue` and `executeRead` of `listJiraIssueComments`, and no write tool. It reads the issue and every page of its comments and replies with its critique. You post that text, as step 6 says.

   Never pass keys, never run the critic with keys in its environment, and never point it at another sign in.
6. **Read the result.**
   - `ok: false` is a failed call. It is never an approval. Tell the approver what failed.
   - When a failed call says `posted: true`, the critic posted a comment on the issue anyway. Tell the approver a critique was posted, do not post another, and do not change the round number by hand. With `counted: true` the posted comment is a well formed critique and the wrapper counted its round, so the next call is the next round. Without it, the round stays open, and the approver decides whether to run it again.
   - `critic-unavailable`: the chosen critic's client is missing, not signed in, has no usable board server, has user settings that set a key or let it read outside its folder, or Codex could not switch off its other MCP servers. Give the approver the detail and the `fix`. The selected stage waits. Offer `same` only as their explicit choice. With an approved `Critic:` line, record that choice as a revised brief they approve (bollplank-approve). Nothing switches on its own.
   - `board-unreachable`: the critic did not read the issue and its comments. Its reply is not used. Report it to the approver. Unless the result says `counted: true`, the round is not counted and a retry with the same round resumes the session.
   - `round-mismatch`: the board and the wrapper disagree about the round. Read the board again and report. Never change the number until it passes.
   - `session-missing`: the client lost the critic's session. Call again with the same round and `--new-session`. The round counts are kept, and the result says `sessionRestarted`.
   - `post-pending`: a Jira round is waiting for its post. Do not call the critic again. Do the recovery in the Jira steps below for the round it names, then make the new call.
   - `critic-busy`: another call for this ticket and critic is running. Wait for it. Never remove the lock folder while a call may be running.
   - `critic-used-tools`: the client gave the critic a tool, an MCP server or a connector it is not allowed, or the critic used one. The reply was not used. Report it and do not retry until the client's setup is fixed.
   - `client-error`: the client reported an error. A quota or usage limit arrives this way. Say so and wait.
   - `exit` with `receivedReview`: a critique arrived before the client failed. Show it to the approver. When `counted` is false it is not a round. Unless `posted` is true, run the round again. Otherwise the approver decides.
   - `ok: true` with `delivery: "reply"` is a Jira round. The critic posted nothing, and the round stays pending until you confirm it. Do these steps in order:
     1. Run `bollplank critic pending --ticket <T>`. It prints the pending subject and round and the stored text. Use that text, not your own copy of the reply. When it says more than one critic has a round pending, add the `--lead`, `--critic` and `--project` of your critic call, here and in step 5.
     2. Read every comment on the issue (see bollplank-board). Look for one whose body is exactly that text.
     3. When no comment is exactly that text, look for a comment that may be this round all the same, since a readback can change its whitespace: its first line starts with "Critique of" and names the same subject, and its header has the same `Round: <n>` line and the same `Reviewer:` line as the stored text. If there is one, stop. Do not post and do not confirm. Tell the approver which comment it is and that it is not exactly the stored text, and let them decide. Only an exact match ever confirms a round.
     4. Only when there is neither, post the text unchanged as one comment, then read it back and check that its body is exactly that text.
     5. Save the text to a file and run `bollplank critic confirm --ticket <T> --subject <s> --round <n> --text-file <file> --comment <link>` with the comment's link. It counts the round. If it fails, report it and post nothing more.

     On `post-pending`, or after a lost reply, an interrupted post or an interrupted confirm, do the same steps from step 1. They post only when no comment has the text and none looks like the same round, so a retry never posts a second critique. Never run the critic again for a pending round.
   - `ok: true` with `delivery: "posted"` gives the verdict, the text and `posted`. When the critic posted a well formed critique, the text is that comment's body, even when its final reply was empty or malformed. Read the issue's comments again.
     - When the critique is there and the result has `headerCorrection`, fix the comment before you record a review stage or rely on the round. Each entry names a header `line`, what the comment holds (`posted`, null when the line is missing) and the `expected` value. Edit the comment's header to the expected lines with the board's comment update tool, then read the comment back to confirm. `headerCorrection` covers the Model line that `modelCorrection` names, so apply only `headerCorrection`. If the edit fails, post the returned text unchanged as a new comment, read it back and say in the summary that the lead posted it because the edit failed. Without `headerCorrection`, do nothing more.
     - When it is missing, which happens only when posting failed after the critic read the subject, post the returned text unchanged as a comment, read it back, and say in the summary that the lead posted it.
7. **Show the approver a summary:** the verdict, then each point in one line with its severity and likelihood. Do not answer the points here. That is bollplank-address.

## Notes

- A Revise verdict is a normal answer. Approve with no material points ends the rounds.
- After round 3 on a brief, suggest a spike or a code review stage instead of more brief rounds.
- The Reviewer, Model and Workflow lines of a critique come from the wrapper. The Model line ends up as the model the client reported it ran. A posted header that lacks a line or holds a wrong one is fixed through `headerCorrection`. Never invent or change any of them otherwise.
