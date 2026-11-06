# Plan: disposable ignored paths for ticket remove

Ticket: the approved brief v2 on the board. This plan is removed before the merge.

## Matching

A new module `lib/disposable.mjs` with no dependency.

- `disposableProblem(pattern)` returns null for a usable pattern, or what is wrong with it.
- `disposableMatcher(patterns)` returns a function that takes one entry from `git status --porcelain --ignored` and says whether it is disposable.

Syntax, matched against the path from the repo root:
- `*` is any run of characters other than `/`. `**` is any run of characters. `**/` is zero or more folders, only where a folder name starts.
- A trailing `/` names a folder only. A pattern without one names a file or a folder.
- Every other character is literal. `?`, `[`, `]`, `{`, `}`, `!` and `\` are refused, so nobody gets a different glob dialect than they expect.
- Patterns are anchored at the repo root. `**/*.tsbuildinfo` matches at any depth, and `*.tsbuildinfo` only at the root.

An entry is disposable when the entry itself, or one of its parent folders, matches a pattern. So `dist/` covers `dist/a.js` when git lists it on its own. A folder git reports as one entry, such as `build/`, is disposable only when that folder or a parent matches. A file pattern never makes a folder disposable because of what it holds.

Refused patterns: not a string, empty, starting with `/` or `~`, a `.` or `..` segment, an empty segment (`a//b`), a refused character, and a pattern whose segments are only `*` and `**`, such as `*`, `**`, `**/*` or `*/`, since it matches whole folders of anything.

## Config

- `lib/config.mjs` `validateRepo`: `disposable`, when present, is an array, and each entry passes `disposableProblem`. The message names the entry by index and says what to fix.
- `schema/config.schema.json`: `disposable` as an array of strings with a description.
- `bollplank init` keeps it already (`{ ...was, checks, deploy }`). A test proves it.

## Remove

In `remove` in `lib/commands/ticket.mjs`, for each present worktree, split `ignoredFiles(dest)` with the repo's matcher. Disposable paths no longer refuse. The rest refuse as today, with the same message and the same `ignored` list. `--force-ignored` is unchanged. The success output adds `disposable: { <repo>: [paths] }` for repos that had any, and leaves the key out otherwise, so a repo without the key gives exactly the 0.4.1 output.

## Docs and version

- `docs/config.md`: the key in the repo table, with the syntax and a warning to list build output only.
- `docs/commands.md`: remove skips disposable paths and names them in `disposable`.
- `skills/bollplank-accept/SKILL.md`: disposable paths need no question.
- `examples/config.example.json`: `"disposable": ["dist/", "**/*.tsbuildinfo"]` on the Acme repo.
- `package.json` 0.5.0 and a CHANGELOG section.

## Tests

- `test/disposable.test.mjs`: the matcher cases and every refused pattern.
- `test/ticket.test.mjs`: a folder pattern and a file pattern remove cleanly and are named. One more unmatched file refuses alone. A collapsed folder holding only a matching file still refuses. `--force-ignored` still deletes all. The existing test stays unchanged.
- `test/config.test.mjs` or the nearest validation test: each refused form gives its message.
- `test/init.test.mjs`: `disposable` survives an init rewrite.
