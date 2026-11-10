// The board kinds Bollplank knows. statuses is the kind's suggested name for each of the five
// workflow states, used when the config maps none. newTeam is the statuses a new team starts with,
// used only to explain which suggested names a person has to add by hand. server names the kind's
// official remote MCP server: the name Bollplank adds it under and its URLs, the first preferred.
// fix says how to add that server, per client.
//
// This module imports nothing, so any other module can import it without a cycle. The Linear URL
// is the same as LINEAR_MCP_URL in lib/setup/probe.mjs, which documents where it comes from.
const LINEAR_URL = 'https://mcp.linear.app/mcp';
// Atlassian's official remote MCP server. v2 is the current endpoint and v1 the earlier one.
const JIRA_URLS = ['https://mcp.atlassian.com/v2/mcp', 'https://mcp.atlassian.com/v1/mcp'];

export const BOARDS = {
  linear: {
    label: 'Linear',
    statuses: { draft: 'Draft', ready: 'Ready', inProgress: 'In Progress', acceptance: 'Acceptance', done: 'Done' },
    newTeam: ['Backlog', 'Todo', 'In Progress', 'Done', 'Canceled'],
    server: { name: 'linear', urls: [LINEAR_URL] },
    fix: {
      claude: `Run \`bollplank init\` to add the Linear MCP, or run \`claude mcp add --transport http --scope user linear ${LINEAR_URL}\` and then \`claude mcp login linear\`.`,
      codex: `Run \`bollplank init\` to add the Linear MCP, or run \`codex mcp add linear --url ${LINEAR_URL}\` and then \`codex mcp login linear\`.`,
    },
  },
  jira: {
    label: 'Jira',
    statuses: { draft: 'Draft', ready: 'Ready', inProgress: 'In Progress', acceptance: 'Acceptance', done: 'Done' },
    newTeam: ['To Do', 'In Progress', 'Done'],
    server: { name: 'atlassian', urls: JIRA_URLS },
    fix: {
      claude: `Run \`bollplank init\` to add the Atlassian MCP, or run \`claude mcp add --transport http --scope user atlassian ${JIRA_URLS[0]}\` and then \`claude mcp login atlassian\`.`,
      codex: `Run \`bollplank init\` to add the Atlassian MCP, or run \`codex mcp add atlassian --url ${JIRA_URLS[0]}\` and then \`codex mcp login atlassian\`.`,
    },
  },
};

export const BOARD_KINDS = Object.keys(BOARDS);

// True for a kind Bollplank knows. Object.hasOwn keeps out names such as toString.
export const isBoardKind = (kind) => typeof kind === 'string' && Object.hasOwn(BOARDS, kind);

// A project's board kind: its own board.kind, else the top level board.kind. Works on the config as
// read and on the config with its defaults filled in.
export function kindOf(config, projectName) {
  const pr = projectName !== undefined && config?.projects && Object.hasOwn(config.projects, projectName) ? config.projects[projectName] : null;
  return pr?.board?.kind ?? config?.board?.kind;
}

// Whether a project's board is the top level board: the same kind, and its own team, when it sets
// one, is the top level team, compared without case. Only such a project takes the top level
// teamId, projectId and space, so a Jira project on another site never takes the top level cloud
// id. With no project name the top level board itself is meant.
export function sharesTopBoard(config, projectName) {
  if (projectName === undefined || projectName === null) return true;
  const pr = config?.projects && Object.hasOwn(config.projects, projectName) ? config.projects[projectName] : null;
  if (kindOf(config, projectName) !== config?.board?.kind) return false;
  const own = pr?.board?.team;
  if (own === undefined || own === null) return true;
  const top = config?.board?.team;
  return typeof own === 'string' && typeof top === 'string' && own.trim().toLowerCase() === top.trim().toLowerCase();
}

// The suggested names for a board kind, or Linear's for a kind Bollplank does not know.
export function suggestedStatuses(kind) {
  return { ...(isBoardKind(kind) ? BOARDS[kind] : BOARDS.linear).statuses };
}

// The suggested names a new team of this kind does not have, in workflow order.
export function missingInNewTeam(kind) {
  const b = isBoardKind(kind) ? BOARDS[kind] : BOARDS.linear;
  return Object.values(b.statuses).filter((s) => !b.newTeam.includes(s));
}
