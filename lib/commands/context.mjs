// bollplank context [<project>]
// Everything a skill needs in one place: the approver, copy style, board names and statuses, the
// critic setting, the Workflow line and, for a project, its mode, runs, stop list and repos.
// Skills read this instead of naming a person, a project or a list themselves.
import { parse } from '../args.mjs';
import { loadConfig, loadProject } from '../config.mjs';
import { emit, fail } from '../out.mjs';
import { workflowLine } from '../version.mjs';

export const usage = 'bollplank context [<project>]';

export function run(argv) {
  const { positional, error } = parse(argv, {});
  if (error || positional.length > 1) fail('usage', error ?? usage);
  const config = loadConfig();
  const result = {
    ok: true,
    workflow: workflowLine(),
    approver: config.approver.name,
    copyStyle: config.copyStyle,
    board: config.board,
    critic: config.critic,
    projects: Object.keys(config.projects),
  };
  if (positional[0]) {
    const pr = loadProject(config, positional[0]);
    result.project = {
      name: pr.name,
      mode: pr.mode,
      runs: pr.runs,
      stopList: pr.stopList,
      board: pr.board ?? {},
      repos: Object.keys(pr.repos),
      shipOrder: pr.shipOrder ?? Object.keys(pr.repos),
      privateScan: pr.privateScan,
      source: pr.source,
      tickets: pr.tickets,
    };
  }
  emit(result);
}
