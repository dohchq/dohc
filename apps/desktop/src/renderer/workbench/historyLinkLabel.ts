/** The Edit link and browser session that made a change, including an ended grant. */
export function historyLinkLabel(author: { principalId: string }): string {
  return `Edit link · holder ${author.principalId.slice(0, 8)}`;
}
