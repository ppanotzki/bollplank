# Contributing

Bollplank is small on purpose: plain Node 20 or later, ESM, no dependencies. A change to a skill or a command changes how every user's sessions work, so keep skills short and free of project specifics.

## The gate

```sh
node scripts/check.mjs
```

It checks that every script parses, every skill has valid frontmatter with a name starting `bollplank-`, the prompts keep their placeholders, the example config validates, every test in `test/` passes, and the private name check passes. The same command runs on every PR as the `checks` workflow, on Ubuntu, macOS and Windows with Node 20 and 22. `node scripts/check.mjs --no-tests` skips the tests while you iterate. The PR check always runs them.

## Tests

- Tests use synthetic names only: Acme, `ACME-1`, `acme-shop`, `acme/acme-api`.
- Tests use fake programs only. `test/helpers.mjs` builds a temporary home, temporary client folders and a `PATH` with fake `claude`, `codex`, `gh` and `aws` programs, and leaves your own tool folders out of it. No test may reach a real client, a real sign in, a real config or a real remote.
- Never test with a real API key in the environment or against a real sign in.
- A test that needs macOS behaviour skips elsewhere and says why.

## The private name check

The gate searches the whole history of `HEAD` for a list of private names. It reads every commit message whole, every author and committer name and email, and every change as text, including binary files, files marked `-diff` in `.gitattributes` and the changes of merge commits against each parent. Replace refs, grafts and local diff settings cannot hide history from it.

The list cannot live in a public repo without publishing it, so it lives outside: in the `BOLLPLANK_PRIVATE_NAMES` repository secret for CI, and in `~/.bollplank/private-names.txt` for maintainers. One name per line matches anywhere, ignoring case. A line starting with `re:` is a case sensitive regular expression, and a line starting with `#` is a comment.

The check fails, and the gate with it:

- when the list is missing, which reports `skipped`
- when a pattern is not a valid regular expression, named by its number
- when the repository is a shallow clone, since part of its history cannot be read. Fetch the full history first.

A pull request from a fork does not get the secret, so its check fails until a maintainer runs it with the list. That is expected. A maintainer runs the gate on your branch before merging. Results name a pattern by its number and never print a name. A hit names its file only when the path itself matches no name, and otherwise says `(path withheld)`.

## Copy style

For docs, skills, prompts, messages and comments:

- Plain sentences.
- No em or en dashes, and no semicolons.
- No filler and no marketing adjectives.
- Write for a developer who is busy and skeptical. Claim only what the code does and the tests show.

## Issues and pull requests

Use the bug or request form. A maintainer takes an accepted issue into the project's own tracker as a ticket, links the ticket from the issue and the issue from the ticket, and the change then goes through the same brief, critique and approval as any other.

For a pull request, keep it to one change, run the gate, and say what you tested.
