// Conflict handling for everyday people (plan Phase 10): safe markdown edits
// merge silently; anything ambiguous preserves BOTH versions verbatim and
// describes the situation in prose. Git conflict markers never appear — an AI
// proposal can sit alongside the conflict, but only a human applies it.
//
// The pure three-way merge lives in ./mergeMarkdown (browser-safe subpath for
// the desktop renderer); re-exported here so node-side consumers keep one
// import surface.
export { mergeMarkdown, type MergeResult } from "./mergeMarkdown";

export interface ConflictProposal {
  content: string;
  rationale: string;
  source: "ai";
  createdAtMs?: number;
}

export interface FileConflict {
  path: string;
  localContent: string;
  remoteContent: string;
  localAuthor: string;
  remoteAuthor: string;
  proposal?: ConflictProposal;
  resolution?: "applied" | "kept-both" | "dismissed";
}

// Prose, not markers: "what happened" in one sentence a non-developer reads.
export function describeConflict(conflict: FileConflict): string {
  return `Both ${conflict.localAuthor} and ${conflict.remoteAuthor} changed ${conflict.path} since the last sync — both versions are kept until someone picks.`;
}

// A proposal sits BESIDE the conflict; the original sides stay verbatim.
export function storeProposal(
  conflict: FileConflict,
  proposal: { content: string; rationale: string; createdAtMs?: number },
): FileConflict {
  return { ...conflict, proposal: { ...proposal, source: "ai" } };
}

export function resolveConflict(
  conflict: FileConflict,
  outcome: "apply" | "keep-both" | "dismiss",
): FileConflict {
  const resolution =
    outcome === "apply" ? "applied" : outcome === "keep-both" ? "kept-both" : "dismissed";
  return { ...conflict, resolution };
}
