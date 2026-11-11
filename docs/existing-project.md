# An existing project

Bollplank can use a Linear team and project, or a Jira project, you already have, with the statuses you already use. Run `bollplank init`, choose the board kind in step 2 and pick them in step 3. Nothing on the board changes.

## Map the five states

Init lists the team's statuses and asks which one stands for each workflow state. For a team with Backlog, Todo, In Progress, In Review and Done:

| State | Means | Status |
|---|---|---|
| `draft` | The brief is being written and critiqued. | Backlog |
| `ready` | The approver approved the brief. | Todo |
| `inProgress` | The ticket is being worked on. | In Progress |
| `acceptance` | Shipped, waiting for the acceptance test. | In Review |
| `done` | Accepted. | Done |

Init saves each name as the board spells it, in `board.statuses` of `~/.bollplank/config.json`. A Jira project with To Do, In Progress, In Review and Done can map `draft` and `ready` to To Do statuses, `acceptance` to In Review, and so on, in the same way.

## A project in another team

In step 5, pick the project's own board kind, team and project. When the team differs from step 3's, init maps that project's statuses by default. They are saved with the project:

```json
"acme-ops": {
  "board": {
    "team": "OPS",
    "project": "Operations",
    "statuses": { "draft": "Backlog", "ready": "Planned", "inProgress": "In Progress", "acceptance": "Verify", "done": "Done" }
  }
}
```

In a mapping you edit by hand, a state you leave out takes the top level `board.statuses`, then the kind's suggestion.

## A project on the other board

A project can use Jira in a Linear setup, or Linear in a Jira setup. In step 5, answer its board kind. When init has not read that board yet, it reads it then and offers to add its MCP server. A project of another kind than the top level takes nothing from the top level board, so it sets its own team, project and all five statuses:

```json
"acme-ops": {
  "board": {
    "kind": "jira",
    "team": "acme.atlassian.net",
    "project": "ACM",
    "space": "ACM",
    "statuses": { "draft": "Draft", "ready": "Ready", "inProgress": "In Progress", "acceptance": "Acceptance", "done": "Done" }
  }
}
```

On Jira, `team` is the site and `project` the project key. `space` is the optional Confluence space key for the release notes. [config.md](config.md#boards-of-two-kinds) has the rules.

## Change it later

Run `bollplank init` again. Every earlier answer is the default, and init asks before it saves, keeping the old file as `config.json.bak`.

- Step 3 changes the board's team, project and statuses.
- To change a project, add it again in step 5 with the same name and answer `y` to replace it. Init then asks every question about that project again, with your earlier answers as the defaults, so Enter keeps a setting. Settings init does not ask about, such as `shipOrder` or `cloneNodeModules`, are kept.
- Init sets up repository projects only. A consulting or configuration project of the same name is kept as it is, unless you answer `y` to replace it with a new repository project. Edit those projects by hand ([runs.md](runs.md#consulting-and-configuration-runs)).
- For one name, editing `~/.bollplank/config.json` by hand is quicker. Run `bollplank doctor` after.

## When a name is wrong

`bollplank doctor` reads each board the config uses from each client and compares every team, project and status name exactly. On Jira it also checks the site, the cloud id, the numeric project id and the space when one is set. A name the board does not have fails with the key to change:

```text
  FAIL  Linear status Verify: OPS has no status named "Verify" that Claude Code can read
        Fix: Open Linear, go to Settings, then Teams, then OPS, then Workflow. Under Started, add a status named "Verify". Or set projects.acme-ops.board.statuses.acceptance in the config to a status that exists.
```

A name that differs only in case fails with the board's spelling to put in the config. For a missing Jira status the fix gives the steps in the Jira project's settings, under Workflows. A missing project fails with `projects.<name>.board.project`, or `board.project` when the name comes from the top level. A status a project takes from the top level is fixed in the top level `board.statuses`, unless the project is in another team. Then the fix names the project's own key, so the board's team keeps its names. The top level statuses only warn while no project takes a name from them.
