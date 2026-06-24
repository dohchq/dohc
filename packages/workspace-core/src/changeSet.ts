export type ChangeSetKind =
  | "user-edit"
  | "agent-run"
  | "import"
  | "sync"
  | "site-build"
  | "history-restore";

export type BoundaryCrossing =
  | "public-share"
  | "external-export"
  | "permission-change"
  | "bulk-delete"
  | "site-publish"
  | "private-to-shared"
  | "unmergeable-overwrite";

declare const nonEmptyLocalAuthorLabelBrand: unique symbol;

export type NonEmptyLocalAuthorLabel = string & {
  readonly [nonEmptyLocalAuthorLabelBrand]: true;
};

export type ChangeAuthor =
  | { kind: "user"; userId: string }
  | { kind: "agent"; agentId: string; onBehalfOf: string }
  | { kind: "local"; label: NonEmptyLocalAuthorLabel };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCanonicalNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  if (!value || value.trim() !== value) {
    throw new Error(`${label} must be canonical and non-empty.`);
  }
  return value;
}

export function parseLocalAuthorLabel(label: unknown): NonEmptyLocalAuthorLabel {
  if (typeof label !== "string") {
    throw new Error("Local change author label must be a string.");
  }
  const normalized = label.trim();
  if (!normalized) throw new Error("Local change author label must be non-empty.");
  return normalized as NonEmptyLocalAuthorLabel;
}

export function createLocalChangeAuthor(label: string): Extract<ChangeAuthor, { kind: "local" }> {
  return { kind: "local", label: parseLocalAuthorLabel(label) };
}

export function parseChangeAuthor(value: unknown): ChangeAuthor {
  if (!isRecord(value)) {
    throw new Error("Change author is invalid.");
  }
  if (value.kind === "user") {
    return {
      kind: "user",
      userId: parseCanonicalNonEmptyString(value.userId, "Change author user id"),
    };
  }
  if (value.kind === "agent") {
    return {
      kind: "agent",
      agentId: parseCanonicalNonEmptyString(value.agentId, "Change author agent id"),
      onBehalfOf: parseCanonicalNonEmptyString(
        value.onBehalfOf,
        "Change author on-behalf-of id",
      ),
    };
  }
  if (value.kind === "local") {
    if (typeof value.label !== "string") {
      throw new Error("Local change author label must be a string.");
    }
    return createLocalChangeAuthor(value.label);
  }
  throw new Error("Change author kind is invalid.");
}

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
  source: ChangeSetKind;
  prompt?: string;
  agentRunId?: string;
  importPath?: string;
  restoreOfChangeSetId?: string;
  restoreOfPath?: string;
  restoreDirection?: "restore" | "undo" | "redo";
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
  if (input.provenance && input.provenance.source !== input.kind) {
    throw new Error(
      `Change provenance source ${input.provenance.source} does not match change set kind ${input.kind}`,
    );
  }
  return {
    kind: input.kind,
    author: parseChangeAuthor(input.author),
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
