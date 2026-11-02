# Same model mode

The method works best when the critic comes from another vendor than the lead. Same model mode is for people with only one client, or for a ticket where the approver chooses it. It is a weaker review, and Bollplank labels it as one.

## What it does

- **A separate session.** The critic is a fresh session of the lead's own client that inherits nothing from the lead's session. One such session is kept per ticket and reused across that ticket's brief, plan and code rounds, so it remembers the brief when it reviews the plan.
- **A harder prompt.** [prompts/critic-same.md](../prompts/critic-same.md) tells the critic that it likely shares the author's blind spots. It asks for the strongest reason the subject fails first, a check of every claim against the source, no credit for intent, and an Approve only after it looked for a failure and found none.
- **Its own model setting.** `critic.same.<provider>` in the config can pin a different model or a higher effort for same provider reviews, when your subscription offers one. Without it, `critic.providers.<provider>` applies.
- **A label.** The critique's Reviewer line reads `Claude Code, same provider, separate session` or `Codex, same provider, separate session`. Its state file is separate from an other provider critic's, so their rounds never mix.

## Why it is weaker

A model reviewing its own vendor's work tends to accept the same premises and miss the same things. A different model with no authorship looks for different problems. The harder prompt and a fresh session help, but they do not make it another vendor. Both kinds of critic can also share an error when the code itself misleads them, such as through an outdated comment.

## How it is chosen

Same model mode is used only when someone chose it:

1. **In the config:** `"critic": { "default": "same" }`. `bollplank init` offers this when it finds only one client, and says what it means. It never changes an existing `other` without asking.
2. **For a ticket:** a `Critic: same` line in the brief, under the Cross-model review line. Once the brief is approved, that line wins for the ticket, and the critique skill refuses to run any other critic for it.
3. **For one call:** `bollplank critic --critic same`, when the lead has the approver's word for it.

Naming the lead's own provider (`--critic claude` in a Claude Code session) is a same provider review too, and is labelled as one.

## What never happens

Nothing switches to same model mode on its own. With `critic.default` set to `other` and only one client available, `bollplank critic` fails with `critic-unavailable`, a selected review stage stays incomplete, and the approver decides. If they choose `same` for a ticket whose approved brief names another critic, that is a revised brief with a new `Critic:` line, approved again.
