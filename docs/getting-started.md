# Getting started

This guide takes you from nothing to a first approved ticket, `ACME-1`, on a Mac. It takes about half an hour. The names Acme, `ACME` and `acme-shop` are examples. Use your own.

## What you need

- Node 20 or later and git. `xcode-select --install` gives you git.
- Claude Code and Codex, each signed in with a subscription: `claude auth login` with a Claude account, `codex login` with ChatGPT. With only one of them, the critic is the same model in a separate session (see [same-model.md](same-model.md)).
- While the Bollplank repo is private, an invite to it, and git signed in to GitHub. `brew install gh`, then `gh auth login`, does that. Without them the clone in section 3 fails with `could not read Username`.
- Codex may be only inside the ChatGPT app, with no `codex` command in your terminal. Bollplank finds it there. Doctor's `path.codex` warning then gives the line that puts it on your `PATH`, so the `codex` commands in its fixes run as typed.

## 1. Linear

1. Sign up at [linear.app](https://linear.app). The free plan is enough.
2. Use the team Linear made with the workspace, or add one in Settings, Teams. This guide uses a team named Acme with the key `ACME`.

A new team has the statuses Backlog, Todo, In Progress, Done and Canceled. Bollplank also suggests Draft, Ready and Acceptance. You add those when init asks for the statuses, in its step 3 (section 4 below).

## 2. A project folder

Bollplank works on a project with at least one git repo. An empty one will do:

```sh
mkdir -p ~/Code/acme/acme-shop && git -C ~/Code/acme/acme-shop init
```

## 3. Install

```sh
git clone https://github.com/ppanotzki/bollplank ~/.bollplank/kit && ~/.bollplank/kit/install.sh
```

The script links `bollplank` into `~/.local/bin` and starts `bollplank init`, which section 4 walks through.

On a new Mac `~/.local/bin` is not on your `PATH`, and the skills call `bollplank context` in every session. So when init is done, before section 5:

1. Add the line the script printed, `export PATH="$HOME/.local/bin:$PATH"`, to the file it named, such as `~/.zshrc`.
2. Open a new terminal.
3. Run `bollplank version`. It prints the version and the build. If the command is not found, check the line and the file, then open another new terminal.

## 4. `bollplank init`

Init asks one question at a time. A value in brackets is the default, which Enter takes.

**Step 1** finds Claude Code and Codex and their sign in.

**Step 2** reads Linear from each client. When a client cannot, answer `y` to add Linear's MCP server. A browser opens for the Linear sign in.

**Step 3** asks for the team, the project and the statuses.

- Team: pick `ACME`.
- Project: type `Acme Shop`. Init says it is not a project of ACME yet and offers `other`, `session` or `linear`. Pick `session`. Init prints the sentence to type. Open a second terminal, start `claude` or `codex`, and type it:

  ```text
  Create the Linear project Acme Shop in team ACME
  ```

  Check the team and the name in the call your client shows, and let it run. Back in init, press Enter. Init reads Linear again and finds the project. Init itself never writes to Linear.
- Statuses: init lists the team's statuses and asks which one stands for each workflow state. Press Enter to take the suggestion. For Draft, Ready and Acceptance it says the status is missing and how to add it. In Linear, open Settings, Teams, Acme, Workflow, and add:
  - Draft under Backlog
  - Ready under Unstarted
  - Acceptance under Started

  Then answer `y` to "Check Linear again now?". Init reads the team again and takes the status. To map a state to a status you have instead, type its name, such as `Todo`.

**Step 4** asks for your name as the approver, the copy style and the critic. Take `other` with both clients, `same` with one.

**Step 5** adds a project. Answer `y`, then:

- Source folder: `~/Code/acme/acme-shop`. Name and tickets folder: Enter, which names the project `acme-shop`.
- Linear team and project: Enter takes ACME and Acme Shop. Statuses: `board`.
- GitHub repo: its `owner/name`. Without one yet, type your GitHub user and the folder name, such as `ada/acme-shop`. It matters only for runs.
- Base branch: Enter. Deploy: `none`. Runs: `n`.
- Checks: Enter takes the check names init read from the repo's pull requests. An empty repo has none yet, so type a placeholder name such as `checks`. Runs stay off in this guide, so nothing uses it for now. Before you turn runs on, set it to a check that really runs on the repo's pull requests.

**Steps 6 and 7** save `~/.bollplank/config.json`, link the skills into Claude Code and Codex, and run `bollplank doctor`. Every required check should say `ok`. Each failure comes with a `Fix:` line.

## 5. A first ticket

Start a session in the project:

```sh
cd ~/Code/acme/acme-shop && claude
```

Codex works the same way. Ask in plain words:

1. **Brief.** `Write a brief for a new acme-shop ticket: customers can cancel unpaid orders.` The lead creates the issue, here `ACME-1`, writes Brief v1 in its description and sets it to Draft.
2. **Critique.** `Critique ACME-1.` The lead calls `bollplank critic`. The other client reads the issue and its comments and posts "Critique of brief v1" as a comment. It can take a few minutes. A Codex lead asks to run the command outside its sandbox. Allow it.
3. **Address.** `Address it.` The lead sorts each point into fix, flag or drop, writes Brief v2 and posts its response.
4. **Another round**, if the lead suggests one: `Critique ACME-1.` A round that comes back `Verdict: Approve` ends the rounds.
5. **Approve.** `I approve brief v2.` Only the approver's own words count. The lead posts the approval, updates the Approval line and moves `ACME-1` to Ready.

Every step shows up on the issue in Linear.

## Next

- Turn on runs to take an approved ticket from plan to shipped: [runs.md](runs.md).
- Use a team and project you already have: [existing-project.md](existing-project.md).
- When something fails, run `bollplank doctor`. [setup.md](setup.md) lists the failures.
