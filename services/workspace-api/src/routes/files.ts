import type {
  Actor,
  AssetKind,
  AtomKind,
  WorkspaceBackend,
  WorkspaceFile,
} from "@dohc/workspace-contracts";

export type WriteTextFileRequest = {
  expectedRevision?: string;
  body: string;
  kind?: AtomKind;
};

export type UploadAssetRequest = {
  path: string;
  kind: AssetKind;
  mediaType: string;
  bytesBase64: string;
};

export async function listWorkspaceFiles(backend: WorkspaceBackend, actor: Actor) {
  return {
    ok: true,
    files: await backend.listFiles(actor),
  };
}

export async function readWorkspaceFile(backend: WorkspaceBackend, actor: Actor, path: string) {
  const metadata = await requireWorkspaceFile(backend, actor, path);
  if (metadata.kind === "atom") {
    const read = await backend.readText(actor, path);
    return {
      ok: true,
      file: {
        ...metadata,
        body: read.body,
        revision: read.revision,
      },
    };
  }

  const read = await backend.readAsset(actor, path);
  return {
    ok: true,
    file: {
      ...metadata,
      contentType: read.mediaType,
      revision: read.revision,
      bytesBase64: Buffer.from(read.bytes).toString("base64"),
    },
  };
}

export async function writeWorkspaceTextFile(
  backend: WorkspaceBackend,
  actor: Actor,
  path: string,
  input: WriteTextFileRequest,
) {
  if (typeof input.body !== "string") {
    throw new Error("text file writes require a body string");
  }
  const file = input.expectedRevision
    ? await backend.writeAtom(actor, {
        path,
        expectedRevision: input.expectedRevision,
        body: input.body,
      })
    : await backend.createAtom(actor, {
        path,
        kind: input.kind ?? "markdown",
        body: input.body,
      });
  return { ok: true, file };
}

export async function uploadWorkspaceAsset(
  backend: WorkspaceBackend,
  actor: Actor,
  input: UploadAssetRequest,
) {
  if (!input.path || !input.kind || !input.mediaType || !input.bytesBase64) {
    throw new Error("asset uploads require path, kind, mediaType, and bytesBase64");
  }
  const file = await backend.saveAsset(actor, {
    path: input.path,
    kind: input.kind,
    mediaType: input.mediaType,
    bytes: Buffer.from(input.bytesBase64, "base64"),
  });
  return { ok: true, file };
}

async function requireWorkspaceFile(
  backend: WorkspaceBackend,
  actor: Actor,
  path: string,
): Promise<WorkspaceFile> {
  const files = await backend.listFiles(actor);
  const file = files.find((candidate) => candidate.path === path);
  if (!file) {
    throw new Error(`file not found: ${path}`);
  }
  return file;
}
