import type { FileDisplayKind } from "./kinds";

export type WorkspaceRefTarget =
  | { readonly kind: "file"; readonly objectId: string }
  | { readonly kind: "channel"; readonly channelId: string }
  | { readonly kind: "thread"; readonly threadId: string }
  | { readonly kind: "dataset"; readonly datasetId: string }
  | { readonly kind: "table"; readonly datasetId: string; readonly tableId: string }
  | { readonly kind: "version"; readonly versionId: string };

export type WorkspaceRefSource =
  | { readonly workspaceId: string; readonly receivedSource?: never }
  | { readonly receivedSource: string; readonly workspaceId?: never };

export const isReceivedSource = (value: unknown): value is string =>
  typeof value === "string" && /^share-source:v1:[0-9a-f]{64}$/u.test(value);
export const isReceivedObject = (value: unknown): value is string =>
  typeof value === "string" && /^share-object:v1:[0-9a-f]{64}$/u.test(value);

export function isWorkspaceRefSource(value: unknown): value is WorkspaceRefSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  return "workspaceId" in source ? !("receivedSource" in source) && typeof source.workspaceId === "string" && source.workspaceId.length > 0
    : isReceivedSource(source.receivedSource);
}

/** Native identity and display labels. A reference grants no access. */
export interface WorkspaceRef<Target extends WorkspaceRefTarget = WorkspaceRefTarget> {
  readonly source: WorkspaceRefSource;
  readonly target: Target;
  readonly labels: {
    readonly path?: string;
    readonly name: string;
    readonly displayKind: FileDisplayKind | "channel" | "thread" | "dataset" | "table" | "version";
  };
}

export type WorkspaceFileRef = WorkspaceRef<Extract<WorkspaceRefTarget, { kind: "file" }>>;

/** Labels can change without changing the referenced object. */
export function workspaceRefsEqual(left: WorkspaceRef, right: WorkspaceRef): boolean {
  if (!isWorkspaceRefSource(left.source) || !isWorkspaceRefSource(right.source) || left.target.kind !== right.target.kind) return false;
  if ("workspaceId" in left.source
    ? !("workspaceId" in right.source) || left.source.workspaceId !== right.source.workspaceId
    : "workspaceId" in right.source || left.source.receivedSource !== right.source.receivedSource) return false;
  const other = right.target;
  switch (left.target.kind) {
    case "file": return other.kind === "file" && left.target.objectId === other.objectId;
    case "channel": return other.kind === "channel" && left.target.channelId === other.channelId;
    case "thread": return other.kind === "thread" && left.target.threadId === other.threadId;
    case "dataset": return other.kind === "dataset" && left.target.datasetId === other.datasetId;
    case "table": return other.kind === "table" && left.target.datasetId === other.datasetId && left.target.tableId === other.tableId;
    case "version": return other.kind === "version" && left.target.versionId === other.versionId;
  }
}
