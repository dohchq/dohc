import type {
  ActorNeutralWriteMetadata,
  WorkspaceId,
} from "@dohc/workspace-contracts/engine";
import {
  RelayUnauthorizedError,
  ShareUnavailableError,
  type PullShareViewResult,
  type ShareViewChangedPath,
  type SyncRelayConnection,
} from "@dohc/workspace-contracts/relay";
import { classifyEngineFilePath } from "./enginePathFloor";
import { createVersionedTextStore } from "./versionedTextStore";
import { openEngineDb, sha256Hex } from "./syncApply";

// PR 18 — the RECIPIENT side of a share grant: a read-only "shared view".
//
// Design (recorded in the execution log): the relay serves a recipient a
// server-side FILTERED op log (services/sync-relay shareFilter.ts is the
// security boundary). A filtered stream has per-origin sequence gaps by
// construction, and the engine's applyReplicationOp deliberately fails
// closed on gaps — so a shared view is NOT a sync replica. Instead the
// recipient REPLAYS the allowed ops as ordinary local engine writes into its
// own private store: files land on main, history moments accrue with the
// ops' original actor-neutral metadata, and search/history/browsing all work
// through the normal engine surfaces. The view never pushes anything back.

export interface ShareViewSelector {
  paths: string[];
  versionId: string | null;
}

export interface ShareViewInfo {
  shareId: string;
  granterUserId: string;
  granterEmail: string | null;
  selector: ShareViewSelector;
  createdAtMs: number;
}

interface SharedLogPage {
  ok: boolean;
  ops: Array<{
    relaySeq: number;
    originId: string;
    originSeq: number;
    opKind: string;
    payload: unknown;
    recordedAtMs: number;
  }>;
  nextCursor: number;
  hasMore: boolean;
}

function shareUrl(relay: SyncRelayConnection, path: string): string {
  return `${relay.baseUrl.replace(/\/+$/u, "")}${path}`;
}

async function shareFetch(
  relay: SyncRelayConnection,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${relay.token}`);
  const response = await (relay.fetch ?? fetch)(shareUrl(relay, path), { ...init, headers });
  if (response.status === 401) throw new RelayUnauthorizedError();
  // The relay's recipient routes answer EVERY denial (revoked, not yours,
  // never existed) with one generic 404 — surface them all as "unavailable".
  if (response.status === 404) throw new ShareUnavailableError();
  if (!response.ok) throw new Error(`Share request failed (${response.status})`);
  return response;
}

function parseSelector(value: unknown): ShareViewSelector {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as { paths?: unknown; versionId?: unknown })
      : {};
  const paths = Array.isArray(record.paths)
    ? record.paths.filter((path): path is string => typeof path === "string")
    : [];
  const versionId = typeof record.versionId === "string" ? record.versionId : null;
  return { paths, versionId };
}

export async function fetchShareViewInfo(input: {
  relay: SyncRelayConnection;
  shareId: string;
}): Promise<ShareViewInfo> {
  const response = await shareFetch(
    input.relay,
    `/sync/shares/${encodeURIComponent(input.shareId)}`,
  );
  const body = (await response.json()) as Record<string, unknown>;
  return {
    shareId: String(body.shareId ?? input.shareId),
    granterUserId: String(body.granterUserId ?? ""),
    granterEmail: typeof body.granterEmail === "string" ? body.granterEmail : null,
    selector: parseSelector(body.selector),
    createdAtMs: Number(body.createdAtMs ?? 0),
  };
}

async function fetchShareBlob(
  relay: SyncRelayConnection,
  shareId: string,
  sha256: string,
): Promise<Uint8Array> {
  const response = await shareFetch(
    relay,
    `/sync/shares/${encodeURIComponent(shareId)}/blobs/${sha256}`,
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (sha256Hex(bytes) !== sha256) {
    throw new Error(`Shared blob ${sha256} failed hash verification.`);
  }
  return bytes;
}

const SHARE_CURSOR_LIMIT = 500;

function readShareCursor(rootDir: string, workspaceId: WorkspaceId): number {
  const db = openEngineDb(rootDir);
  try {
    const row = db
      .prepare("SELECT relay_fetch_cursor FROM sync_relay_cursors WHERE workspace_id = ?")
      .get(workspaceId);
    return Number(row?.relay_fetch_cursor ?? 0);
  } finally {
    db.close();
  }
}

function writeShareCursor(rootDir: string, workspaceId: WorkspaceId, cursor: number): void {
  const db = openEngineDb(rootDir);
  try {
    db.prepare(
      `INSERT INTO sync_relay_cursors (workspace_id, relay_fetch_cursor)
       VALUES (?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET
         relay_fetch_cursor = excluded.relay_fetch_cursor`,
    ).run(workspaceId, cursor);
  } finally {
    db.close();
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

// Client-side secret/path gate — the third gate behind grant validation and
// the relay's per-op filter. A misbehaving or compromised relay must not be
// able to plant secret-classified or non-tracked paths into the local view.
function pathReplayable(path: string): boolean {
  return classifyEngineFilePath(path).kind === "tracked";
}

function writeMetadata(payload: Record<string, unknown>): ActorNeutralWriteMetadata {
  const metadata = asRecord(payload.metadata);
  const origin = metadata && typeof metadata.origin === "string" ? metadata.origin : "sync";
  const allowed = new Set(["api", "local-file", "restore", "sync", "unknown"]);
  const summary = metadata && typeof metadata.summary === "string" ? metadata.summary : undefined;
  return {
    origin: (allowed.has(origin) ? origin : "sync") as ActorNeutralWriteMetadata["origin"],
    ...(summary ? { summary } : {}),
  };
}

export async function pullShareView(input: {
  rootDir: string;
  workspaceId: WorkspaceId;
  relay: SyncRelayConnection;
  shareId: string;
}): Promise<PullShareViewResult> {
  const store = createVersionedTextStore(input.rootDir);
  try {
    const main = await store.ensureMainVersion({ workspaceId: input.workspaceId });
    const since = readShareCursor(input.rootDir, input.workspaceId);

    let cursor = since;
    let fetched = 0;
    const ops: SharedLogPage["ops"] = [];
    for (;;) {
      const page = (await (
        await shareFetch(
          input.relay,
          `/sync/shares/${encodeURIComponent(input.shareId)}/log?since=${cursor}&limit=${SHARE_CURSOR_LIMIT}`,
        )
      ).json()) as SharedLogPage;
      ops.push(...page.ops);
      fetched += page.ops.length;
      if (page.hasMore && page.nextCursor <= cursor) {
        throw new Error("Shared log pagination did not advance; aborting pull.");
      }
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    }

    let applied = 0;
    const changed = new Map<string, ShareViewChangedPath>();

    const currentSnapshot = async (path: string) =>
      store
        .readTextFile({ workspaceId: input.workspaceId, versionId: main.id, path })
        .catch(() => null);

    const applyWrite = async (
      path: string,
      blobSha256: string,
      contentKind: "text" | "binary",
      metadata: ActorNeutralWriteMetadata,
    ): Promise<void> => {
      if (!pathReplayable(path)) return;
      const existing = await currentSnapshot(path);
      if (existing && (existing.contentKind ?? "text") === contentKind) {
        const existingSha =
          existing.sha256 ?? (contentKind === "text" ? sha256Hex(existing.text) : undefined);
        if (existingSha === blobSha256) {
          // Content-identical replay: the store already holds this content,
          // so no engine write is needed. But the caller materializes disk
          // from changedPaths AFTER the store write and BEFORE committing the
          // cursor — a crash in that window leaves the store ahead of disk.
          // On retry this op is re-fetched (cursor uncommitted) and lands
          // here; keep the path in the change set so materialization re-runs
          // and the file reaches disk. `applied` is unchanged: nothing was
          // written to the store.
          changed.set(path, { path, operation: "write", contentKind });
          return;
        }
      }
      const bytes = await fetchShareBlob(input.relay, input.shareId, blobSha256);
      if (contentKind === "binary") {
        await store.writeBinaryFile({
          workspaceId: input.workspaceId,
          versionId: main.id,
          path,
          bytes,
          metadata,
        });
      } else {
        await store.writeTextFile({
          workspaceId: input.workspaceId,
          versionId: main.id,
          path,
          text: Buffer.from(bytes).toString("utf8"),
          metadata,
        });
      }
      applied += 1;
      changed.set(path, { path, operation: "write", contentKind });
    };

    const applyDelete = async (
      path: string,
      metadata: ActorNeutralWriteMetadata,
    ): Promise<void> => {
      if (!pathReplayable(path)) return;
      const existing = await currentSnapshot(path);
      if (!existing) {
        // Already gone from the store. On a crash-retry the file may still be
        // on disk (delete applied to the store but not yet materialized), so
        // keep the delete in the change set to re-run materialization. Disk
        // delete is force-removed, so a truly-absent file is a harmless no-op.
        changed.set(path, { path, operation: "delete", contentKind: "text" });
        return;
      }
      await store.deleteTextFile({
        workspaceId: input.workspaceId,
        versionId: main.id,
        path,
        metadata,
      });
      applied += 1;
      changed.set(path, {
        path,
        operation: "delete",
        contentKind: (existing.contentKind ?? "text") === "binary" ? "binary" : "text",
      });
    };

    // Replay in relay order: per-origin causality is preserved by the relay
    // log's append order, and a read-only view needs no cross-origin merge.
    for (const op of ops) {
      const payload = asRecord(op.payload);
      if (op.opKind === "moment.append" && payload) {
        const metadata = writeMetadata(payload);
        const operation = stringField(payload, "operation");
        const path = stringField(payload, "path");
        const afterPath = stringField(payload, "payloadAfterPath") ?? path;
        const beforePath = stringField(payload, "payloadBeforePath");
        const afterSha = stringField(payload, "payloadAfterBlobSha256");
        const contentKind =
          stringField(payload, "payloadAfterContentKind") === "binary" ? "binary" : "text";
        if (operation === "delete" && path) {
          await applyDelete(path, metadata);
        } else if (operation === "rename" && beforePath && afterPath && afterSha) {
          // Replayed as delete+write: the recipient's view keeps the moved
          // content without needing the granter's object identity.
          if (beforePath !== afterPath) await applyDelete(beforePath, metadata);
          await applyWrite(afterPath, afterSha, contentKind, metadata);
        } else if (operation === "write" && afterPath && afterSha) {
          await applyWrite(afterPath, afterSha, contentKind, metadata);
        }
        continue;
      }
      if (op.opKind === "version.create" && payload) {
        // A version share's initial state: the (server-redacted) fork
        // snapshots, replayed as plain writes onto the view's main.
        const snapshots = Array.isArray(payload.forkSnapshots) ? payload.forkSnapshots : [];
        for (const raw of snapshots) {
          const snapshot = asRecord(raw);
          if (!snapshot) continue;
          const path = stringField(snapshot, "path");
          const sha = stringField(snapshot, "blobSha256");
          if (!path || !sha) continue;
          const contentKind =
            stringField(snapshot, "contentKind") === "binary" ? "binary" : "text";
          await applyWrite(path, sha, contentKind, { origin: "sync" });
        }
        continue;
      }
      // workspace.init and anything unrecognized: nothing to replay.
    }

    const finalCursor = cursor;
    return {
      fetched,
      applied,
      changedPaths: [...changed.values()],
      nextCursor: finalCursor,
      commitCursor: async () => {
        writeShareCursor(input.rootDir, input.workspaceId, finalCursor);
      },
    };
  } finally {
    await store.close();
  }
}
