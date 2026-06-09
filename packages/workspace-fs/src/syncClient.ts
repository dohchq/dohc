import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  Actor,
  AssetKind,
  AtomKind,
  CreateAtomInput,
  RenameFileInput,
  SaveAssetInput,
  WorkspaceBackend,
  WorkspaceFile,
  WriteAtomInput,
} from "@dohc/workspace-contracts";
import { scanWorkspaceDiff, type FsDiffOperation } from "./diff";
import { materializeWorkspace } from "./materialize";
import {
  assertSafeWorkspacePath,
  assetKindForMediaType,
  atomKindForMediaType,
  isTextMediaType,
  mediaTypeForPath,
  resolveWorkspacePath,
} from "./metadata";
import { watchWorkspace, type WatchWorkspaceOptions } from "./watch";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type LocalSyncConflict = {
  path: string;
  conflictPath: string;
  reason: string;
};

export type LocalSyncApprovalRequest = {
  path: string;
  reason: string;
};

export type LocalSyncResult = {
  applied: number;
  conflicts: LocalSyncConflict[];
  approvalRequests: LocalSyncApprovalRequest[];
};

export type CreateLocalSyncClientOptions = {
  rootDir: string;
  workspaceId: string;
  baseUrl: string;
  fetch?: FetchLike;
  actor?: Actor;
};

export type LocalSyncClient = {
  materialize(): Promise<void>;
  pullRemote(): Promise<LocalSyncResult>;
  syncLocalChanges(): Promise<LocalSyncResult>;
  watch(options?: Partial<Omit<WatchWorkspaceOptions, "rootDir" | "onChange">>): () => void;
};

type ApiSyncOperation =
  | {
      op: "create";
      path: string;
      kind: AtomKind | AssetKind;
      mediaType: string;
      body?: string;
      bytesBase64?: string;
    }
  | {
      op: "update";
      path: string;
      expectedRevision: string;
      kind: AtomKind | AssetKind;
      mediaType: string;
      body?: string;
      bytesBase64?: string;
    }
  | { op: "delete"; path: string; expectedRevision: string }
  | { op: "rename"; fromPath: string; toPath: string; expectedRevision: string };

export function createLocalSyncClient({
  rootDir,
  workspaceId,
  baseUrl,
  fetch: fetchImpl = fetch,
  actor = { userId: "local-sync", workspaceId },
}: CreateLocalSyncClientOptions): LocalSyncClient {
  const backend = createHttpWorkspaceBackend({ baseUrl, workspaceId, fetch: fetchImpl });
  const materialize = async () => {
    await materializeWorkspace({
      backend,
      actor,
      targetDir: rootDir,
      backendMode: "postgres",
    });
  };

  return {
    materialize,
    async pullRemote() {
      const local = await localOperations(rootDir);
      if (local.length === 0) {
        await materialize();
        return emptyResult();
      }

      const conflicts = await writeDirtyPullConflicts(rootDir, local);
      await materialize();
      return {
        applied: 0,
        conflicts,
        approvalRequests: [],
      };
    },
    async syncLocalChanges() {
      const local = await localOperations(rootDir);
      if (local.length === 0) return emptyResult();

      const conflicts = await detectRevisionConflicts(rootDir, backend, actor, local);
      if (conflicts.length > 0) {
        await materialize();
        return {
          applied: 0,
          conflicts,
          approvalRequests: [],
        };
      }

      const operations = await Promise.all(local.map((operation) => enrichOperation(rootDir, operation)));
      try {
        const result = await postJson<{ ok: true; applied: number }>(
          fetchImpl,
          workspaceUrl(baseUrl, workspaceId, "sync/apply"),
          { operations },
        );
        await materialize();
        return {
          applied: result.applied,
          conflicts: [],
          approvalRequests: [],
        };
      } catch (error) {
        if (isApprovalError(error)) {
          return {
            applied: 0,
            conflicts: [],
            approvalRequests: [
              {
                path: error.path ?? firstOperationPath(local),
                reason: error.message,
              },
            ],
          };
        }
        throw error;
      }
    },
    watch(options) {
      return watchWorkspace({
        rootDir,
        onChange: () => {
          void this.syncLocalChanges();
        },
        ...options,
      });
    },
  };
}

export function createHttpWorkspaceBackend({
  baseUrl,
  workspaceId,
  fetch: fetchImpl = fetch,
}: {
  baseUrl: string;
  workspaceId: string;
  fetch?: FetchLike;
}): WorkspaceBackend {
  return {
    async listFiles() {
      const data = await getJson<{ ok: true; files: WorkspaceFile[] }>(
        fetchImpl,
        workspaceUrl(baseUrl, workspaceId, "files"),
      );
      return data.files;
    },
    async readText(_actor, path) {
      const data = await getJson<{ ok: true; file: WorkspaceFile & { body?: string; revision: string } }>(
        fetchImpl,
        workspaceUrl(baseUrl, workspaceId, `files/${encodePath(path)}`),
      );
      if (typeof data.file.body !== "string") {
        throw new Error(`not a text file: ${path}`);
      }
      return { body: data.file.body, revision: data.file.revision };
    },
    async readAsset(_actor, path) {
      const data = await getJson<{
        ok: true;
        file: WorkspaceFile & {
          contentType: string;
          bytesBase64?: string;
          revision: string;
        };
      }>(fetchImpl, workspaceUrl(baseUrl, workspaceId, `files/${encodePath(path)}`));
      if (!data.file.bytesBase64) {
        throw new Error(`not an asset file: ${path}`);
      }
      return {
        mediaType: data.file.contentType,
        kind: assetKindForMediaType(data.file.contentType, path),
        bytes: Buffer.from(data.file.bytesBase64, "base64"),
        revision: data.file.revision,
      };
    },
    async createAtom(_actor, input: CreateAtomInput) {
      const data = await postJson<{ ok: true; file: WorkspaceFile }>(
        fetchImpl,
        workspaceUrl(baseUrl, workspaceId, `files/${encodePath(input.path)}`),
        input,
      );
      return data.file;
    },
    async writeAtom(_actor, input: WriteAtomInput) {
      const data = await postJson<{ ok: true; file: WorkspaceFile }>(
        fetchImpl,
        workspaceUrl(baseUrl, workspaceId, `files/${encodePath(input.path)}`),
        input,
      );
      return data.file;
    },
    async saveAsset(_actor, input: SaveAssetInput) {
      const data = await postJson<{ ok: true; file: WorkspaceFile }>(
        fetchImpl,
        workspaceUrl(baseUrl, workspaceId, "assets"),
        {
          path: input.path,
          kind: input.kind,
          mediaType: input.mediaType,
          bytesBase64: Buffer.from(input.bytes).toString("base64"),
        },
      );
      return data.file;
    },
    async renameFile(_actor, input: RenameFileInput) {
      const fromFolder = input.fromPath.includes("/") ? input.fromPath.slice(0, input.fromPath.lastIndexOf("/")) : "";
      const toPath = fromFolder ? `${fromFolder}/${input.toName}` : input.toName;
      const data = await postJson<{ ok: true; files: WorkspaceFile[] }>(
        fetchImpl,
        workspaceUrl(baseUrl, workspaceId, "sync/apply"),
        {
          operations: [
            {
              op: "rename",
              fromPath: input.fromPath,
              toPath,
              expectedRevision: input.expectedRevision,
            },
          ],
        },
      );
      const file = data.files[0];
      if (!file) throw new Error(`rename did not return a file: ${input.fromPath}`);
      return file;
    },
    async deleteFile(_actor, path) {
      await postJson<{ ok: true }>(fetchImpl, workspaceUrl(baseUrl, workspaceId, "sync/apply"), {
        operations: [{ op: "delete", path }],
      });
    },
  };
}

async function localOperations(rootDir: string): Promise<FsDiffOperation[]> {
  const diff = await scanWorkspaceDiff(rootDir);
  return diff.operations.filter((operation) => !isConflictOperation(operation));
}

function isConflictOperation(operation: FsDiffOperation) {
  if (operation.op === "rename") {
    return operation.fromPath.endsWith(".conflict") || operation.toPath.endsWith(".conflict");
  }
  return operation.path.endsWith(".conflict");
}

async function detectRevisionConflicts(
  rootDir: string,
  backend: WorkspaceBackend,
  actor: Actor,
  operations: FsDiffOperation[],
): Promise<LocalSyncConflict[]> {
  const conflicts: LocalSyncConflict[] = [];
  for (const operation of operations) {
    const expectedRevision = "expectedRevision" in operation ? operation.expectedRevision : undefined;
    if (!expectedRevision) continue;
    const path = operation.op === "rename" ? operation.fromPath : operation.path;
    const remoteRevision = await readRemoteRevision(backend, actor, path);
    if (remoteRevision !== expectedRevision) {
      conflicts.push(await writeConflictFile(rootDir, operation, "remote revision changed before local sync"));
    }
  }
  return conflicts;
}

async function writeDirtyPullConflicts(rootDir: string, operations: FsDiffOperation[]): Promise<LocalSyncConflict[]> {
  return await Promise.all(
    operations
      .filter((operation) => operation.op === "update" || operation.op === "delete")
      .map((operation) => writeConflictFile(rootDir, operation, "remote pull found uncommitted local changes")),
  );
}

async function readRemoteRevision(backend: WorkspaceBackend, actor: Actor, path: string) {
  const files = await backend.listFiles(actor);
  const file = files.find((candidate) => candidate.path === path);
  if (!file) return undefined;
  if (file.kind === "atom") return (await backend.readText(actor, path)).revision;
  return (await backend.readAsset(actor, path)).revision;
}

async function writeConflictFile(
  rootDir: string,
  operation: FsDiffOperation,
  reason: string,
): Promise<LocalSyncConflict> {
  const path = operation.op === "rename" ? operation.toPath : operation.path;
  const conflictPath = assertSafeWorkspacePath(`${path}.conflict`);
  const fullPath = resolveWorkspacePath(rootDir, conflictPath);
  await mkdir(dirname(fullPath), { recursive: true });
  const localBody = operation.op === "delete" ? "" : await readLocalConflictBody(rootDir, path);
  await writeFile(
    fullPath,
    [
      `dohc conflict for ${path}`,
      `reason: ${reason}`,
      "",
      "local content:",
      localBody,
    ].join("\n"),
    "utf8",
  );
  return { path, conflictPath, reason };
}

async function readLocalConflictBody(rootDir: string, path: string) {
  const bytes = await readFile(resolveWorkspacePath(rootDir, path));
  return new TextDecoder().decode(bytes);
}

async function enrichOperation(rootDir: string, operation: FsDiffOperation): Promise<ApiSyncOperation> {
  if (operation.op === "delete" || operation.op === "rename") return operation;

  const path = assertSafeWorkspacePath(operation.path);
  const mediaType = operation.op === "create" ? operation.mediaType : mediaTypeForPath(path);
  const bytes = await readFile(resolveWorkspacePath(rootDir, path));
  if (isTextMediaType(mediaType, path)) {
    return {
      ...operation,
      kind: atomKindForMediaType(mediaType, path),
      mediaType,
      body: new TextDecoder().decode(bytes),
    };
  }
  return {
    ...operation,
    kind: assetKindForMediaType(mediaType, path),
    mediaType,
    bytesBase64: Buffer.from(bytes).toString("base64"),
  };
}

async function getJson<T>(fetchImpl: FetchLike, url: string): Promise<T> {
  return await readApiResponse<T>(await fetchImpl(url));
}

async function postJson<T>(fetchImpl: FetchLike, url: string, body: unknown): Promise<T> {
  return await readApiResponse<T>(
    await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function readApiResponse<T>(response: Response): Promise<T> {
  const body = await response.json() as { ok?: boolean; error?: string; code?: string; path?: string };
  if (!response.ok || body.ok === false) {
    const error = new Error(body.error ?? response.statusText) as Error & { code?: string; path?: string };
    error.code = body.code;
    error.path = body.path;
    throw error;
  }
  return body as T;
}

function workspaceUrl(baseUrl: string, workspaceId: string, path: string) {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}/workspaces/${encodeURIComponent(workspaceId)}/${path}`;
}

function encodePath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function isApprovalError(error: unknown): error is Error & { code?: string; path?: string } {
  return (
    error instanceof Error &&
    (("code" in error && error.code === "approval-required") || /approval/i.test(error.message))
  );
}

function firstOperationPath(operations: FsDiffOperation[]) {
  const first = operations[0];
  if (!first) return "unknown";
  return first.op === "rename" ? first.fromPath : first.path;
}

function emptyResult(): LocalSyncResult {
  return { applied: 0, conflicts: [], approvalRequests: [] };
}
