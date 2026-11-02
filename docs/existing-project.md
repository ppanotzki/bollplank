# An existing project

Bollplank can use a Linear team and project you already have, with the statuses you already use. Run `bollplank init` and pick them in step 3. Nothing in Linear changes.

## Map the five states

Init lists the team's statuses and asks which one stands for each workflow state. For a team with Backlog, Todo, In Progress, In Review and Done:

| State | Means | Status |
|---|---|---|
| `draft` | The brief is being written and critiqued. | Backlog |
| `ready` | The approver approved the brief. | Todo |
| `inProgress` | The ticket is being worked on. | In Progress |
| `acceptance` | Shipped, waiting for the acceptance test. | In Review |
| `done` | Accepted. | Done |

Init saves each name as Linear spells it, in `board.statuses` of `~/.bollplank/config.json`.

## A project in another team

In step 5, pick the project's own team and Linear project. When the team differs from step 3's, init maps that project's statuses by default. They are saved with the project:

```json
"acme-ops": {
  "board": {
    "team": "OPS",
    "project": "Operations",
    "statuses": { "draft": "Backlog", "ready": "Planned", "inProgress": "In Progress", "acceptance": "Verify", "done": "Done" }
  }
}
```

In a mapping you edit by hand, a state you leave out takes the top level `board.statuses`, then Linear's suggestion.

## Change it later

Run `bollplank init` again. Every earlier answer is the default, and init asks before it saves, keeping the old file as `config.json.bak`.

- Step 3 changes the board's team, project and statuses.
- To change a project, add it again in step 5 with the same name and answer `y` to replace it. Init then asks every question about that project again.
- For one name, editing `~/.bollplank/config.json` by hand is quicker. Run `bollplank doctor` after.

## When a name is wrong

`bollplank doctor` reads Linear from each client and compares every team, project and status name exactly. A name Linear does not have fails with the key to change:

```text
  FAIL  Linear status Verify: OPS has no status named "Verify" that Claude Code can read
        Fix: Open Linear, go to Settings, then Teams, then OPS, then Workflow. Under Started, add a status named "Verify". Or set projects.acme-ops.board.statuses.acceptance in the config to a status that exists.
```

A name that differs only in case fails with Linear's spelling to put in the config. A missing project fails with `projects.<name>.board.project`, or `board.project` when the name comes from the top level.
