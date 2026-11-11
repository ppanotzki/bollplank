# NEO-197 plan: take in Jira as a second board kind from PR 17

Brief: NEO-197 brief v2, approved by Paul Panotzki on 2026-11-11.
Cross-model review: code.

The implementation already exists. The ticket branch `neo-197-jira-board` was fast forwarded from master 6ca9485 to Per's head 29ec973, so his 20 commits and authorship are kept. This plan covers review, fixes and landing.

## Steps

1. **Review the whole diff** (`git diff 6ca9485...HEAD`) against the brief, AGENTS.md and CONTRIBUTING.md. One reviewer reads it with these focus areas:
   - Linear behaviour unchanged: `probeLinear`, `addLinearMcp`, the Linear critic path in `review()`, `init` with an answers file without `kind`, `doctor` check ids.
   - The critic's Jira tool limits in both providers: Claude allow and deny rules, Codex `enabled_tools` and approval mode, the event check on `executeRead`.
   - The sign in path stays as settled decision 1 says: only the official Atlassian URLs, no credential stored.
   - Synthetic names only, no private data, copy style in docs, skills, prompts and messages.
2. **Hunt edge cases** in config validation and inheritance across kinds, `critic pending` and `critic confirm`, and the ACM-9 kind switch in `init`.
3. **Fix** what steps 1 and 2 find, as our own commits after Per's. Small related bugs get fixed. Big or unrelated ones go in the report.
4. **Gates.** Run the area tests while fixing. Run the full gate once on Node 20, the lowest version CI uses, and once on Node 26 before the first push.
5. **Code gate.** Codex reviews the head commit with the ticket folder as its source folder. Rounds are recorded with `bollplank run stage`. A later change to covered behaviour reopens it.
6. **Before the merge.** Update the CHANGELOG date for 0.7.0 to the merge day. Remove `docs/plans/`, Per's three files and this one, in a last commit, as settled decision 3 says.
7. **PR and ship.** Open the PR from the ticket branch. Its body ends with a `Co-authored-by:` trailer for Per, since the squash commit takes the PR body as its message. Wait for all four CI jobs. Ship with bollplank-ship. Then comment on #17 with a thank you and the merge commit link, and close it.

## Not in this ticket

- The v0.7.0 tag and release, and moving the installed kit to it, wait for Paul's word.
- Protecting master, the collaborator invite and fork steps in CONTRIBUTING.md.
