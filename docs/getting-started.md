# Getting started

This guide takes you from nothing to a first approved ticket, `ACM-1`, on a Mac. It takes about half an hour. The names Acme, `ACM` and `acme-shop` are examples. Use your own.

You use Terminal twice, to make a folder and to install. Everything else happens in the Claude app and in Linear.

## What you need

- Node 20 or later and git. `xcode-select --install` gives you git.
- Claude Code and Codex, each signed in with a subscription: `claude auth login` with a Claude account, `codex login` with ChatGPT. With only one of them, the critic is the same model in a separate session (see [same-model.md](same-model.md)).
- While the Bollplank repo is private, an invite to it, and git signed in to GitHub. When the GitHub CLI is signed in, `gh auth setup-git` does that. Otherwise run `brew install gh`, then `gh auth login`. Without them the clone in section 3 fails with `could not read Username`.
- Codex may be only inside the ChatGPT app, with no `codex` command in your terminal. Bollplank finds it there. Doctor's `path.codex` warning then gives the line that puts it on your `PATH`.

## 1. A Linear team

1. Sign up at [linear.app](https://linear.app). The free plan is enough.
2. Click the workspace name at the top left, then **Settings**. Under **Teams**, add a team named **Acme**. Keep the key Linear suggests, here **ACM**.
3. Rename the status **Backlog** to **Inbox**, where ideas wait until one gets a brief. Still in **Settings**, click **Teams**, **Acme**, then **Workflow**. Click the three dots next to Backlog, choose **Edit**, type `Inbox` and save.
4. Leave the other statuses as they are. Init tells you which ones to add, in section 4.

## 2. A project folder

Bollplank works on a project with at least one git repo. This folder stands in for your project's code, and an empty repo will do.

1. Open Terminal: press **Cmd+Space**, type `Terminal`, press **Return**.
2. Run:

   ```sh
   mkdir -p ~/Code/acme/acme-shop && git -C ~/Code/acme/acme-shop init
   ```

It prints `Initialized empty Git repository in .../acme-shop/.git/`.

## 3. Install

In Terminal, run:

```sh
git clone https://github.com/ppanotzki/bollplank ~/.bollplank/kit && ~/.bollplank/kit/install.sh
```

The script links `bollplank` into `~/.local/bin` and starts `bollplank init`. Leave Terminal open for section 4.

If the script says `~/.local/bin` is not on your `PATH`, add the line it printed to the file it named, such as `~/.zshrc`. Once init is done, open a new Terminal window and run `bollplank version` to check.

## 4. `bollplank init`

Init asks one question at a time in Terminal. A value in brackets is the default, which Return takes.

**Step 1** finds Claude Code and Codex and their sign in. Nothing to answer.

**Step 2** reads Linear from each client. This takes a minute or two.

- If a browser opens and asks you to authorize Linear for Claude Code or Codex, click **Authorize**, then go back to Terminal.
- If init asks to add Linear's MCP server to a client, answer `y`. A browser opens for the Linear sign in.

**Step 3** asks for the team, the project and the statuses.

1. **Team.** Pick `ACM`.
2. **Project.** Init says ACM has no projects yet. Type `Acme Shop`. Init offers `other`, `session` or `linear`. Press Return to take `session`. Init prints a sentence and waits. Leave Terminal waiting.
3. **Create the project in the Claude app.**
   1. Open the Claude app, click **Code**, and start a new session.
   2. Choose the folder: press **Cmd+Shift+G**, type `~/Code/acme/acme-shop`, press **Return**, then click **Open**.
   3. Send: `Create the Linear project Acme Shop in team ACM`
   4. If the app asks you to allow the call, check that it names the team ACM and the project Acme Shop. Otherwise check that the reply names them.
   5. Back in Terminal, press Return. Init says `Found the project Acme Shop in ACM now.`
4. **Statuses.** Init lists the team's statuses, says which ones are missing and how to add them. Before you answer:
   1. In Linear, click the workspace name, then **Settings**, **Teams**, **Acme**, **Workflow**.
   2. With the **+** next to each group's name, add **Draft** in the Backlog group under Inbox, **Ready** in Unstarted and **Acceptance** in Started.
   3. Back in Terminal, press Return at the draft question. Init says Draft is not there yet. Answer `y` to check Linear again, and it finds it.
   4. Press Return for each of the other four.

**Step 4** asks for you and the critic.

- **Approver:** Return takes your name from git. Type another if you want, since only the approver's own words approve a brief.
- **Copy style:** how the agents write. Return takes the default.
- **Critic:** Return takes `other`, so the model not leading reviews. With one client, type `same`.

**Step 5** adds a project. Press Return for `Y`, then:

1. **Source folder:** type `~/Code/acme/acme-shop`. Init says the folder above it is the source folder and `acme-shop` its repo.
2. **Name** and **tickets folder:** Return for each.
3. **Linear team** and **project:** Return takes ACM and Acme Shop.
4. **Statuses:** Return takes `board`, the ones you mapped in step 3.
5. **GitHub repo:** its `owner/name`, such as `ada/acme-shop`. It need not exist yet. Bollplank uses it only in runs.
6. **Base branch:** Return.
7. **Runs:** Return takes `N`. With runs off, init does not ask for checks or a deploy. It asks for them when you turn runs on later.

**Steps 6 and 7** save `~/.bollplank/config.json`, link the skills into Claude Code and Codex, and run `bollplank doctor`. Doctor starts both clients for some checks, which takes a few minutes. It prints each one as it starts. Every check should say `ok`, except perhaps the `codex on PATH` warning. Each failure comes with a `Fix:` line.

## 5. A first ticket

In the Claude app, click **Code** and start a new session in the project folder: press **Cmd+Shift+G**, type `~/Code/acme/acme-shop`, press **Return**, then click **Open**. Then send these one at a time, and wait for each to finish:

1. **Brief.** `Write a brief for a new acme-shop ticket: add a README that names the shop and says what it sells.` The lead creates `ACM-1`, writes Brief v1 in its description and sets it to Draft.
2. **Critique.** `Critique ACM-1.` The lead calls `bollplank critic`. If the app asks to allow that command, allow it. The other client reads the issue and its comments and posts "Critique of brief v1" as a comment. It can take a few minutes.
3. **Address.** `Address it.` The lead sorts each point into fix, flag or drop, writes Brief v2 and posts its response. When the brief has open questions, answer them in the same message.
4. **Another round**, if the lead suggests one: `Critique ACM-1.` A round that comes back `Verdict: Approve` ends the rounds.
5. **Approve.** `I approve brief v2.`, with the version the lead names. Only the approver's own words count. The lead posts the approval, updates the Approval line and moves `ACM-1` to Ready.

Every step shows up on the issue in Linear. Codex works the same way in the ChatGPT app. It asks to run `bollplank critic` outside its sandbox. Allow it.

## Next

- Turn on runs to take an approved ticket from plan to shipped: [runs.md](runs.md).
- Use a team and project you already have: [existing-project.md](existing-project.md).
- When something fails, run `bollplank doctor`. [setup.md](setup.md) lists the failures.
