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

// calls: every tool call the client made, as { name, ok, text }. reply: the client's final text.
// The tool is found by its Linear purpose in its name, since it may come from a configured MCP
// server or from the client's account connectors, whose names differ.
export function judge(label, calls, reply) {
  const linear = calls.filter((c) => /linear/i.test(c.name));
  if (!linear.length) return { ok: false, detail: `${label} made no Linear tool call. It has no Linear tool, or the tool is not allowed in a headless call.` };
  const good = linear.filter((c) => c.ok && c.text.trim());
  const tools = [...new Set(linear.map((c) => c.name))];
  if (!good.length) return { ok: false, tools, detail: `${label} called ${tools.join(', ')}, but the call failed: ${short(linear.find((c) => c.text)?.text ?? 'no result')}` };
  const answer = jsonIn(reply);
  if (!answer) return { ok: false, tools, detail: `${label} called its Linear tool but did not reply with the JSON the probe asks for.` };
  if (answer.error) return { ok: false, tools, detail: `${label} reported: ${short(String(answer.error))}` };
  // Only what the tool really returned counts, so a name the model added on its own is dropped.
  const seen = good.map((c) => c.text.toLowerCase()).join('\n');
  const found = (s) => typeof s === 'string' && s.trim() !== '' && seen.includes(s.toLowerCase());
  const teams = (Array.isArray(answer.teams) ? answer.teams : [])
    .filter((t) => t && (found(t.key) || found(t.name)))
    .map((t) => ({
      key: typeof t.key === 'string' ? t.key : null,
      name: typeof t.name === 'string' ? t.name : null,
      statuses: (Array.isArray(t.statuses) ? t.statuses : []).filter(found),
      projects: (Array.isArray(t.projects) ? t.projects : []).filter(found),
    }));
  if (!teams.length) return { ok: false, tools, detail: `${label} called its Linear tool, but no team in its reply came from the tool.` };
  return { ok: true, tools, teams, detail: `${label} read ${teams.length} Linear team${teams.length === 1 ? '' : 's'} through ${tools.join(', ')}.` };
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
