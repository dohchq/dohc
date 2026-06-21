import type {
  Actor,
  AssetKind,
  AtomKind,
  WorkspaceBackend,
  WorkspaceFile,
} from "@dohc/workspace-contracts";
import { dirname } from "node:path";
import { assertBase64Size } from "./files";

export type WorkspaceSyncOperation =
  | {
      op: "create";
      path: string;
      kind?: AtomKind | AssetKind;
      mediaType?: string;
      body?: string;
      bytesBase64?: string;
    }
  | {
      op: "update";
      path: string;
      expectedRevision: string;
      kind?: AssetKind;
      mediaType?: string;
      body?: string;
      bytesBase64?: string;
    }
  | {
      op: "delete";
      path: string;
      expectedRevision?: string;
    }
  | {
      op: "rename";
      fromPath: string;
      toPath: string;
      expectedRevision: string;
    };

export type ApplySyncRequest = {
  operations: WorkspaceSyncOperation[];
};

// Per-op outcome so a mid-batch failure does NOT wedge the whole workspace:
// the client advances its baseline only for ops that report ok, and retries
// the failed ones cleanly on the next push. file carries the new revision so
// the client can rebuild the baseline without a post-push rescan.
export type SyncOpResult = {
  path: string;
  ok: boolean;
  error?: string;
  file?: WorkspaceFile | null;
};

const MAX_SYNC_ASSET_BYTES = 10 * 1024 * 1024;
const APPROVAL_ERROR_REASONS = new Set([
  "approval required",
  "approval-required",
  "site-publish-required",
]);

export async function applyWorkspaceSync(
  backend: WorkspaceBackend,
  actor: Actor,
  request: ApplySyncRequest,
) {
  if (!Array.isArray(request.operations)) {
    throw new Error("sync apply requires an operations array");
  }

  // Structural validation is a CONTRACT violation, not a per-op data failure:
  // reject the whole batch (400) so a malformed client is told to fix itself,
  // rather than silently dropping the bad op. The client decomposes
  // cross-folder renames into delete+create before it ever reaches here.
  for (const operation of request.operations) {
    if (operation.op === "rename" && dirname(operation.fromPath) !== dirname(operation.toPath)) {
      const error = new Error("cross-folder renames are not supported by workspace sync");
      (error as { path?: string }).path = operation.fromPath;
      throw error;
    }
  }

  const files: WorkspaceFile[] = [];
  const results: SyncOpResult[] = [];
  let applied = 0;
  // Resilient (not fail-fast): every operation is attempted independently and
  // reports its own outcome. A single failing op (stale revision, oversize,
  // transient) no longer blocks the ops behind it, and the client never has to
  // surgically un-wedge a half-applied batch.
  for (const operation of request.operations) {
    const path = operationPath(operation);
    try {
      const file = await applyOperation(backend, actor, operation);
      if (file) files.push(file);
      applied += 1;
      results.push({ path, ok: true, file });
    } catch (error) {
      results.push({ path, ok: false, error: errorMessage(error) });
    }
  }

  return { ok: true, applied, files, results };
}

function operationPath(operation: WorkspaceSyncOperation): string {
  return operation.op === "rename" ? operation.toPath : operation.path;
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error && "code" in error) {
    const code = String((error as { code?: unknown }).code);
    if (APPROVAL_ERROR_REASONS.has(code)) return code;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

async function applyOperation(
  backend: WorkspaceBackend,
  actor: Actor,
  operation: WorkspaceSyncOperation,
): Promise<WorkspaceFile | null> {
  if (operation.op === "create") {
    if (operation.body !== undefined) {
      return await backend.createAtom(actor, {
        path: operation.path,
        kind: atomKind(operation.kind),
        body: operation.body,
      });
    }
    return await backend.saveAsset(actor, {
      path: operation.path,
      kind: assetKind(operation.kind),
      mediaType: operation.mediaType ?? "application/octet-stream",
      bytes: bytesFromOperation(operation),
    });
  }

  if (operation.op === "update") {
    if (operation.body !== undefined) {
      return await backend.writeAtom(actor, {
        path: operation.path,
        expectedRevision: operation.expectedRevision,
        body: operation.body,
      });
    }
    // Binary update: updateAsset (NOT saveAsset, which is create-only) so the
    // expectedRevision arbitrates instead of last-writer-wins.
    return await backend.updateAsset(actor, {
      path: operation.path,
      expectedRevision: operation.expectedRevision,
      kind: operation.kind ?? "file",
      mediaType: operation.mediaType ?? "application/octet-stream",
      bytes: bytesFromOperation(operation),
    });
  }

  if (operation.op === "delete") {
    await backend.deleteFile(actor, operation.path, operation.expectedRevision);
    return null;
  }

  // Cross-folder renames are pre-validated (rejected) in applyWorkspaceSync.
  const toName = operation.toPath.includes("/")
    ? operation.toPath.slice(operation.toPath.lastIndexOf("/") + 1)
    : operation.toPath;
  return await backend.renameFile(actor, {
    fromPath: operation.fromPath,
    toName,
    expectedRevision: operation.expectedRevision,
  });
}

function bytesFromOperation(operation: Extract<WorkspaceSyncOperation, { op: "create" | "update" }>) {
  if (!operation.bytesBase64) {
    throw new Error("binary sync operations require bytesBase64");
  }
  assertBase64Size(operation.bytesBase64, MAX_SYNC_ASSET_BYTES, "sync asset operation");
  return Buffer.from(operation.bytesBase64, "base64");
}

function atomKind(kind: AtomKind | AssetKind | undefined): AtomKind {
  if (kind === "csv" || kind === "json" || kind === "html" || kind === "text" || kind === "markdown") {
    return kind;
  }
  return "markdown";
}

function assetKind(kind: AtomKind | AssetKind | undefined): AssetKind {
  if (
    kind === "image" ||
    kind === "pdf" ||
    kind === "audio" ||
    kind === "video" ||
    kind === "sqlite" ||
    kind === "csv" ||
    kind === "json" ||
    kind === "file"
  ) {
    return kind;
  }
  return "file";
}
