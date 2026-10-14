import type { FileDisplayKind } from "./kinds";

export type WorkspaceRefTarget =
  | { readonly kind: "file"; readonly objectId: string }
  | { readonly kind: "channel"; readonly channelId: string }
  | { readonly kind: "thread"; readonly threadId: string }
  | { readonly kind: "dataset"; readonly datasetId: string }
  | { readonly kind: "table"; readonly datasetId: string; readonly tableId: string }
  | { readonly kind: "version"; readonly versionId: string };

/** Native identity and display labels. A reference grants no access. */
export interface WorkspaceRef<Target extends WorkspaceRefTarget = WorkspaceRefTarget> {
  readonly workspaceId: string;
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
  if (left.workspaceId !== right.workspaceId || left.target.kind !== right.target.kind) return false;
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
