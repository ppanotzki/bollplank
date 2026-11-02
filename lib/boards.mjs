// The board kinds Bollplank knows. statuses is the kind's suggested name for each of the five
// workflow states, used when the config maps none. newTeam is the statuses a new team starts with,
// used only to explain which suggested names a person has to add by hand.
export const BOARDS = {
  linear: {
    label: 'Linear',
    statuses: { draft: 'Draft', ready: 'Ready', inProgress: 'In Progress', acceptance: 'Acceptance', done: 'Done' },
    newTeam: ['Backlog', 'Todo', 'In Progress', 'Done', 'Canceled'],
  },
};

// The suggested names for a board kind, or Linear's for a kind Bollplank does not know.
export function suggestedStatuses(kind) {
  return { ...(BOARDS[kind] ?? BOARDS.linear).statuses };
}

// The suggested names a new team of this kind does not have, in workflow order.
export function missingInNewTeam(kind) {
  const b = BOARDS[kind] ?? BOARDS.linear;
  return Object.values(b.statuses).filter((s) => !b.newTeam.includes(s));
}
