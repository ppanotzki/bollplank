# Windows

Bollplank is untested on Windows beyond CI. Nobody has installed or used it there.

## What CI covers

The `checks` workflow runs the gate on Windows with Node 20 and 22. Tests that put fake `claude`, `codex`, `gh` or `aws` programs on `PATH` are skipped there, since Windows does not run a Node script with a shebang from `PATH`. That skips:

- `test/critic.test.mjs` except the provider index, environment scrub, session roots and prompts
- `test/merge.test.mjs` except the argument checks
- `test/deploy-wait.test.mjs` for Amplify, GitHub Actions, the command timeout and a stopped command
- `test/init.test.mjs` except the probe prompt, `judge` and the read only tool rule
- `test/update.test.mjs` except the version sort
- all of `test/doctor.test.mjs`, `test/uninstall.test.mjs` and `test/install.test.mjs`

So the critic, `merge`, setup, and two deploy kinds have no test run on Windows. The parser, config, Workflow line, private name scan, `ticket`, `run`, `turn`, the `none` and `command` deploy kinds, the ledger and the journal modes do.

## Known differences from macOS

- **Install.** `install.sh` is a bash script and is not written for Windows.
- **The command.** Run it as `node <kit>\bin\bollplank <command>`.
- **Finding the clients.** Only `PATH` is searched, honouring `PATHEXT`. The app bundle locations are macOS paths.
- **npm `.cmd` shims.** Node does not start a `.cmd` file without a shell, so a client whose `PATH` entry is one is found but not started. It must be a program Windows starts directly, such as an `.exe`.
- **Skill links** are directory junctions.
- **`node_modules`** is copied into ticket worktrees and deploy checkouts, not cloned.
- **A `command` deploy that times out or is stopped** stops only the shell, not its children.

## If you try it

Open an issue with the bug form, saying what you ran and what happened.
