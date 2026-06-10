// Phase 9: cloud sync is the existing local sync engine pointed at the hosted
// server. The only additions are the device-session Bearer token and the
// liberal confirmation policy — ordinary edits flow without ceremony.

import { requiresReview, type ChangeSet } from "@dohc/workspace-core";
import {
  createLocalSyncClient,
  type FetchLike,
  type LocalSyncClient,
} from "@dohc/workspace-fs";

export type { FetchLike, LocalSyncClient } from "@dohc/workspace-fs";

export function createAuthorizedFetch(token: string, base: FetchLike = fetch): FetchLike {
  return (input, init) => {
    // Per fetch semantics init headers replace Request headers, so seed from
    // whichever set the caller actually provided before adding auth.
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.set("authorization", `Bearer ${token}`);
    return base(input, { ...init, headers });
  };
}

export type CloudSyncOptions = {
  rootDir: string;
  remoteWorkspaceId: string;
  serverUrl: string;
  token: string;
  fetch?: FetchLike;
};

export function createCloudSync({
  rootDir,
  remoteWorkspaceId,
  serverUrl,
  token,
  fetch: base = fetch,
}: CloudSyncOptions): LocalSyncClient {
  return createLocalSyncClient({
    rootDir,
    workspaceId: remoteWorkspaceId,
    baseUrl: serverUrl,
    fetch: createAuthorizedFetch(token, base),
  });
}

// Liberal by default: normal edits auto-sync; permission changes, public
// sharing, and other boundary crossings require explicit confirmation.
export function syncDecision(set: ChangeSet): "auto" | "needs-confirmation" {
  return requiresReview(set) ? "needs-confirmation" : "auto";
}

// ---------------------------------------------------------------------------
// Desktop merge sync. createLocalSyncClient's pull path re-MATERIALIZES the
// working copy (rm -rf + clone) — correct for the old disposable working
// copies, FATAL for a living desktop workspace whose .dohc (identity,
// history, op logs) and not-yet-pushed files must survive. This engine merges
// instead: push sends the scan-diff and refreshes the sync baseline in place;
// pull writes only what changed remotely, leaves dirty local files alone
// (remote content lands beside them as <path>.conflict), and never deletes
// anything the user touched since the last sync.
// ---------------------------------------------------------------------------

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  assertSafeWorkspacePath,
  enrichOperation,
  isTextMediaType,
  readManifest,
  resolveWorkspacePath,
  sha256,
  scanWorkspaceDiff,
  scanWorkspaceFiles,
  writeManifest,
  type WorkspaceManifest,
  type WorkspaceManifestEntry,
} from "@dohc/workspace-fs";

export interface MergeSyncResult {
  pushed: number;
  pulled: number;
  deletedLocally: number;
  // Workspace-relative paths whose remote content landed as <path>.conflict.
  conflicts: string[];
}

interface RemoteFile {
  id: string;
  path: string;
  kind: WorkspaceManifestEntry["kind"];
  contentType: string;
  revision: string;
}

export interface MergeSync {
  // Creates the empty sync baseline for a workspace that has never synced.
  initialize(): Promise<void>;
  // Local -> cloud: scan-diff against the baseline, apply, refresh baseline.
  push(): Promise<MergeSyncResult>;
  // Cloud -> local, merging (see header comment).
  pull(): Promise<MergeSyncResult>;
}

export function createMergeSync({
  rootDir,
  remoteWorkspaceId,
  serverUrl,
  token,
  fetch: base = fetch,
}: CloudSyncOptions): MergeSync {
  const authedFetch = createAuthorizedFetch(token, base);
  const apiBase = `${serverUrl.replace(/\/+$/, "")}/workspaces/${encodeURIComponent(remoteWorkspaceId)}`;

  async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await authedFetch(`${apiBase}/${path}`, init);
    const data = (await response.json()) as T & { ok?: boolean; error?: string };
    if (!response.ok || data.ok === false) {
      throw new Error(data.error ?? `sync request failed (${response.status}): ${path}`);
    }
    return data;
  }

  async function listRemote(): Promise<RemoteFile[]> {
    const { files } = await api<{ files: RemoteFile[] }>("files");
    return files;
  }

  // The baseline records, per path, the server revision and the LOCAL content
  // hash at the moment they matched — "dirty" means the file changed locally
  // since then.
  async function refreshBaseline(manifest: WorkspaceManifest): Promise<void> {
    const [remote, local] = await Promise.all([listRemote(), scanWorkspaceFiles(rootDir)]);
    const localByPath = new Map(local.map((file) => [file.path, file]));
    const files: WorkspaceManifest["files"] = {};
    for (const file of remote) {
      const localFile = localByPath.get(file.path);
      if (!localFile) continue;
      files[file.path] = {
        id: file.id,
        kind: file.kind,
        contentType: file.contentType,
        revision: file.revision,
        sha256: localFile.sha256,
      };
    }
    await writeManifest(rootDir, { ...manifest, files });
  }

  return {
    async initialize() {
      try {
        await readManifest(rootDir);
        return;
      } catch {
        // No baseline yet — first sync of this workspace.
      }
      await writeManifest(rootDir, {
        version: 1,
        workspaceId: remoteWorkspaceId,
        backend: "postgres",
        files: {},
      });
    },

    async push() {
      const { manifest, operations } = await scanWorkspaceDiff(rootDir);
      if (operations.length === 0) {
        return { pushed: 0, pulled: 0, deletedLocally: 0, conflicts: [] };
      }
      const enriched = await Promise.all(
        operations.map((operation) => enrichOperation(rootDir, operation)),
      );
      const { applied } = await api<{ applied: number }>("sync/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operations: enriched }),
      });
      await refreshBaseline(manifest);
      return { pushed: applied, pulled: 0, deletedLocally: 0, conflicts: [] };
    },

    async pull() {
      const manifest = await readManifest(rootDir);
      const [remote, local] = await Promise.all([listRemote(), scanWorkspaceFiles(rootDir)]);
      const localByPath = new Map(local.map((file) => [file.path, file]));
      const remotePaths = new Set(remote.map((file) => file.path));
      const files = { ...manifest.files };
      let pulled = 0;
      let deletedLocally = 0;
      const conflicts: string[] = [];

      for (const file of remote) {
        const path = assertSafeWorkspacePath(file.path);
        // The server is outside the local trust boundary: a hostile or buggy
        // remote must never write into dohc's own metadata (mirrors the
        // materialize() guard).
        if (path === ".dohc" || path.startsWith(".dohc/")) {
          throw new Error(`remote file path collides with dohc metadata: ${path}`);
        }
        const entry = files[path];
        const localFile = localByPath.get(path);
        // Baseline current and nothing changed remotely: local state (clean
        // or mid-edit) is exactly where it should be.
        if (entry && entry.revision === file.revision) continue;

        const read = await api<{
          file: { revision: string; body?: string; bytesBase64?: string };
        }>(`files/${path.split("/").map(encodeURIComponent).join("/")}`);
        const bytes =
          read.file.body !== undefined
            ? Buffer.from(read.file.body, "utf8")
            : Buffer.from(read.file.bytesBase64 ?? "", "base64");

        const dirty = localFile && (!entry || localFile.sha256 !== entry.sha256);
        if (dirty) {
          // Both sides changed: the user's file stays untouched; remote
          // content lands beside it for a human merge. The baseline is NOT
          // advanced, so the local edit still pushes (and the server-side
          // revision check arbitrates).
          const conflictPath = assertSafeWorkspacePath(`${path}.conflict`);
          const target = resolveWorkspacePath(rootDir, conflictPath);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, bytes);
          conflicts.push(path);
          continue;
        }

        const target = resolveWorkspacePath(rootDir, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes);
        pulled += 1;
        files[path] = {
          id: file.id,
          kind: file.kind,
          contentType: file.contentType,
          revision: read.file.revision,
          sha256: sha256(bytes),
        };
      }

      // Remote deletions: only a CLEAN local copy follows them; a dirty file
      // stays (the baseline entry drops, so the next push re-creates it).
      for (const [path, entry] of Object.entries(manifest.files)) {
        if (remotePaths.has(path)) continue;
        const localFile = localByPath.get(path);
        if (localFile && localFile.sha256 === entry.sha256) {
          await rm(resolveWorkspacePath(rootDir, path), { force: true });
          deletedLocally += 1;
        }
        delete files[path];
      }

      await writeManifest(rootDir, { ...manifest, files });
      return { pushed: 0, pulled, deletedLocally, conflicts };
    },
  };
}

