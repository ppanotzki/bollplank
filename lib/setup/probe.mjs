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
  // workflow looks statuses up by their exact name. Names are whole values from the fields that
  // hold them, never a fragment of other text, so a project called "User acceptance" or a status
  // called "Awaiting Acceptance" never stands in for a status called "Acceptance".
  const read = readNames(good);
  const pick = (kind, s, team) => {
    if (typeof s !== 'string' || s.trim() === '') return null;
    const pool = [...read.names(kind, team)];
    if (pool.includes(s)) return s;
    const same = pool.filter((v) => v.toLowerCase() === s.toLowerCase());
    return same.length === 1 ? same[0] : null;
  };
  const teams = (Array.isArray(answer.teams) ? answer.teams : [])
    .filter((t) => t && (pick('teamKey', t.key) || pick('teamName', t.name)))
    .map((t) => {
      const key = pick('teamKey', t.key);
      const name = pick('teamName', t.name);
      const ids = [key, name].filter(Boolean);
      const names = (kind, list) => [...new Set((Array.isArray(list) ? list : []).map((s) => pick(kind, s, ids)).filter(Boolean))];
      return { key, name, statuses: names('status', t.statuses), projects: names('project', t.projects) };
    });
  if (!teams.length) return { ok: false, tools, detail: `${label} called its Linear tool, but no team in its reply came from the tool.` };
  return { ok: true, tools, teams, detail: `${label} read ${teams.length} Linear team${teams.length === 1 ? '' : 's'} through ${tools.join(', ')}.` };
}

// The team, project and status names the Linear tools really returned, as whole values from the
// fields that hold them. A result is read as JSON, including JSON inside a string, as the clients
// wrap tool results in their own envelopes. The kind of a list comes from its field (teams,
// projects, states or statuses) or from the tool's name (list_teams, list_projects,
// list_issue_statuses). A name found inside a team, or next to a team field, belongs to that team.
// A name with no team is offered to every team, since a tool may list one team's statuses alone.
export function readNames(calls) {
  const found = { teamKey: new Map(), teamName: new Map(), project: new Map(), status: new Map() };
  const add = (kind, value, team) => {
    if (typeof value !== 'string' || value.trim() === '') return;
    if (!found[kind].has(value)) found[kind].set(value, new Set());
    found[kind].get(value).add(team ?? '*');
  };
  const FIELD = { teams: 'team', projects: 'project', states: 'status', statuses: 'status', workflowStates: 'status' };
  const teamOf = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? o.key ?? o.name ?? null : typeof o === 'string' ? o : null);
  const visit = (v, kind, team, depth = 0) => {
    if (depth > 12 || v == null) return;
    if (typeof v === 'string') {
      const s = v.trim();
      if (s.startsWith('{') || s.startsWith('[')) {
        try {
          visit(JSON.parse(s), kind, team, depth + 1);
        } catch {}
      }
      return;
    }
    if (Array.isArray(v)) return v.forEach((x) => visit(x, kind, team, depth + 1));
    if (typeof v !== 'object') return;
    let own = team;
    if (kind === 'team') {
      add('teamKey', v.key, v.key ?? v.name);
      add('teamName', v.name, v.key ?? v.name);
      own = v.key ?? v.name ?? team;
    } else if (kind) {
      own = teamOf(v.team) ?? team;
      add(kind, v.name, own);
    }
    for (const [k, x] of Object.entries(v)) {
      if (FIELD[k]) visit(x, FIELD[k], own, depth + 1);
      else if (k !== 'team' && x && typeof x === 'object') visit(x, kind === 'team' ? null : kind, own, depth + 1);
      else if (typeof x === 'string' && (k === 'text' || k === 'content')) visit(x, kind, own, depth + 1);
    }
  };
  for (const c of calls) {
    const tool = toolPart(c.name).toLowerCase();
    const kind = /status|state/.test(tool) ? 'status' : /project/.test(tool) ? 'project' : /team/.test(tool) ? 'team' : null;
    visit(c.text, kind, null);
  }
  return {
    names(kind, teams) {
      const out = [];
      for (const [value, owners] of found[kind]) {
        if (!teams || owners.has('*') || teams.some((t) => owners.has(t))) out.push(value);
      }
      return out;
    },
  };
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
