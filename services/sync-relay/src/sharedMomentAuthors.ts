import type {LiveAuthorSnapshot} from "@dohc/live-session-contract";

/** Only relay-minted snapshots can name people or bind an agent to them. */
export function sharedMomentAuthors(snapshot: LiveAuthorSnapshot | undefined): Array<Record<string, unknown>> {
  if (!snapshot?.length) return [{kind: "unattributed"}];
  const principals = new Set(snapshot.flatMap(author => author.kind === "human" ? [author.humanId]
    : author.kind === "link" ? [author.publicPrincipalId] : []));
  let unattributed = false;
  return snapshot.flatMap(author => {
    if (author.kind === "agent" && (!author.onBehalfOf || !principals.has(author.onBehalfOf))) {
      if (unattributed) return [];
      unattributed = true;
      return [{kind: "unattributed"}];
    }
    if (author.kind === "automation") return {kind: "automation", automationId: author.automationId,
      depth: author.attribution.depth,
      ...(author.attribution.onBehalfOf === undefined ? {} : {onBehalfOf: author.attribution.onBehalfOf})};
    return {...author};
  });
}
