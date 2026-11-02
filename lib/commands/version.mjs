// bollplank version [--json]
// Prints the Workflow line, for example "Bollplank 0.1.0, build 12". Skills and the critic take
// the line from here and never write it by hand.
import { parse } from '../args.mjs';
import { emit, fail, say } from '../out.mjs';
import { workflowLine } from '../version.mjs';

export const usage = 'bollplank version [--json]';

export function run(argv) {
  const { opts, positional, error } = parse(argv, { json: 'bool' });
  if (error || positional.length) fail('usage', error ?? usage);
  if (opts.json) emit({ ok: true, workflow: workflowLine() });
  say(workflowLine());
}
