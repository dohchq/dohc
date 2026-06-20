import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  Actor,
  AssetKind,
  AtomKind,
  CreateAtomInput,
  RenameFileInput,
  SaveAssetInput,
  UpdateAssetInput,
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
  writeManifest,
  type WorkspaceManifest,
} from "./metadata";
import type { ScannedWorkspaceFile } from "./scan";
import { watchWorkspace, type WatchWorkspaceOptions } from "./watch";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type LocalSyncConflict = {
  path: string;
  conflictPath: string;
  reason: string;
};

type PendingLocalSyncConflict = LocalSyncConflict & {
  localBody: string;
};

function toLocalSyncConflict({
  path,
  conflictPath,
  reason,
}: PendingLocalSyncConflict): LocalSyncConflict {
  return { path, conflictPath, reason };
}

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

export type ApiSyncOperation =
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

      const conflicts = await collectDirtyPullConflicts(rootDir, local);
      await materialize();
      await writeConflictFiles(rootDir, conflicts);
      return {
        applied: 0,
        conflicts: conflicts.map(toLocalSyncConflict),
        approvalRequests: [],
      };
    },
    async syncLocalChanges() {
      const diff = await scanWorkspaceDiff(rootDir);
      const local = diff.operations.filter((operation) => !isConflictOperation(operation));
      if (local.length === 0) return emptyResult();

      const conflicts = await detectRevisionConflicts(rootDir, backend, actor, local);
      if (conflicts.length > 0) {
        await materialize();
        await writeConflictFiles(rootDir, conflicts);
        return {
          applied: 0,
          conflicts: conflicts.map(toLocalSyncConflict),
          approvalRequests: [],
        };
      }

      const operations = await Promise.all(local.map((operation) => enrichOperation(rootDir, operation)));
      try {
        // sync/apply is per-op (non-fail-fast): a 200 can still carry failed
        // ops in results[]. Approval-required failures surface as
        // approvalRequests; any other per-op failure is a real error we raise.
        const result = await postJson<{
          ok: true;
          applied: number;
          results?: Array<{ path: string; ok: boolean; error?: string; file?: WorkspaceFile | null }>;
        }>(fetchImpl, workspaceUrl(baseUrl, workspaceId, "sync/apply"), { operations });
        const failures = (result.results ?? []).filter((entry) => !entry.ok);
        const approvals = failures.filter((entry) => /approval/i.test(entry.error ?? ""));
        const hardFailure = failures.find((entry) => !/approval/i.test(entry.error ?? ""));
        if (hardFailure) {
          throw new Error(hardFailure.error ?? "sync apply failed");
        }
        if (approvals.length > 0) {
          await writeSuccessfulSyncBaseline(rootDir, diff.manifest, diff.scanned, local, result.results ?? []);
          return {
            applied: result.applied,
            conflicts: [],
            approvalRequests: approvals.map((entry) => ({
              path: entry.path,
              reason: entry.error ?? "approval required",
            })),
          };
        }
        await materialize();
        return {
          applied: result.applied,
          conflicts: [],
          approvalRequests: [],
        };
      } catch (error) {
        // Fallback for a server that still THROWS an approval error instead of
        // returning a per-op failure (older deployments).
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
    async updateAsset(_actor, input: UpdateAssetInput) {
      // Binary update rides the sync/apply update op so the server's
      // updateAsset arbitrates on expectedRevision.
      const data = await postJson<{ ok: true; files: WorkspaceFile[]; results?: Array<{ ok: boolean; error?: string }> }>(
        fetchImpl,
        workspaceUrl(baseUrl, workspaceId, "sync/apply"),
        {
          operations: [
            {
              op: "update",
              path: input.path,
              expectedRevision: input.expectedRevision,
              kind: input.kind,
              mediaType: input.mediaType,
              bytesBase64: Buffer.from(input.bytes).toString("base64"),
            },
          ],
        },
      );
      const failed = data.results?.find((result) => !result.ok);
      if (failed) throw new Error(failed.error ?? `update failed: ${input.path}`);
      const file = data.files[0];
      if (!file) throw new Error(`update did not return a file: ${input.path}`);
      return file;
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
    async deleteFile(_actor, path, expectedRevision) {
      const data = await postJson<{ ok: true; results?: Array<{ ok: boolean; error?: string }> }>(
        fetchImpl,
        workspaceUrl(baseUrl, workspaceId, "sync/apply"),
        {
          operations: [{ op: "delete", path, expectedRevision }],
        },
      );
      const failed = data.results?.find((result) => !result.ok);
      if (failed) throw new Error(failed.error ?? `delete failed: ${path}`);
    },
  };
}

async function writeSuccessfulSyncBaseline(
  rootDir: string,
  manifest: WorkspaceManifest,
  scanned: ScannedWorkspaceFile[],
  operations: FsDiffOperation[],
  results: Array<{ path: string; ok: boolean; file?: WorkspaceFile | null }>,
) {
  const scannedByPath = new Map(scanned.map((file) => [file.path, file]));
  const okByPath = new Map(results.filter((result) => result.ok).map((result) => [result.path, result]));
  const files = { ...manifest.files };

  for (const operation of operations) {
    const path = operation.op === "rename" ? operation.toPath : operation.path;
    const result = okByPath.get(path);
    if (!result) continue;

    if (operation.op === "rename") {
      delete files[operation.fromPath];
    }
    if (operation.op === "delete") {
      delete files[operation.path];
      continue;
    }
    if (!result.file) continue;
    const scannedFile = scannedByPath.get(path);
    if (!scannedFile) continue;
    files[path] = {
      id: result.file.id,
      kind: result.file.kind,
      contentType: result.file.contentType,
      revision: result.file.revision,
      sha256: scannedFile.sha256,
    };
  }

  await writeManifest(rootDir, { ...manifest, files });
}

async function localOperations(rootDir: string): Promise<FsDiffOperation[]> {
  const diff = await scanWorkspaceDiff(rootDir);
  return diff.operations.filter((operation) => !isConflictOperation(operation));
}

// Conflict markers (<path>.conflict) are LOCAL working artifacts only — never
// upload them, or they propagate to every machine and cascade.
export function isConflictOperation(operation: FsDiffOperation) {
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
): Promise<PendingLocalSyncConflict[]> {
  const conflicts: PendingLocalSyncConflict[] = [];
  for (const operation of operations) {
    const expectedRevision = "expectedRevision" in operation ? operation.expectedRevision : undefined;
    if (!expectedRevision) continue;
    const path = operation.op === "rename" ? operation.fromPath : operation.path;
    const remoteRevision = await readRemoteRevision(backend, actor, path);
    if (remoteRevision !== expectedRevision) {
      conflicts.push(await collectConflictFile(rootDir, operation, "remote revision changed before local sync"));
    }
  }
  return conflicts;
}

async function collectDirtyPullConflicts(rootDir: string, operations: FsDiffOperation[]): Promise<PendingLocalSyncConflict[]> {
  return await Promise.all(
    operations
      .filter((operation) => operation.op === "update" || operation.op === "delete")
      .map((operation) => collectConflictFile(rootDir, operation, "remote pull found uncommitted local changes")),
  );
}

async function readRemoteRevision(backend: WorkspaceBackend, actor: Actor, path: string) {
  if (backend.getFileMetadata) {
    const file = await backend.getFileMetadata(actor, path);
    if (!file) return undefined;
    if (file.kind === "atom") return (await backend.readText(actor, path)).revision;
    return (await backend.readAsset(actor, path)).revision;
  }
  const files = await backend.listFiles(actor);
  const file = files.find((candidate) => candidate.path === path);
  if (!file) return undefined;
  if (file.kind === "atom") return (await backend.readText(actor, path)).revision;
  return (await backend.readAsset(actor, path)).revision;
}

async function collectConflictFile(
  rootDir: string,
  operation: FsDiffOperation,
  reason: string,
): Promise<PendingLocalSyncConflict> {
  const path = operation.op === "rename" ? operation.toPath : operation.path;
  const conflictPath = assertSafeWorkspacePath(`${path}.conflict`);
  const localBody = operation.op === "delete" ? "" : await readLocalConflictBody(rootDir, path);
  return { path, conflictPath, reason, localBody };
}

async function writeConflictFiles(
  rootDir: string,
  conflicts: PendingLocalSyncConflict[],
) {
  for (const conflict of conflicts) {
    await writeConflictFile(rootDir, conflict);
  }
}

async function writeConflictFile(
  rootDir: string,
  conflict: PendingLocalSyncConflict,
) {
  const fullPath = resolveWorkspacePath(rootDir, conflict.conflictPath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(
    fullPath,
    [
      `dohc conflict for ${conflict.path}`,
      `reason: ${conflict.reason}`,
      "",
      "local content:",
      conflict.localBody,
    ].join("\n"),
    "utf8",
  );
}

async function readLocalConflictBody(rootDir: string, path: string) {
  const bytes = await readFile(resolveWorkspacePath(rootDir, path));
  return new TextDecoder().decode(bytes);
}

export async function enrichOperation(rootDir: string, operation: FsDiffOperation): Promise<ApiSyncOperation> {
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
    (("code" in error &&
      (error.code === "approval-required" || error.code === "site-publish-required")) ||
      error.message === "approval required" ||
      error.message === "approval-required" ||
      error.message === "site-publish-required")
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
