# Windows

Bollplank is untested on Windows beyond CI. Nobody has installed or used it there.

## What CI covers

The `checks` workflow runs the gate on Windows with Node 20 and 22, as it does on Ubuntu and macOS. On Windows, the tests that put fake `claude`, `codex`, `gh` or `aws` programs on `PATH` are skipped, because those fakes are Node scripts with a shebang, which Windows does not run from `PATH`. These test files skip their fake program tests there:

- `test/critic.test.mjs`: every test that runs a fake client. Only the provider index, the environment scrub, the session roots and the shipped prompts are tested on Windows.
- `test/merge.test.mjs`: every test but `merge checks its arguments`.
- `test/deploy-wait.test.mjs`: the Amplify and GitHub Actions tests. The command timeout test is skipped as well, since it stops a POSIX process group.
- `test/init.test.mjs`: the Claude and Codex probe tests, `addLinearMcp` and every `init` test. The probe prompt, `judge` and the read only tool rule are tested on Windows.
- `test/doctor.test.mjs`: every test.
- `test/update.test.mjs`: every test but the semantic version sort.
- `test/uninstall.test.mjs`: every test.
- `test/install.test.mjs`: every test, since `install.sh` is a bash script.

That leaves the critic, `merge`, setup, and the Amplify and GitHub Actions kinds of `deploy-wait` without a test run on Windows. The parser, config, Workflow line, private name scan, `ticket`, `run`, `turn`, the `none` and `command` deploy kinds, the ledger and the journal modes are tested there.

## What is known not to work as on macOS

- **Install.** `install.sh` is a shell script and links into `~/.local/bin`. It is not written for Windows.
- **The command.** `bin/bollplank` is a Node script with a shebang. On Windows, run it as `node <kit>\bin\bollplank <command>`.
- **Finding the clients.** Bollplank searches `PATH`, honouring `PATHEXT`. The app bundle locations it also searches are macOS paths, so on Windows each client must be on `PATH`.
- **npm `.cmd` shims.** The providers start a client directly, without a shell, and Node does not start a `.cmd` or `.bat` file that way. A client installed with npm, whose `PATH` entry is a `.cmd` shim, is found but not started, so its sign in cannot be read and a critic call fails. A client must be on `PATH` as a program Windows can start directly, such as an `.exe`.
- **Skill links** are directory junctions on Windows.
- **`node_modules` in worktrees** is copied, not cloned, since the clone uses an APFS feature.
- **A `command` deploy that times out** stops only the shell, not the programs it started, since process groups are POSIX.

## If you try it

Open an issue with what you ran and what happened, using the bug form. Reports from Windows are welcome, and nothing on this page will claim more than they show.
