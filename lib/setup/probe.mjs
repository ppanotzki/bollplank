// The Linear probe both providers run: one fixed prompt, and one judgement of what came back.
// The probe passes only when a Linear tool call really happened and returned what the reply
// claims. A reply that only says it found teams, with no tool call behind it, fails.

// Linear's official remote MCP server, from https://linear.app/docs/mcp (read on 2 November 2026).
// The page names https://mcp.linear.app/mcp for Streamable HTTP and calls the /sse URL a
// deprecated fallback.
export const LINEAR_MCP_URL = 'https://mcp.linear.app/mcp';

export const LINEAR_PROBE_PROMPT = [
  'This is a Bollplank setup check.',
  'Use your Linear tool to list the teams in the Linear workspace you are signed in to.',
  'For each team, also list its issue statuses and its projects with the same tool.',
  'Only read. Change nothing in Linear and use no other tool.',
  'Reply with one JSON object and no other text, in this shape:',
  '{"teams":[{"key":"KEY","name":"Team name","statuses":["Status name"],"projects":["Project name"]}]}',
  'If you have no Linear tool or a call fails, reply {"error":"what happened"}.',
].join('\n');

// The probe may only read. A tool counts as a read tool when the first word of its own name, after
// a leading "linear", is one of these: list_teams, get_issue and linear_search_documentation do,
// save_issue and create_comment do not.
export const READ_VERBS = ['list', 'get', 'search', 'read'];

// The tool's own name from a client's full name: mcp__<server>__<tool> for Claude Code, and
// <server>/<tool>[/<connector>...] as the Codex probe joins it.
export function toolPart(name) {
  const s = String(name ?? '');
  if (s.includes('__')) return s.split('__').at(-1);
  if (s.includes('/')) return s.split('/')[1] ?? '';
  return s;
}

// The server or connector a tool belongs to, from the same full names. A built in tool has none.
export function serverPart(name) {
  const s = String(name ?? '');
  if (s.includes('__')) return s.split('__').slice(1, -1).join('__');
  if (s.includes('/')) return s.split('/').filter((_, i) => i !== 1).join('/');
  return '';
}

// A Linear read tool: a tool of a server or connector whose name says Linear, with a read verb.
export function isLinearRead(name) {
  return /linear/i.test(serverPart(name)) && isReadTool(name);
}

export function isReadTool(name) {
  const words = toolPart(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words[0] === 'linear') words.shift();
  return READ_VERBS.includes(words[0]);
}

// From a client's list of tool names, the ones a probe may allow: tools of a Linear server or
// connector whose names say list, get, search or read. Everything else stays denied.
export function readOnlyLinearTools(names) {
  return [...new Set((names ?? []).filter((n) => typeof n === 'string' && isLinearRead(n)))];
}

// The Linear tools the Codex probe allows by name, the reads the probe prompt needs. Codex takes
// an allow list per MCP server (enabled_tools), so every other tool of the server is off.
export const CODEX_LINEAR_READ_TOOLS = ['list_teams', 'get_team', 'list_issue_statuses', 'get_issue_status', 'list_projects', 'get_project'];

// calls: every tool call the client made, as { name, ok, text }. reply: the client's final text.
// The tool is found by its Linear purpose in its server's name, since it may come from a
// configured MCP server or from the client's account connectors, whose names differ.
export function judge(label, calls, reply) {
  // Any call that is not a Linear read fails the probe, whatever its service or result, since a
  // probe must not be able to change anything.
  const others = [...new Set(calls.filter((c) => !isLinearRead(c.name)).map((c) => c.name || 'an unnamed tool'))];
  if (others.length) return { ok: false, tools: others, detail: `${label} called ${others.join(', ')}, which ${others.length === 1 ? 'is' : 'are'} not a Linear read. The probe allows only Linear tools that list, get, search or read.` };
  const linear = calls;
  if (!linear.length) return { ok: false, detail: `${label} made no Linear tool call. It has no Linear tool, or the tool is not allowed in a headless call.` };
  const good = linear.filter((c) => c.ok && c.text.trim());
  const tools = [...new Set(linear.map((c) => c.name))];
  if (!good.length) return { ok: false, tools, detail: `${label} called ${tools.join(', ')}, but the call failed: ${short(linear.find((c) => c.text)?.text ?? 'no result')}` };
  const answer = jsonIn(reply);
  if (!answer) return { ok: false, tools, detail: `${label} called its Linear tool but did not reply with the JSON the probe asks for.` };
  if (answer.error) return { ok: false, tools, detail: `${label} reported: ${short(String(answer.error))}` };
  // Only what the tool really returned counts, so a name the model added on its own is dropped,
  // and every name is spelled as the tool returned it, never as the model wrote it, since the
  // workflow looks statuses up by their exact name.
  const raw = good.map((c) => c.text).join('\n');
  const lower = raw.toLowerCase();
  const canonical = (s) => {
    if (typeof s !== 'string' || s.trim() === '') return null;
    if (raw.includes(s)) return s;
    const at = lower.indexOf(s.toLowerCase());
    if (at < 0) return null;
    const exact = raw.slice(at, at + s.length);
    return exact.toLowerCase() === s.toLowerCase() ? exact : null;
  };
  const names = (list) => [...new Set((Array.isArray(list) ? list : []).map(canonical).filter(Boolean))];
  const teams = (Array.isArray(answer.teams) ? answer.teams : [])
    .filter((t) => t && (canonical(t.key) || canonical(t.name)))
    .map((t) => ({
      key: canonical(t.key),
      name: canonical(t.name),
      statuses: names(t.statuses),
      projects: names(t.projects),
    }));
  if (!teams.length) return { ok: false, tools, detail: `${label} called its Linear tool, but no team in its reply came from the tool.` };
  return { ok: true, tools, teams, detail: `${label} read ${teams.length} Linear team${teams.length === 1 ? '' : 's'} through ${tools.join(', ')}.` };
}

// The Linear status group each Bollplank status belongs in, and the steps to add a missing one.
export const STATUS_GROUP = { draft: 'Backlog', ready: 'Unstarted', inProgress: 'Started', acceptance: 'Started', done: 'Completed' };

export function addStatusSteps(team, key, name) {
  return `Open Linear, go to Settings, then Teams, then ${team}, then Workflow. Under ${STATUS_GROUP[key]}, add a status named "${name}".`;
}

// The first JSON object in a reply, with or without a code fence around it.
export function jsonIn(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function short(s) {
  return s.replace(/\s+/g, ' ').trim().slice(0, 200);
}
