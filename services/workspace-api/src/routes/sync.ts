import type {
  Actor,
  AssetKind,
  AtomKind,
  WorkspaceBackend,
  WorkspaceFile,
} from "@dohc/workspace-contracts";

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

export async function applyWorkspaceSync(
  backend: WorkspaceBackend,
  actor: Actor,
  request: ApplySyncRequest,
) {
  if (!Array.isArray(request.operations)) {
    throw new Error("sync apply requires an operations array");
  }

  const files: WorkspaceFile[] = [];
  let applied = 0;
  for (const operation of request.operations) {
    try {
      const file = await applyOperation(backend, actor, operation);
      if (file) files.push(file);
      applied += 1;
    } catch (error) {
      attachOperationPath(error, operation);
      throw error;
    }
  }

  return { ok: true, applied, files };
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
    return await backend.saveAsset(actor, {
      path: operation.path,
      kind: operation.kind ?? "file",
      mediaType: operation.mediaType ?? "application/octet-stream",
      bytes: bytesFromOperation(operation),
    });
  }

  if (operation.op === "delete") {
    await backend.deleteFile(actor, operation.path);
    return null;
  }

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

function attachOperationPath(error: unknown, operation: WorkspaceSyncOperation) {
  if (!error || typeof error !== "object") return;
  const path = operation.op === "rename" ? operation.fromPath : operation.path;
  (error as { path?: string }).path = path;
}
