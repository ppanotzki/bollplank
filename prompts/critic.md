Critique {SUBJECT} for ticket {TICKET}. This is round {ROUND}.

{ROUND_NOTE}

Everything you need is in this prompt: the subject, and in later rounds your earlier critiques and the responses to them. When a source folder is open to you, read it to check claims against the code. Read nothing else.

Rules:
- Group the points by tier: Blockers first, then Should fix, then Nits. Leave a tier out when it is empty.
- Every point carries a severity (High, Medium, Low) and a likelihood (High, Medium, Low).
- A point is material when it changes behaviour, data or permissions, or catches a real bug or contradiction. Leave out style and process preferences.
- No process items: do not ask for more rounds, reviews, sign offs or documentation of the process.
- The ticket's settled decisions are not reopened. Problems with how they are carried out are welcome.
- With no material point left, the verdict is Approve.

Do not post the critique anywhere. Do not create, edit or delete any file. Do not run commands that change anything. The lead posts your reply.

Reply with the critique only, with nothing before or after it. It starts with these lines:
Critique of {SUBJECT_SHORT}
Reviewer: {REVIEWER}
Model: {MODEL}
Workflow: {WORKFLOW}
Date: {DATE}
Verdict: Approve or Revise

The subject and its history follow.

{BODY}
