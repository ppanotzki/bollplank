# Windows

Bollplank is untested on Windows beyond CI. Nobody has installed or used it there.

## What CI covers

The `checks` workflow runs the gate on Windows with Node 20 and 22, as it does on Ubuntu and macOS. On Windows, the tests that put fake `claude`, `codex`, `gh` or `aws` programs on `PATH` are skipped, because those fakes are Node scripts with a shebang, which Windows does not run from `PATH`. That leaves the critic, `merge`, and the Amplify and GitHub Actions kinds of `deploy-wait` without a test run on Windows. The parser, config, Workflow line, private name scan, `ticket`, `run`, `turn`, the `none` and `command` deploy kinds, the ledger and the journal modes are tested there.

## What is known not to work as on macOS

- **Install.** `install.sh` is a shell script and links into `~/.local/bin`. It is not written for Windows.
- **The command.** `bin/bollplank` is a Node script with a shebang. On Windows, run it as `node <kit>\bin\bollplank <command>`.
- **Finding the clients.** Bollplank searches `PATH`, honouring `PATHEXT`. The app bundle locations it also searches are macOS paths, so on Windows each client must be on `PATH`.
- **`node_modules` in worktrees** is copied, not cloned, since the clone uses an APFS feature.

## If you try it

Open an issue with what you ran and what happened, using the bug form. Reports from Windows are welcome, and nothing on this page will claim more than they show.
