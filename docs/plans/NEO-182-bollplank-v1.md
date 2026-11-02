# NEO-182 implementation plan: Bollplank v1

Plan v3
Status: Revised after Codex's round 2 (both points accepted), for round 3
Ticket: NEO-182, brief v6, approved 2026-11-02, Cross-model review both
Responsible: Claude Code
Model: Claude Opus 5.5
Workflow: agent-workflow 1.0, build 27
Repo: `ppanotzki/bollplank` (private), branch `neo-182-v1`, worktree `~/Work/Tools/Tickets/NEO-182/bollplank`

This plan covers how the brief is built. It does not reopen the brief's settled decisions. Every example name in code, tests and docs is synthetic (Acme, `ACME-1`, `acme-shop`).

## 1. Shape

* **One command.** `bin/bollplank` dispatches to `lib/commands/<name>.mjs`. Subcommands: `version`, `init`, `doctor`, `update`, `uninstall`, `context`, `critic`, `ticket`, `run`, `turn`, `merge`, `deploy-wait`, `ledger`. Each prints one JSON result on stdout, except `init`, `doctor`, `update` and `uninstall`, which talk to a person and take `--json`.
* **One argument parser.** `lib/args.mjs` takes a spec per subcommand (flag, value or boolean, required). The kit has two parsing styles that disagree about `--flag --other`. Bollplank has one, and a missing value is a usage error, never a silent `true`.
* **One place for paths.** `lib/paths.mjs`. The home is `$BOLLPLANK_HOME` or `~/.bollplank`, holding `config.json`, `kit/` (the clone), `critics/`, `neutral/`, `ledger/`, `install.json` and `ship.lock` by default. `$CLAUDE_CONFIG_DIR` and `$CODEX_HOME` are honoured for the client folders. Tests set all of these to temporary folders.
* **Plain Node 20 or later, no dependencies, ESM.** `package.json` gets `"engines": {"node": ">=20"}` and `bollplank doctor` checks it.

## 2. Configuration (brief Phase 1)

`~/.bollplank/config.json`, validated by `lib/config.mjs` on every command. `schema/config.schema.json` documents it for editors, and `examples/config.example.json` is a complete synthetic example the gate validates.

```
{
  "approver": { "name": "Ada" },
  "copyStyle": "Plain sentences. No filler.",
  "board": { "kind": "linear", "statuses": { "draft": "Draft", "ready": "Ready", "inProgress": "In Progress", "acceptance": "Acceptance", "done": "Done" } },
  "critic": { "default": "other", "providers": { "claude": { "model": "...", "effort": "high" }, "codex": { "model": "...", "effort": "high" } }, "same": { "claude": { "model": "...", "effort": "max" } } },
  "shipLock": "~/.bollplank/ship.lock",
  "projects": {
    "acme-shop": {
      "mode": "repository",
      "source": "~/Code/acme", "tickets": "~/Code/acme/Tickets",
      "repos": { "acme-api": { "github": "acme/acme-api", "checks": ["checks"], "baseBranch": "main", "cloneNodeModules": true, "deploy": { "kind": "github-actions", "workflow": "deploy" } } },
      "validatesAgainst": {},
      "shipOrder": ["acme-api"],
      "board": { "team": "ACME", "project": "Shop" },
      "runs": true,
      "stopList": ["destructive operations on real content", "anything outside the ticket"]
    }
  }
}
```

* `mode` is `repository`, `consulting` or `configuration`. The consulting and configuration keys of the kit (`ticketPrefix`, `allowedTickets`, `targets`, `runbook`, `verificationChecks`, `protectedProjects`, `board.teamId`, `board.projectId`) keep their meaning and validation.
* `runs` is off unless set. There is no separate `runs.json`. The run skill and `bollplank run` both refuse a project whose `runs` is not `true`.
* `baseBranch` defaults to the remote's default branch (`origin/HEAD`), then `master`. The kit hardcodes `master`.
* `bollplank context <project>` prints what a skill needs in one place: approver, copy style, board names and statuses, critic setting, stop list, whether runs are allowed, and the Workflow line. Skills read it instead of hardcoding a name or a list.

## 3. The Workflow line (brief Phase 1)

`lib/version.mjs` produces `Bollplank <version>, build <n>`, for example `Bollplank 0.1.0, build 12`. The version comes from `package.json` and equals the release tag `v0.1.0`. The build is the number of commits on the Bollplank repo's base branch at the installed commit, so it grows by one per squash merge. Off the base branch it adds ` plus unmerged commits`, and with local changes `, with uncommitted changes`. Outside a checkout it says `build unknown`.

**Deviation, for Paul.** The brief's examples show `v0.3.1+4e5e3eb`. On 2 November, after approval, Paul asked for the kit's line to use a version and a build instead of a commit, because a commit is not human friendly. The plan follows that later direction for Bollplank too. The line still matches no build when the copy differs, which is what the brief's Done when requires.

## 4. The critic (brief Phase 2)

* **No board in the critic.** The lead reads the issue and its comments, writes a prompt file with the full subject, the earlier rounds and the responses, and calls `bollplank critic`. The critic returns text. The lead posts it and reads it back. The Linear preflight, the Linear tool allowlist and the `linear-preflight-failed` failure of `aw-critic` are not carried over.
* **Providers.** `lib/providers/claude.mjs` and `lib/providers/codex.mjs`, each with `resolve()`, `signInStatus()`, `review()`, `sessionFiles()` and `testedVersion`.
  * `resolve()`: a search of `PATH` in Node (no `/usr/bin/which`), then the macOS app bundles the kit knows today.
  * `signInStatus()`: `claude auth status --json` (logged in, first party, a subscription type) and `codex login status` (signed in with ChatGPT). A key based or third party sign in is reported, never used.
  * `review()`: Claude in print mode with stream JSON, its own session id, `--setting-sources local`, no MCP servers, and only read tools, with `--add-dir` for a source folder. Codex `exec` with JSON output, a read only sandbox, `forced_login_method="chatgpt"`, and the source folder as its working folder for code review. The prompt goes on stdin. Exact flags are checked against the installed versions (Claude Code 2.1.312, Codex 0.166) during implementation, and `aw-critic`'s unexplained `--approve-for-me` is dropped unless Codex documents it.
  * Every provider and key variable is removed from the child's environment, with the kit's pattern.
* **Critic choice.** `--critic other|same|claude|codex`, default from config. `other` means the provider that is not leading. Nothing ever switches the choice on its own. When the chosen provider is missing or not signed in, the call fails with `critic-unavailable`, and a selected review stage waits, as the kit's does today. `same` is used only when it was chosen: in config, by the approver for a ticket, or on the command line by the lead on the approver's word.
  * `init` offers `same` as the default when only one client is found, and says what that means. It never rewrites an existing `other` setting without asking.
  * A brief may name its critic in an optional header line of its own, `Critic: other|same|claude|codex`, under the Cross-model review line, whose format stays as it is. That approved choice wins over config for the ticket, and the critique skill refuses to run a different critic for it. Keeping it on its own line leaves the review check of the consulting and configuration helper (`^Cross-model review: <review>` followed by a period, a space or the end) working unchanged.
* **Same model mode.** A fresh session per ticket that inherits nothing, `prompts/critic-same.md` with a harder adversarial brief (find the strongest reason the subject fails, check every claim against the source, no credit for intent), and `critic.same.<provider>` for a different model or effort when the subscription offers one. The header reads `Reviewer: Claude Code, same provider, separate session`.
* **Sessions and rounds are separate.** One critic session per ticket, provider and mode is reused across subjects, so the critic remembers the brief when it reviews the plan. Rounds are counted per subject series: the lead passes `--subject brief|plan|code` and `--round n` from the board's comments, and the wrapper refuses with `round-mismatch` when its saved count for that ticket, provider, mode and series is not `n - 1`. A revised subject continues its series. The state file holds `{sessionId, rounds: {brief, plan, code}}`.
* **Results.** The kit's success rule (the reply starts with `Critique of ` and has a `Verdict:` line) and failure codes stay, plus `usage` for a missing prompt file instead of a crash. State goes to `~/.bollplank/critics/<TICKET>.<provider>[.same].json`. Every call with a session is bound in the ledger, failed calls too.
* **Prompts.** `prompts/critic.md` and `prompts/critic-same.md` with `{TICKET}`, `{ROUND}`, `{SUBJECT}`, `{SUBJECT_SHORT}`, `{DATE}`, `{ROUND_NOTE}`, `{REVIEWER}`, `{MODEL}`, `{WORKFLOW}`, `{BODY}` (the subject and history the lead assembled).

## 5. The board seam

Skills speak of "the issue", "a comment" and "the status Ready". `skills/bollplank-*/references/board-linear.md` maps each operation to the Linear MCP tools the lead has, the status names from config, the "Release notes" document, and the readback the consulting and configuration modes use. A later board adds one reference file and one `board.kind`. Nothing else changes.

## 6. Setup (brief Phase 3)

* **Install.** `git clone https://github.com/ppanotzki/bollplank ~/.bollplank/kit`, then `~/.bollplank/kit/install.sh`. The script checks git and Node, links `bin/bollplank` into `~/.local/bin` (and prints the line to add to the shell profile when that folder is not on `PATH`), then runs `bollplank init`.
* **`bollplank init`**, safe to run again, which is how it reconfigures:
  1. Finds Claude Code and Codex and their sign in. Warns when an API key variable is set in the shell, and explains that Bollplank removes it for critic calls.
  2. Probes Linear from each client with a live read: a short headless prompt that must call the client's Linear tool and list teams. A missing tool or a failed read offers to add the Linear MCP (`claude mcp add --transport http linear <url>`, `codex mcp add linear --url <url>` then `codex mcp login linear`). The person signs in in the browser. The URL is taken from Linear's documentation at implementation. Paul's setup, where Linear arrives through the claude.ai and ChatGPT connectors, passes the probe without changes.
  3. Chooses the team and project from the probe's list and checks the five statuses. Existing names are mapped. A missing status is created through the Linear tool after asking, or, when the tool cannot, the exact steps in Linear's settings are shown and the check repeats.
  4. Writes `config.json`, links each skill into `~/.claude/skills` and `~/.codex/skills`, records every link it made in `install.json`, and finishes with `doctor`.
* **Never replace.** A path that exists and is not a link into the kit is left alone and reported. Every link step is checked by a test with a pre-existing file and a foreign link.
* **`bollplank doctor`** checks Node, the Workflow line, `PATH`, the config, every recorded link, each client's subscription sign in, its tested version against the installed one, a live Linear read from each client, one critic dry run for each configured critic, and the ship lock. Each failure says what to do. `--offline` skips the model calls.
* **`bollplank update`** fetches tags, checks out the newest `v*` tag, relinks, and prints that release's changelog section. **`bollplank uninstall`** removes only the links in `install.json` and keeps the home unless `--purge` is confirmed.

## 7. Runs, shipping and the ledger (brief Phase 4)

* **`bollplank ticket`** ports `aw-ticket`: per repo base branch, node_modules cloned with `cp -c` on macOS and copied elsewhere, removal through Node instead of `rm`, and a rollback of worktrees made before a failed create.
* **`bollplank run`** ports `aw-run` and `lib/configuration-run.mjs`, with the approver regex built from `approver.name` and the readback check kept for `board.kind` linear. Repository mode checks the project's `runs` setting.
* **`bollplank turn`** ports `aw-turn` with the lock path from `shipLock` and the same holder record (`ticket`, `session`, `since`, `pid`). With Paul's `shipLock` set to `~/.agent-workflow/ship.lock`, a turn held by either kit blocks the other. The `release` crash on a lock without a holder is fixed.
* **`bollplank merge`** ports `aw-merge` with the project's base branch, JSON output for `gh` errors, and the plan gate checked as well as the code gate.
* **`bollplank deploy-wait <project> <repo> <commit>`** reads the repo's `deploy`:
  * `none` returns at once
  * `command` runs the configured command with `{commit}` and uses its exit code
  * `amplify` waits for the job that built the commit, with app, branch, region and AWS profile from config, as `aw-deploy-wait` does
  * `github-actions` waits for the named workflow's run on the merge commit through `gh run list --commit`.
* **`bollplank ledger`** ports `aw-ledger` with `~/.bollplank/ledger`, both markers (`bollplank ledger mark` and `aw-ledger mark`), session folders from the providers, and a "Sessions that used both kits" section listing any session with markers from both.
* **Skills.** `bollplank-brief`, `-critique`, `-address`, `-approve`, `-run` (with `references/consulting.md`, `references/configuration.md`, `references/board-linear.md`), `-ship` and `-accept`. They carry the kit's rules and templates with the approver, copy style, stop list and statuses from `bollplank context`, the Workflow line from `bollplank version`, and no project names. `-ship` follows the project's `shipOrder` and each repo's deploy kind instead of the kit's fixed order for one project. `-accept` keeps the folder for consulting and configuration runs, as their references already say.
* **Parity list.** `docs/parity.md` maps every part of agent-workflow (8 commands, 7 skills, 3 run modes, the gate) to its Bollplank equivalent and the test that proves it.

## 8. The gate and tests

`scripts/check.mjs` runs:

1. `node --check` on every file in `bin/`, `lib/` and `scripts/`
2. skill frontmatter, with names starting `bollplank-`
3. prompt placeholders
4. the example config against the schema
5. all tests
6. the private name check.

**Private name check.** The names to look for cannot be listed in a public repo without publishing them. The check reads them from `$BOLLPLANK_PRIVATE_NAMES` (a repository secret in CI) or `~/.bollplank/private-names.txt` locally, and searches every tracked file and the full history of the candidate commit.

* It has three outcomes: `passed`, `failed` and `skipped`, and only `passed` lets Bollplank's own gate pass. Without the list the result is `skipped`, and the gate fails with a clear message. A pull request from a fork therefore gets a failing check until a maintainer runs it with the list, and cannot be merged before that. This gate is Bollplank's own, in its own repo. Users' projects have their own gates.
* **Only projects that ask for it are scanned at merge.** A project's config may set `"privateScan": true`. For such a project `bollplank merge` runs the scan itself, with the local list, against the PR's head commit and its history before it merges, and refuses on `failed` or `skipped`. Paul's config sets it for the `bollplank` project. A project without it merges on its checks and review stages alone, as in the kit, so a new user with no list is never blocked.
* Making the repo public, which stays Paul's step, is preceded by a full history scan with the list, and its result is recorded in the run log.
* **Before the first code commit**, the lead writes Paul's list to `~/.bollplank/private-names.txt` on this Mac and sets the same list as the `BOLLPLANK_PRIVATE_NAMES` secret in the private repo, so every commit of this ticket is scanned from the start. The plan commit and the skeleton already on the branch are scanned then too. The list later moves into Paul's private config repo.

**Tests**, all synthetic, with fake `claude`, `codex`, `gh`, `git` remotes and `aws` on a temporary `PATH`:

* every kit test, ported
* new tests for what the kit never tested: `ticket`, `turn` (including an agent-workflow holder blocking Bollplank and the reverse), `merge`, `deploy-wait` per kind, the Codex critic path, same mode, `round-mismatch`, `init` and `doctor` against fake clients, the never replace rule, `uninstall`, `update`, the Workflow line, the mixed kit ledger case from the brief, and the private name check with a planted name in a file and in history.

CI runs the gate on Ubuntu, macOS and Windows with Node 20 and 22. Tests that need macOS only behaviour skip elsewhere and say why.

## 9. Docs and the GitHub page (brief Phase 5)

* **README**, in the brief's order: what it is with a link to the article, a Mermaid diagram of the loop (GitHub renders it), one complete synthetic ticket (Acme, brief, critique, response, approval) labelled as an illustration, a five minute quickstart, and a FAQ on subscriptions, credentials and same model mode. It states plainly that Bollplank drives the person's own Claude and ChatGPT subscriptions from scripts, that they run it on their own accounts, and what it never does with keys.
* `docs/`: `setup.md`, `config.md`, `commands.md`, `skills.md`, `same-model.md`, `runs.md`, `parity.md`, `windows.md` (untested beyond CI).
* `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, `.github/ISSUE_TEMPLATE/` for bugs and requests, and a note on taking an issue into the Linear project with links both ways.

## 10. Order of work

1. **Core**, by the lead: `args`, `paths`, `config` with schema and example, `version`, `context`, the dispatcher, the gate skeleton.
2. **In parallel**, one subagent each, after the core is committed:
   * critic and providers
   * ticket, run, turn, merge and deploy-wait
   * ledger
   * init, doctor, update, uninstall and `install.sh`
   * skills and prompts
3. **Then:** docs and the README, CI matrix, private name check, parity list.
4. **Review, test and hunt**, then the code gate on the head commit, then one PR.

## 11. Shipping and the stops

* **Ship.** Inside the shipping turn, `aw-merge bollplank bollplank <pr> --run ~/Work/Tools/Tickets/NEO-182` after the checks and the code gate. The `--run` folder makes `aw-merge` enforce the selected code stage and record the PR, final head and merge commit, which `aw-ticket remove` needs at acceptance to recognise the squash merged branch. Then tag `v0.1.0` and a GitHub release in the private repo, recorded with `aw-run deploy ... --kind merge`. No deploy beyond that.
* **Stops for Paul**, recorded with `aw-run log` and asked in the session:
  1. Reading the current Claude and ChatGPT terms on scripted subscription use before the repo goes public. The README wording waits for his reading.
  2. Making the repo public, or inviting the friend as a collaborator for the acceptance test.
  3. The private config repo for his own settings, created as `ppanotzki/bollplank-config`, private, only on his go. It holds his projects, the shared lock path and the private names list.
  4. His switch: installing Bollplank on his Mac, then his next tickets in the order the brief gives.
  5. The friend's install and real use, and what he gets stuck on.
* **Acceptance.** Every Done when line is checked against evidence. Done when lines that need Paul's own later tickets or the friend are reported with their state, and the issue moves to Acceptance only when they are met.

## 12. Acceptance cases

* `bollplank init` on a clean temporary home with fake clients writes a valid config and links, and leaves an existing file and a foreign link untouched.
* `bollplank critic --critic same` with only a fake Claude produces a labelled same provider critique, and `--critic other` with both fakes picks the other provider.
* `--critic other` with only one fake client fails with `critic-unavailable` and leaves the selected stage incomplete. It never runs `same` on its own.
* One ticket's critic goes through brief rounds 1 and 2, plan round 1 and code round 1 in one reused session without a `round-mismatch`, and a skipped or repeated round in a series is refused.
* Bollplank's gate with no private names list reports `skipped` and fails. For a project with `privateScan`, `bollplank merge` refuses a PR whose scan is `skipped` or `failed`. A project without it merges on green checks and complete stages with no list present.
* An approved brief with a `Critic: same` line initializes a consulting run and a configuration run, and a brief whose Cross-model review value differs from the requested one is still refused in both.
* This ticket's own merge records the PR, final head and merge commit in its run record, and `aw-ticket remove` accepts the folder afterwards.
* A synthetic repository run goes through plan, gates, merge refusal before the code gate, merge after it, and each deploy kind.
* A synthetic ledger with one session marked by `aw-ledger mark` then `bollplank ledger mark` splits correctly and is reported as using both kits.
* An agent-workflow holder record in the shared lock path stops `bollplank turn take`, and a Bollplank holder stops a fake `aw-turn take` reading the same folder.
* The private name check fails on a planted name in a file and in history, and passes when clean.
* The gate passes on Ubuntu, macOS and Windows in CI.
