// The board probes both providers run: one fixed prompt per board kind, and one judgement of what
// came back. A probe passes only when a board tool call really happened and returned what the reply
// claims. A reply that only says it found teams or sites, with no tool call behind it, fails.
// PROBES at the end holds what differs per kind. The Linear names stay exported as they were.
import { BOARDS } from '../boards.mjs';

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
// A probe that ran out of time. The calls it made before then are judged first, so a call that is
// not a Linear read fails it for good and is never hidden by a second try. Otherwise a second try
// may fix it.
// kind and ctx pick the board's own judge, Linear's by default.
export function timedOut(label, calls, timeoutMs, kind = 'linear', ctx = {}) {
  const p = PROBES[kind] ?? PROBES.linear;
  const j = p.judge(label, calls, '', ctx);
  if (!j.ok && !j.retry) return j;
  return { ok: false, retry: true, detail: `${label} did not finish the ${p.label} probe in ${timeoutMs / 1000} seconds.` };
}

export function judge(label, calls, reply) {
  // Any call that is not a Linear read fails the probe, whatever its service or result, since a
  // probe must not be able to change anything.
  const others = [...new Set(calls.filter((c) => !isLinearRead(c.name)).map((c) => c.name || 'an unnamed tool'))];
  if (others.length) return { ok: false, tools: others, detail: `${label} called ${others.join(', ')}, which ${others.length === 1 ? 'is' : 'are'} not a Linear read. The probe allows only Linear tools that list, get, search or read.` };
  const linear = calls;
  if (!linear.length) return { ok: false, retry: true, detail: `${label} made no Linear tool call. It has no Linear tool, or the tool is not allowed in a headless call.` };
  const good = linear.filter((c) => c.ok && c.text.trim());
  const tools = [...new Set(linear.map((c) => c.name))];
  if (!good.length) return { ok: false, retry: true, tools, detail: `${label} called ${tools.join(', ')}, but the call failed: ${short(linear.find((c) => c.text)?.text ?? 'no result')}` };
  const answer = jsonIn(reply);
  if (!answer) return { ok: false, retry: true, tools, detail: `${label} called its Linear tool but did not reply with the JSON the probe asks for.` };
  if (answer.error) return { ok: false, retry: true, tools, detail: `${label} reported: ${short(String(answer.error))}` };
  // Only what the tool really returned counts, so a name the model added on its own is dropped,
  // and every name is spelled as the tool returned it, never as the model wrote it, since the
  // workflow looks statuses up by their exact name. Names are whole values from the fields that
  // hold them, never a fragment of other text, so a project called "User acceptance" or a status
  // called "Awaiting Acceptance" never stands in for a status called "Acceptance".
  const read = readNames(good);
  // One record per team, with the key and name the tool returned together. The model's key and
  // name must lead to the same record, and the team's projects and statuses are only those the
  // tool tied to that record.
  const recordFor = (t) => {
    const byKey = read.find('key', t.key);
    const byName = read.find('name', t.name);
    if (byKey && byName && byKey !== byName) return null;
    return byKey ?? byName ?? null;
  };
  const teams = [];
  for (const t of Array.isArray(answer.teams) ? answer.teams : []) {
    const team = t && recordFor(t);
    if (!team || teams.some((x) => x.record === team)) continue;
    const names = (kind, list) => [...new Set((Array.isArray(list) ? list : []).map((v) => read.pick(kind, v, team)).filter(Boolean))];
    teams.push({ record: team, key: team.key, name: team.name, statuses: names('status', t.statuses), projects: names('project', t.projects) });
  }
  for (const t of teams) delete t.record;
  if (!teams.length) return { ok: false, retry: true, tools, detail: `${label} called its Linear tool, but no team in its reply came from the tool.` };
  return { ok: true, tools, teams, detail: `${label} read ${teams.length} Linear team${teams.length === 1 ? '' : 's'} through ${tools.join(', ')}.` };
}

// The team, project and status names the Linear tools really returned, as whole values from the
// fields that hold them. A result is read as JSON, including JSON inside a string, as the clients
// wrap tool results in their own envelopes. The kind of a list comes from its field (teams,
// projects, states or statuses) or from the tool's name (list_teams, list_projects,
// list_issue_statuses). Every project and status needs an owner: the team it sits in, the team its
// own team field names, or the team the call asked for in its arguments. A name whose team cannot
// be told is dropped, never offered to every team.
export function readNames(calls) {
  const records = [];
  const owned = { project: [], status: [] };
  const FIELD = { teams: 'team', projects: 'project', states: 'status', statuses: 'status', workflowStates: 'status' };
  const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null);
  const ownerOf = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? [o.id, o.key, o.name].map(str).filter(Boolean) : str(o) ? [o] : []);
  const visit = (v, kind, owner, depth = 0) => {
    if (depth > 12 || v == null) return;
    if (typeof v === 'string') {
      const t = v.trim();
      if (t.startsWith('{') || t.startsWith('[')) {
        try {
          visit(JSON.parse(t), kind, owner, depth + 1);
        } catch {}
      }
      return;
    }
    if (Array.isArray(v)) return v.forEach((x) => visit(x, kind, owner, depth + 1));
    if (typeof v !== 'object') return;
    let own = owner;
    if (kind === 'team' && (str(v.key) || str(v.name))) {
      const rec = { id: str(v.id), key: str(v.key), name: str(v.name) };
      records.push(rec);
      own = [rec.id, rec.key, rec.name].filter(Boolean);
    } else if (kind === 'project' || kind === 'status') {
      const named = ownerOf(v.team);
      own = named.length ? named : owner;
      if (str(v.name) && own.length) owned[kind].push({ value: v.name, owner: own });
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
    let args = c.args;
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = null;
      }
    }
    const asked = args && typeof args === 'object' ? ['team', 'teamId', 'teamKey', 'teamName'].flatMap((k) => ownerOf(args[k])) : [];
    visit(c.text, kind, asked);
  }
  // A record found more than once, say by list_teams and inside a project, is one record.
  const teams = [];
  for (const r of records) {
    const same = teams.find((t) => (r.id && t.id === r.id) || (r.key && t.key === r.key));
    if (same) Object.assign(same, { id: same.id ?? r.id, key: same.key ?? r.key, name: same.name ?? r.name });
    else teams.push({ ...r });
  }
  const one = (pool, s) => {
    if (typeof s !== 'string' || s.trim() === '') return null;
    if (pool.includes(s)) return s;
    const same = [...new Set(pool.filter((v) => v.toLowerCase() === s.toLowerCase()))];
    return same.length === 1 ? same[0] : null;
  };
  const belongs = (owner, team) => owner.some((o) => o === team.id || o === team.key || o === team.name);
  return {
    teams,
    // The team record whose key, or whose name, matches s exactly or by case alone.
    find(field, s) {
      const v = one(teams.map((t) => t[field]).filter(Boolean), s);
      return v ? teams.find((t) => t[field] === v) : null;
    },
    // A project or status of this team, spelled as the tool returned it.
    pick(kind, s, team) {
      return one(owned[kind].filter((e) => belongs(e.owner, team)).map((e) => e.value), s);
    },
  };
}

// The Linear status group each Bollplank status belongs in, and the steps to add a missing one.
export const STATUS_GROUP = { draft: 'Backlog', ready: 'Unstarted', inProgress: 'Started', acceptance: 'Started', done: 'Completed' };

export function addStatusSteps(team, key, name) {
  return `Open Linear, go to Settings, then Teams, then ${team}, then Workflow. Under ${STATUS_GROUP[key]}, add a status named "${name}".`;
}

// The steps for several missing statuses at once, as [key, name] pairs in workflow order.
export function addStatusesSteps(team, missing) {
  const each = missing.map(([k, name]) => `"${name}" under ${STATUS_GROUP[k]}`);
  const list = each.length > 1 ? `${each.slice(0, -1).join(', ')} and ${each.at(-1)}` : each[0];
  return `Open Linear, go to Settings, then Teams, then ${team}, then Workflow. Add ${list}. Then answer y when init asks to check Linear again.`;
}

// Jira through Atlassian's official remote MCP server, from
// https://support.atlassian.com/atlassian-rovo-mcp-server/docs/supported-tools/ and
// https://github.com/atlassian/atlassian-mcp-server (read on 10 November 2026). v2 shows a few
// Primary tools directly. Every other tool runs through executeRead or executeWrite, which name the
// inner tool in their arguments. Every call takes the site's cloudId, which
// getAccessibleAtlassianResources lists.
export const JIRA_MCP_URLS = BOARDS.jira.server.urls;

// A server URL as compared: the scheme and host in lower case and no trailing slash. Anything else,
// a query included, must be the same.
export function normalUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    const u = new URL(url.trim());
    // A URL with a user name or password in it is never an official one. URL already writes the
    // scheme and host in lower case.
    if (u.username || u.password) return null;
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}${u.search}${u.hash}`;
  } catch {
    return null;
  }
}

// Whether url is one of the board kind's official server URLs. A server is never taken as the
// board's by its name alone.
export function isOfficialUrl(kind, url) {
  const n = normalUrl(url);
  return Boolean(n) && (BOARDS[kind]?.server.urls ?? []).some((u) => normalUrl(u) === n);
}

// The Primary tools the Jira probe may call directly, and the inner tools it may run through
// executeRead. getConfluenceSpace is a read the probe may make only when a space is configured.
export const JIRA_DIRECT_READS = ['getAccessibleAtlassianResources', 'atlassianUserInfo', 'getJiraIssue'];
export const JIRA_INNER_READS = ['listJiraProjects', 'listJiraStatuses', 'getJiraIssue'];
export const JIRA_SPACE_READ = 'getConfluenceSpace';
// The tools of the server a Jira probe is offered, by name. Codex takes them as enabled_tools and
// Claude Code as one allow rule each.
export const JIRA_PROBE_TOOLS = [...JIRA_DIRECT_READS, 'executeRead'];
// The tools a Jira critic is offered, by name, and the inner tools it may run through each execute
// tool. The critic is reply only, so it gets no write tool, and executeRead only for the comments.
export const JIRA_CRITIC_TOOLS = ['getJiraIssue', 'executeRead'];
export const JIRA_CRITIC_INNER = { executeRead: ['listJiraIssueComments'] };

// The inner tool of an executeRead or executeWrite call and its arguments. Atlassian's pages name
// the inner tool in the arguments but do not show their exact shape (checked on 10 November 2026).
// Bollplank assumes { tool, arguments } and also accepts { toolName, input }, and name, args or
// params for either part. Arguments given as a JSON string, as Codex reports them, are parsed.
// When the fields that name the tool name different tools, or one of them is not text, the tool is
// CONFLICTING_INNER, which no list allows, so the probe and the critic refuse the call.
export const CONFLICTING_INNER = 'conflicting inner tool names';
const INNER_NAME_FIELDS = ['tool', 'toolName', 'tool_name', 'name'];

export function innerCall(args) {
  const a = parsed(args);
  if (!a || typeof a !== 'object' || Array.isArray(a)) return { tool: null, args: {} };
  const given = INNER_NAME_FIELDS.map((k) => a[k]).filter((v) => v !== undefined && v !== null);
  const named = [...new Set(given.filter((v) => typeof v === 'string' && v.trim()))];
  const tool = given.some((v) => typeof v !== 'string') || named.length > 1 ? CONFLICTING_INNER : (named[0] ?? null);
  const inner = parsed(a.arguments ?? a.input ?? a.args ?? a.params ?? {});
  return { tool, args: inner && typeof inner === 'object' && !Array.isArray(inner) ? inner : {} };
}

function parsed(v) {
  if (typeof v !== 'string') return v ?? null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

// A Jira read the probe allows. call is { name, args }, with name as the clients write it, and
// ctx.servers the ids of the servers whose URL is an official Atlassian one. A tool of any other
// server, whatever its name, is not a Jira read. ctx.space allows getConfluenceSpace.
export function isJiraRead(call, ctx = {}) {
  if (!(ctx.servers ?? []).includes(serverPart(call?.name))) return false;
  const tool = toolPart(call.name);
  if (JIRA_DIRECT_READS.includes(tool)) return true;
  if (tool !== 'executeRead') return false;
  const inner = innerCall(call.args).tool;
  return JIRA_INNER_READS.includes(inner) || (Boolean(ctx.space) && inner === JIRA_SPACE_READ);
}

// The Jira probe prompt. target names the project keys whose statuses to list and the Confluence
// spaces to read, both optional. Without a project, the probe lists the sites and their projects.
export function jiraProbePrompt(target = {}) {
  const projects = (target.projects ?? []).filter(Boolean);
  const spaces = (target.spaces ?? []).filter(Boolean);
  return [
    'This is a Bollplank setup check.',
    'Use your Atlassian tools to read Jira. First call getAccessibleAtlassianResources to list the sites you can reach, each with its cloudId.',
    'Then, for each site, call executeRead with the tool listJiraProjects and that cloudId to list its Jira projects.',
    ...(projects.length ? [`Projects: ${projects.join(', ')}.`, 'For each of these projects, call executeRead with the tool listJiraStatuses, the cloudId and the project key to list its statuses.'] : []),
    ...(spaces.length ? [`Spaces: ${spaces.join(', ')}.`, 'For each of these Confluence spaces, call executeRead with the tool getConfluenceSpace, the cloudId and the space key.'] : []),
    'Only read. Change nothing in Jira or Confluence and use no other tool.',
    'Reply with one JSON object and no other text, in this shape:',
    '{"sites":[{"site":"acme.atlassian.net","cloudId":"ID","projects":[{"key":"KEY","id":"ID","statuses":["Status name"]}]}],"spaces":[{"key":"KEY","cloudId":"ID"}]}',
    'If you have no Atlassian tool or a call fails, reply {"error":"what happened"}.',
  ].join('\n');
}

// What a Jira probe read: the sites, projects, statuses and spaces its tools really returned, each
// spelled as the tool returned it, then the reply's claims matched against them. Only a site,
// project, status or space a tool returned counts, as for Linear.
export function judgeJira(label, calls, reply, ctx = {}) {
  const others = [...new Set(calls.filter((c) => !isJiraRead(c, ctx)).map((c) => describe(c)))];
  const allowed = `${JIRA_DIRECT_READS.join(', ')} and executeRead of ${[...JIRA_INNER_READS, ...(ctx.space ? [JIRA_SPACE_READ] : [])].join(', ')}`;
  if (others.length) return { ok: false, tools: others, detail: `${label} called ${others.join(', ')}, which ${others.length === 1 ? 'is' : 'are'} not a Jira read of the official Atlassian server. The probe allows only ${allowed}.` };
  if (!calls.length) return { ok: false, retry: true, detail: `${label} made no Jira tool call. It has no Atlassian tool, or the tool is not allowed in a headless call.` };
  const good = calls.filter((c) => c.ok && c.text.trim());
  const tools = [...new Set(calls.map((c) => describe(c)))];
  if (!good.length) return { ok: false, retry: true, tools, detail: `${label} called ${tools.join(', ')}, but the call failed: ${short(calls.find((c) => c.text)?.text ?? 'no result')}` };
  const answer = jsonIn(reply);
  if (!answer) return { ok: false, retry: true, tools, detail: `${label} called its Atlassian tools but did not reply with the JSON the probe asks for.` };
  if (answer.error) return { ok: false, retry: true, tools, detail: `${label} reported: ${short(String(answer.error))}` };
  const read = readJira(good);
  const claimedSpaces = [...(Array.isArray(answer.spaces) ? answer.spaces : []), ...(answer.space ? [answer.space] : [])].map((s) => (typeof s === 'string' ? { key: s } : s)).filter((s) => s && typeof s === 'object');
  const sites = [];
  for (const s of Array.isArray(answer.sites) ? answer.sites : []) {
    if (!s || typeof s !== 'object') continue;
    const byHost = read.site(siteHost(s.site));
    const byId = read.siteById(s.cloudId);
    if (byHost && byId && byHost !== byId) continue;
    const site = byHost ?? byId;
    if (!site || sites.some((x) => x.cloudId === site.cloudId)) continue;
    const projects = [];
    for (const p of Array.isArray(s.projects) ? s.projects : []) {
      const rec = p && typeof p === 'object' ? read.project(site.cloudId, p.key, p.id) : null;
      if (!rec || projects.some((x) => x.id === rec.id)) continue;
      const statuses = [...new Set((Array.isArray(p.statuses) ? p.statuses : []).map((v) => read.status(site.cloudId, rec, v)).filter(Boolean))];
      projects.push({ key: rec.key, id: rec.id, ...(rec.name ? { name: rec.name } : {}), statuses });
    }
    const spaces = [...new Set(claimedSpaces.filter((x) => x.cloudId === undefined || x.cloudId === site.cloudId).map((x) => read.space(site.cloudId, x.key)).filter(Boolean))];
    sites.push({ site: site.site, cloudId: site.cloudId, projects, spaces });
  }
  if (!sites.length) return { ok: false, retry: true, tools, detail: `${label} called its Atlassian tools, but no site in its reply came from the tool.` };
  return { ok: true, tools, sites, detail: `${label} read ${sites.length} Jira site${sites.length === 1 ? '' : 's'} through ${tools.join(', ')}.` };
}

// A call by its tool name, and for executeRead or executeWrite also the inner tool it named.
function describe(c) {
  const name = c.name || 'an unnamed tool';
  const tool = toolPart(c.name);
  if (!/^execute/.test(tool)) return name;
  const inner = innerCall(c.args).tool;
  return inner ? `${name} of ${inner}` : name;
}

// A site's host from a URL or a bare host, in lower case.
export function siteHost(s) {
  if (typeof s !== 'string' || !s.trim()) return null;
  const t = s.trim();
  try {
    return new URL(/^[a-z]+:\/\//i.test(t) ? t : `https://${t}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// The sites, projects, statuses and spaces the Atlassian tools returned. A site comes from
// getAccessibleAtlassianResources, as its id and URL. A project, a status or a space belongs to the
// site whose cloudId its call named, and a status to the project its call named, so a name whose
// owner cannot be told is dropped.
export function readJira(calls) {
  const sites = [];
  const projects = [];
  const statuses = [];
  const spaces = [];
  const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v : typeof v === 'number' ? String(v) : null);
  for (const c of calls) {
    const direct = toolPart(c.name);
    const { tool, args } = direct === 'executeRead' ? innerCall(c.args) : { tool: direct, args: parsed(c.args) ?? {} };
    const cloudId = str(args?.cloudId);
    if (tool === 'getAccessibleAtlassianResources') {
      walk(c.text, (o) => {
        const host = str(o.url) ? siteHost(o.url) : null;
        if (str(o.id) && host && !sites.some((s) => s.cloudId === o.id)) sites.push({ cloudId: o.id, site: host });
      });
    } else if (tool === 'listJiraProjects' && cloudId) {
      walk(c.text, (o) => {
        if (str(o.key) && str(o.id) && !projects.some((p) => p.cloudId === cloudId && p.id === str(o.id))) projects.push({ cloudId, key: o.key, id: str(o.id), name: str(o.name) });
      });
    } else if (tool === 'listJiraStatuses' && cloudId) {
      const owner = ['projectIdOrKey', 'projectKey', 'projectId', 'project'].map((k) => str(args[k])).filter(Boolean);
      walk(c.text, (o, field) => {
        if (!str(o.name) || !(o.statusCategory !== undefined || field === 'statuses')) return;
        const own = str(o.scope?.project?.id) ? [str(o.scope.project.id)] : owner;
        if (own.length) statuses.push({ cloudId, owner: own, name: o.name });
      });
    } else if (tool === JIRA_SPACE_READ && cloudId) {
      walk(c.text, (o) => {
        if (str(o.key) && (str(o.name) || str(o.id))) spaces.push({ cloudId, key: o.key });
      });
    }
  }
  const one = (pool, s) => {
    if (typeof s !== 'string' || s.trim() === '') return null;
    if (pool.includes(s)) return s;
    const same = [...new Set(pool.filter((v) => v.toLowerCase() === s.toLowerCase()))];
    return same.length === 1 ? same[0] : null;
  };
  return {
    sites,
    projects,
    site: (host) => (host ? sites.find((s) => s.site === host) ?? null : null),
    siteById: (id) => (typeof id === 'string' ? sites.find((s) => s.cloudId === id) ?? null : null),
    // A project of the site by its key, else by its id. A key and an id of two projects lead to none.
    project(cloudId, key, id) {
      const own = projects.filter((p) => p.cloudId === cloudId);
      const k = one(own.map((p) => p.key), key);
      const byKey = k ? own.find((p) => p.key === k) : null;
      const byId = str(id) ? own.find((p) => p.id === str(id)) ?? null : null;
      if (byKey && byId && byKey !== byId) return null;
      return byKey ?? byId;
    },
    status: (cloudId, project, name) => one(statuses.filter((s) => s.cloudId === cloudId && s.owner.some((o) => o === project.key || o === project.id)).map((s) => s.name), name),
    space: (cloudId, key) => one(spaces.filter((s) => s.cloudId === cloudId).map((s) => s.key), key),
  };
}

// Calls fn(object, field) for every object in a tool result, with the field that holds it, reading
// JSON inside strings as the clients wrap tool results in their own envelopes.
function walk(v, fn, field = null, depth = 0) {
  if (depth > 12 || v == null) return;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try {
        walk(JSON.parse(t), fn, field, depth + 1);
      } catch {}
    }
    return;
  }
  if (Array.isArray(v)) return v.forEach((x) => walk(x, fn, field, depth + 1));
  if (typeof v !== 'object') return;
  fn(v, field);
  for (const [k, x] of Object.entries(v)) if (x && (typeof x === 'object' || k === 'text' || k === 'content')) walk(x, fn, k === 'text' || k === 'content' ? field : k, depth + 1);
}

// The Jira status category each Bollplank status belongs in, and the steps to add a missing one.
export const JIRA_STATUS_CATEGORY = { draft: 'To Do', ready: 'To Do', inProgress: 'In Progress', acceptance: 'In Progress', done: 'Done' };

export function jiraAddStatusSteps(project, key, name) {
  return `Open the Jira project ${project}, go to Project settings, then Workflows. Add a status named "${name}" in the ${JIRA_STATUS_CATEGORY[key]} category.`;
}

export function jiraAddStatusesSteps(project, missing) {
  const each = missing.map(([k, name]) => `"${name}" in ${JIRA_STATUS_CATEGORY[k]}`);
  const list = each.length > 1 ? `${each.slice(0, -1).join(', ')} and ${each.at(-1)}` : each[0];
  return `Open the Jira project ${project}, go to Project settings, then Workflows. Add ${list}. Then answer y when init asks to check Jira again.`;
}

// What differs per board kind. label names the board, server the MCP server people add and sign
// in to, prompt the probe prompt for a target, judge the judgement of a probe, statusSteps and
// statusesSteps the steps to add missing statuses, and codexTools the tools a Codex probe allows.
export const PROBES = {
  linear: {
    label: 'Linear',
    server: 'Linear',
    noun: 'team',
    prompt: () => LINEAR_PROBE_PROMPT,
    judge: (label, calls, reply) => judge(label, calls, reply),
    statusSteps: (...a) => addStatusSteps(...a),
    statusesSteps: (...a) => addStatusesSteps(...a),
    codexTools: CODEX_LINEAR_READ_TOOLS,
  },
  jira: {
    label: 'Jira',
    server: 'Atlassian',
    noun: 'project',
    prompt: jiraProbePrompt,
    judge: judgeJira,
    statusSteps: jiraAddStatusSteps,
    statusesSteps: jiraAddStatusesSteps,
    codexTools: JIRA_PROBE_TOOLS,
  },
};

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
