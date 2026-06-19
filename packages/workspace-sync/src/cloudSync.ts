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

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  assertSafeWorkspacePath,
  CorruptManifestError,
  enrichOperation,
  isConflictOperation,
  MAX_INLINE_FILE_SIZE,
  readManifest,
  resolveWorkspacePath,
  mediaTypeForPath,
  sha256,
  scanWorkspaceFiles,
  scanWorkspaceDiff,
  type FsDiffOperation,
  type ScannedWorkspaceFile,
  writeManifest,
  type WorkspaceManifest,
  type WorkspaceManifestEntry,
} from "@dohc/workspace-fs";

export interface MergeSyncResult {
  pushed: number;
  pulled: number;
  deletedLocally: number;
  pushedPaths: string[];
  pulledPaths: string[];
  deletedLocalPaths: string[];
  // Workspace-relative paths whose remote content landed as <path>.conflict.
  conflicts: string[];
  // Files skipped (e.g. too large for the server cap) so the UI can surface
  // them; they stay out of the baseline so they retry if shrunk later.
  skipped: string[];
}

interface RemoteFile {
  id: string;
  path: string;
  kind: WorkspaceManifestEntry["kind"];
  contentType: string;
  revision: string;
}

// Mirrors the server's per-op result; file carries the new revision so the
// baseline rebuilds without a post-push rescan.
type SyncOpFile = Pick<RemoteFile, "id" | "kind" | "contentType" | "revision">;
type SyncOpResult = { path: string; ok: boolean; error?: string; file?: SyncOpFile | null };

export interface MergeSync {
  // Creates the empty sync baseline for a workspace that has never synced.
  initialize(): Promise<void>;
  // Local -> cloud: scan-diff against the baseline, apply, refresh baseline.
  push(): Promise<MergeSyncResult>;
  // Cloud -> local, merging (see header comment).
  pull(): Promise<MergeSyncResult>;
}

// Raised when the manifest's server binding does not match the engine's
// configured server: refuse all sync rather than mass-delete clean local files
// against the wrong (or empty) remote.
export class ServerBindingMismatchError extends Error {}

// Raised when the server returns 401: the session token is expired/revoked.
// The engine stops retrying and surfaces "session expired — reconnect" rather
// than spinning forever while claiming "connected".
export class UnauthorizedSyncError extends Error {
  readonly status = 401;
}

const EMPTY_RESULT: MergeSyncResult = {
  pushed: 0,
  pulled: 0,
  deletedLocally: 0,
  pushedPaths: [],
  pulledPaths: [],
  deletedLocalPaths: [],
  conflicts: [],
  skipped: [],
};

export function createMergeSync({
  rootDir,
  remoteWorkspaceId,
  serverUrl,
  token,
  fetch: base = fetch,
}: CloudSyncOptions): MergeSync {
  const authedFetch = createAuthorizedFetch(token, base);
  const normalizedServerUrl = serverUrl.replace(/\/+$/, "");
  const apiBase = `${normalizedServerUrl}/workspaces/${encodeURIComponent(remoteWorkspaceId)}`;

  async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await authedFetch(`${apiBase}/${path}`, init);
    if (response.status === 401) {
      throw new UnauthorizedSyncError("cloud session expired or revoked (401)");
    }
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

  // Read the baseline AND verify the server binding: a baseline produced
  // against a different server/workspace must never drive deletes here.
  async function readBoundManifest(): Promise<WorkspaceManifest> {
    const manifest = await readManifest(rootDir);
    const boundServer = manifest.serverUrl?.replace(/\/+$/, "");
    if (
      (boundServer !== undefined && boundServer !== normalizedServerUrl) ||
      (manifest.remoteWorkspaceId !== undefined &&
        manifest.remoteWorkspaceId !== remoteWorkspaceId)
    ) {
      throw new ServerBindingMismatchError(
        `sync manifest is bound to ${manifest.serverUrl ?? "?"}/${manifest.remoteWorkspaceId ?? "?"}, ` +
          `not ${normalizedServerUrl}/${remoteWorkspaceId} — refusing to sync`,
      );
    }
    return manifest;
  }

  function assertNotMetadata(path: string): void {
    if (path === ".dohc" || path.startsWith(".dohc/")) {
      throw new Error(`remote file path collides with dohc metadata: ${path}`);
    }
  }

  // The server caps inline binaries; text atoms are uncapped. A create/update
  // whose scanned size exceeds the cap is skipped (kept out of the baseline)
  // rather than wedging the whole push.
  function isOversize(scanned: ScannedWorkspaceFile | undefined): boolean {
    return !!scanned && scanned.size > MAX_INLINE_FILE_SIZE;
  }

  // Cross-folder renames are rejected server-side; with the partial unique
  // index a delete+create is safe and content-equivalent. Same-folder renames
  // stay as rename ops.
  function decomposeRenames(operations: FsDiffOperation[]): FsDiffOperation[] {
    const out: FsDiffOperation[] = [];
    for (const operation of operations) {
      if (
        operation.op === "rename" &&
        dirname(operation.fromPath) !== dirname(operation.toPath)
      ) {
        out.push({ op: "delete", path: operation.fromPath, expectedRevision: operation.expectedRevision });
        out.push({ op: "create", path: operation.toPath, mediaType: mediaTypeFor(operation.toPath) });
        continue;
      }
      out.push(operation);
    }
    return out;
  }

  return {
    async initialize() {
      try {
        await readManifest(rootDir);
        return;
      } catch (error) {
        // CORRUPT is not "fresh": resetting it to empty would re-create and
        // conflict-spam every previously-synced file. Only a genuinely ABSENT
        // manifest (ENOENT) starts an empty baseline.
        if (error instanceof CorruptManifestError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await writeManifest(rootDir, {
        version: 1,
        workspaceId: remoteWorkspaceId,
        backend: "postgres",
        serverUrl: normalizedServerUrl,
        remoteWorkspaceId,
        files: {},
      });
    },

    async push() {
      const { manifest, operations, scanned } = await scanWorkspaceDiff(rootDir);
      // Bind/verify even on push so a re-pointed engine fails loudly here too.
      await readBoundManifest();
      const scannedByPath = new Map(scanned.map((file) => [file.path, file]));

      const skipped: string[] = [];
      const candidate = decomposeRenames(
        operations.filter((operation) => !isConflictOperation(operation)),
      ).filter((operation) => {
        if (operation.op === "create" || operation.op === "update") {
          if (isOversize(scannedByPath.get(operation.path))) {
            skipped.push(operation.path);
            return false;
          }
        }
        return true;
      });

      if (candidate.length === 0) {
        await writeManifest(rootDir, withBinding(manifest));
        return { ...EMPTY_RESULT, skipped };
      }

      const enriched = await Promise.all(
        candidate.map((operation) => enrichOperation(rootDir, operation)),
      );
      const { applied, results } = await api<{ applied: number; results: SyncOpResult[] }>(
        "sync/apply",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ operations: enriched }),
        },
      );

      // Build the new baseline from the T0 scan hashes + the per-op revisions
      // the server returned — NEVER a post-push rescan. Only ops that reported
      // ok advance the baseline, so a partial failure leaves the rest pending
      // for a clean retry, and an edit during the push window stays dirty.
      const files = { ...manifest.files };
      const okResults = results.filter((result) => result.ok);
      const okByPath = new Map(okResults.map((result) => [result.path, result]));
      for (const operation of candidate) {
        const path = operation.op === "rename" ? operation.toPath : operation.path;
        const result = okByPath.get(path);
        if (operation.op === "rename") {
          if (result) delete files[operation.fromPath];
        }
        if (operation.op === "delete") {
          if (result) delete files[operation.path];
          continue;
        }
        if (!result?.file) continue; // failed op: leave baseline untouched (still pending)
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

      await writeManifest(rootDir, withBinding({ ...manifest, files }));
      return {
        pushed: applied,
        pulled: 0,
        deletedLocally: 0,
        pushedPaths: okResults.map((result) => result.path),
        pulledPaths: [],
        deletedLocalPaths: [],
        conflicts: [],
        skipped,
      };
    },

    async pull() {
      const manifest = await readBoundManifest();
      const diskFiles = await scanWorkspaceFiles(rootDir);
      const cleanLocalRenames = detectCleanLocalRenames(manifest, diskFiles);
      const remote = await listRemote();
      const remotePaths = new Set(remote.map((file) => file.path));
      const files = { ...manifest.files };
      let pulled = 0;
      let deletedLocally = 0;
      const pulledPaths: string[] = [];
      const deletedLocalPaths: string[] = [];
      const conflicts: string[] = [];

      for (const file of remote) {
        const path = assertSafeWorkspacePath(file.path);
        // The server is outside the local trust boundary: a hostile or buggy
        // remote must never write into dohc's own metadata. *.conflict markers
        // are local-only artifacts; never pull them down.
        assertNotMetadata(path);
        if (path.endsWith(".conflict")) continue;

        const entry = files[path];
        const liveSha = await diskSha(rootDir, path);

        // Baseline current AND nothing changed remotely: local state (clean or
        // mid-edit) is exactly where it should be.
        if (entry && entry.revision === file.revision) continue;

        const read = await api<{
          file: { revision: string; body?: string; bytesBase64?: string };
        }>(`files/${path.split("/").map(encodeURIComponent).join("/")}`);
        const bytes =
          read.file.body !== undefined
            ? Buffer.from(read.file.body, "utf8")
            : Buffer.from(read.file.bytesBase64 ?? "", "base64");
        const remoteSha = sha256(bytes);

        // LOCAL DELETION: a baseline entry whose local file is gone is a local
        // change (the user deleted it), NOT a clean slot to fill. Never
        // resurrect: land the remote content beside it as .conflict and leave
        // the baseline so the deletion still pushes.
        if (entry && liveSha === null) {
          const cleanRename = cleanLocalRenames.get(path);
          const targetStillClean = cleanRename
            ? (await diskSha(rootDir, cleanRename.path)) === cleanRename.sha256
            : false;
          if (cleanRename && targetStillClean && !remotePaths.has(cleanRename.path)) {
            await writeWorkspaceFile(rootDir, cleanRename.path, bytes);
            pulled += 1;
            pulledPaths.push(cleanRename.path);
            files[path] = baselineEntry(file, read.file.revision, remoteSha);
            continue;
          }
          await writeWorkspaceFile(rootDir, `${path}.conflict`, bytes);
          conflicts.push(path);
          pulledPaths.push(`${path}.conflict`);
          continue;
        }

        // SELF-HEAL: if the fetched bytes already match the live local file,
        // just adopt them into the baseline (revision + sha) without rewriting
        // the file or spawning a spurious conflict. This recovers any wedge
        // where the baseline drifted (corrupt/empty/partial push) but disk is
        // actually in sync.
        if (liveSha !== null && liveSha === remoteSha) {
          files[path] = baselineEntry(file, read.file.revision, remoteSha);
          continue;
        }

        // Dirty: the live local file differs from BOTH the baseline and the
        // remote. (Re-hashing live disk — not an initial scan — catches an
        // edit made mid-pull.) Land remote beside it for a human merge; do NOT
        // advance the baseline, so the local edit still pushes.
        const dirty = liveSha !== null && (!entry || liveSha !== entry.sha256);
        if (dirty) {
          await writeWorkspaceFile(rootDir, `${path}.conflict`, bytes);
          conflicts.push(path);
          pulledPaths.push(`${path}.conflict`);
          continue;
        }

        await writeWorkspaceFile(rootDir, path, bytes);
        pulled += 1;
        pulledPaths.push(path);
        files[path] = baselineEntry(file, read.file.revision, remoteSha);
      }

      // Baseline paths absent remotely. A still-present local copy that matches
      // the baseline (clean) follows the remote deletion. A LOCALLY-DELETED
      // file (baseline entry, no local file) is a local change, NOT a clean
      // follow: write remote content as .conflict instead of resurrecting it.
      for (const [path, entry] of Object.entries(manifest.files)) {
        if (remotePaths.has(path)) continue;
        if (path.endsWith(".conflict")) {
          delete files[path];
          continue;
        }
        const liveSha = await diskSha(rootDir, path);
        if (liveSha === null) {
          // Locally deleted; remote also gone — nothing to resurrect. The
          // deletion will push on the next push (entry dropped from baseline).
          delete files[path];
          continue;
        }
        if (liveSha === entry.sha256) {
          await rm(resolveWorkspacePath(rootDir, path), { force: true });
          deletedLocally += 1;
          deletedLocalPaths.push(path);
        }
        // Dirty local copy stays; entry drops so the next push re-creates it.
        delete files[path];
      }

      await writeManifest(rootDir, withBinding({ ...manifest, files }));
      return {
        pushed: 0,
        pulled,
        deletedLocally,
        pushedPaths: [],
        pulledPaths,
        deletedLocalPaths,
        conflicts,
        skipped: [],
      };
    },
  };

  function withBinding(manifest: WorkspaceManifest): WorkspaceManifest {
    return { ...manifest, serverUrl: normalizedServerUrl, remoteWorkspaceId };
  }
}

function detectCleanLocalRenames(
  manifest: WorkspaceManifest,
  diskFiles: ScannedWorkspaceFile[],
): Map<string, ScannedWorkspaceFile> {
  const diskByPath = new Map(diskFiles.map((file) => [file.path, file]));
  const missingBySha = new Map<string, string[]>();
  const createdBySha = new Map<string, ScannedWorkspaceFile[]>();

  for (const [path, entry] of Object.entries(manifest.files)) {
    if (!entry.sha256 || path.endsWith(".conflict") || diskByPath.has(path)) continue;
    const paths = missingBySha.get(entry.sha256) ?? [];
    paths.push(path);
    missingBySha.set(entry.sha256, paths);
  }

  for (const file of diskFiles) {
    if (file.path.endsWith(".conflict") || manifest.files[file.path]) continue;
    const files = createdBySha.get(file.sha256) ?? [];
    files.push(file);
    createdBySha.set(file.sha256, files);
  }

  const renames = new Map<string, ScannedWorkspaceFile>();
  for (const [sha, missingPaths] of missingBySha) {
    const createdFiles = createdBySha.get(sha) ?? [];
    if (missingPaths.length !== 1 || createdFiles.length !== 1) continue;
    renames.set(missingPaths[0]!, createdFiles[0]!);
  }
  return renames;
}

function baselineEntry(file: RemoteFile, revision: string, sha: string): WorkspaceManifestEntry {
  return {
    id: file.id,
    kind: file.kind,
    contentType: file.contentType,
    revision,
    sha256: sha,
  };
}

function mediaTypeFor(path: string): string {
  // Re-derive on the create half of a decomposed rename; enrichOperation maps
  // it to the proper atom/asset kind.
  return mediaTypeForPath(path);
}

async function writeWorkspaceFile(rootDir: string, path: string, bytes: Buffer): Promise<void> {
  const safe = assertSafeWorkspacePath(path);
  const target = resolveWorkspacePath(rootDir, safe);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
}

// Live content hash of a workspace file, or null if it does not exist. Read
// IMMEDIATELY before any overwrite/delete decision so a mid-pull edit is seen.
async function diskSha(rootDir: string, path: string): Promise<string | null> {
  const target = resolveWorkspacePath(rootDir, path);
  try {
    await stat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return sha256(await readFile(target));
}
