// bollplank context [<project>]
// Everything a skill needs in one place: the approver, copy style, board names and statuses, the
// critic setting, the Workflow line and, for a project, its mode, runs, stop list, repos and the
// critic default that applies to it.
// Skills read this instead of naming a person, a project or a list themselves. With a project,
// board.statuses is that project's own mapping, so a project in another team keeps its names.
import { parse } from '../args.mjs';
import { loadConfig, loadProject, projectCritic } from '../config.mjs';
import { emit, fail } from '../out.mjs';
import { workflowLine } from '../version.mjs';
import { kitDir } from '../paths.mjs';

export const usage = 'bollplank context [<project>]';

export function run(argv) {
  const { positional, error } = parse(argv, {});
  if (error || positional.length > 1) fail('usage', error ?? usage);
  const config = loadConfig();
  const result = {
    ok: true,
    workflow: workflowLine(),
    kit: kitDir,
    approver: config.approver.name,
    copyStyle: config.copyStyle,
    board: config.board,
    critic: config.critic,
    projects: Object.keys(config.projects),
    // Each project's board team, project and statuses, so a skill can find which project an issue
    // belongs to.
    boards: Object.fromEntries(Object.entries(config.projects).map(([n, pr]) => [n, { team: pr.board?.team ?? config.board.team ?? null, project: pr.board?.project ?? config.board.project ?? null, statuses: pr.board.statuses }])),
  };
  if (positional[0]) {
    const pr = loadProject(config, positional[0]);
    result.board = { ...config.board, statuses: pr.board.statuses };
    result.project = {
      name: pr.name,
      mode: pr.mode,
      runs: pr.runs,
      stopList: pr.stopList,
      board: { team: config.board.team ?? null, project: config.board.project ?? null, ...(pr.board ?? {}) },
      repos: Object.keys(pr.repos),
      shipOrder: pr.shipOrder ?? Object.keys(pr.repos),
      privateScan: pr.privateScan,
      // The project's own critic default wins over the config's. A brief's approved Critic: line
      // still wins over both for its ticket.
      critic: projectCritic(config, pr),
      source: pr.source,
      tickets: pr.tickets,
    };
  }
  emit(result);
}
