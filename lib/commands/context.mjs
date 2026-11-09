// bollplank context [<project>]
// Everything a skill needs in one place: the approver, copy style, board names and statuses, the
// critic setting, the Workflow line and, for a project, its mode, runs, stop list, repos and the
// critic default that applies to it.
// Skills read this instead of naming a person, a project or a list themselves. With a project,
// board.team, board.project and board.statuses are that project's own, with the top level ones
// filled in, so a project in another team keeps its names. board.kind is the project's resolved
// kind, and a project whose kind differs from the top level takes nothing from the top level board.
import { parse } from '../args.mjs';
import { loadConfig, loadProject, projectCritic } from '../config.mjs';
import { emit, fail } from '../out.mjs';
import { kindOf } from '../boards.mjs';
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
    // Each project's board kind, team, project, statuses and space when set, so a skill can find
    // which project an issue belongs to.
    boards: Object.fromEntries(Object.entries(config.projects).map(([n, pr]) => [n, effectiveBoard(config, n, pr)])),
  };
  if (positional[0]) {
    const pr = loadProject(config, positional[0]);
    const board = effectiveBoard(config, pr.name, pr);
    result.board = board.kind === config.board.kind ? { ...config.board, ...board } : board;
    result.project = {
      name: pr.name,
      mode: pr.mode,
      runs: pr.runs,
      stopList: pr.stopList,
      board: { ...(pr.board ?? {}), ...board },
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

// A project's board kind, team, project, statuses and space: its own, else the top level ones when
// the project's kind is the top level kind. A board of another kind takes nothing from the top level.
function effectiveBoard(config, name, pr) {
  const kind = kindOf(config, name);
  const top = kind === config.board.kind ? config.board : {};
  const space = pr.board?.space ?? top.space;
  return { kind, team: pr.board?.team ?? top.team ?? null, project: pr.board?.project ?? top.project ?? null, statuses: pr.board.statuses, ...(space !== undefined ? { space } : {}) };
}
