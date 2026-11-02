# Same model mode

The method works best with a critic from another vendor than the lead. Same model mode is for people with one client, or for a ticket where the approver chooses it. It is weaker, and labelled as such.

## What it does

- **A separate session** of the lead's own client, sharing nothing with the lead's session. One is kept per ticket across its brief, plan and code rounds. It works the board like any critic.
- **A harder prompt**, [prompts/critic-same.md](../prompts/critic-same.md). It says the critic likely shares the author's blind spots, and asks for the strongest reason the subject fails, a check of every claim, no credit for intent, and an Approve only after it looked for a failure and found none.
- **Its own model setting.** `critic.same.<provider>` can pin another model or a higher effort. Without it, `critic.providers.<provider>` applies.
- **A label.** The Reviewer line reads `Claude Code, same provider, separate session` or `Codex, same provider, separate session`. Its rounds are kept apart from another critic's.

A model reviewing its own vendor's work tends to accept the same premises and miss the same things. The prompt and the fresh session help, but they do not make it another vendor.

## How it is chosen

Only when someone chooses it:

1. **In the config:** `"critic": { "default": "same" }`. `bollplank init` offers it when it finds one client, and never changes an existing `other` without an answer.
2. **For a ticket:** a `Critic: same` line in the brief. Once approved, it wins for the ticket.
3. **For one call:** `bollplank critic --critic same`, on the approver's word.

Naming the lead's own provider, such as `--critic claude` in a Claude Code session, is a same provider review too.

Nothing switches to it on its own. With `other` and one client, `bollplank critic` fails with `critic-unavailable`, and the approver decides. Choosing `same` for a ticket whose approved brief names another critic means a revised brief, approved again.
