export type ChangeSetKind =
  | "user-edit"
  | "agent-run"
  | "import"
  | "sync"
  | "app-build";

export type BoundaryCrossing =
  | "public-share"
  | "external-export"
  | "permission-change"
  | "bulk-delete"
  | "app-trust"
  | "private-to-shared"
  | "unmergeable-overwrite";

export type ChangeAuthor =
  | { kind: "user"; userId: string }
  | { kind: "agent"; agentId: string; onBehalfOf: string };

export interface FileChange {
  path: string;
  operation: "write" | "delete" | "rename";
  mediaType?: string;
  before?: FileChangeSnapshot | null;
  after?: FileChangeSnapshot | null;
}

export interface FileChangeSnapshot {
  sha256?: string;
  sizeBytes?: number;
  text?: string;
  truncated?: boolean;
  unavailableReason?: "missing" | "binary" | "too-large" | "unreadable";
}

// Where a change came from — a prompt, an import source, an agent run — so
// history can answer "why did this change?" not just "what changed?".
export interface ChangeProvenance {
  source: "user-edit" | "agent-run" | "import" | "sync" | "app-build";
  prompt?: string;
  agentRunId?: string;
  importPath?: string;
}

export interface ChangeSet {
  kind: ChangeSetKind;
  author: ChangeAuthor;
  summary: string;
  files: FileChange[];
  boundaryCrossings: BoundaryCrossing[];
  provenance?: ChangeProvenance;
}

export function createChangeSet(input: {
  kind: ChangeSetKind;
  author: ChangeAuthor;
  summary: string;
  provenance?: ChangeProvenance;
}): ChangeSet {
  return {
    kind: input.kind,
    author: input.author,
    summary: input.summary,
    files: [],
    boundaryCrossings: [],
    ...(input.provenance ? { provenance: input.provenance } : {}),
  };
}

export function addFileChanges(set: ChangeSet, files: FileChange[]): ChangeSet {
  return { ...set, files: [...set.files, ...files] };
}

export function addBoundaryCrossing(
  set: ChangeSet,
  crossing: BoundaryCrossing,
): ChangeSet {
  return { ...set, boundaryCrossings: [...set.boundaryCrossings, crossing] };
}

// Liberal by default: ordinary edits sync freely; only genuine boundary
// crossings need a human to look.
export function requiresReview(set: ChangeSet): boolean {
  return set.boundaryCrossings.length > 0;
}
