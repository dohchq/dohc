import { createHash } from "node:crypto";
import { classifyEngineFilePath } from "@dohc/security-contract/engine-path-floor";
import type {
  PullShareViewResult,
  SyncRelayConnection,
} from "@dohc/workspace-contracts/relay";
import {
  VERSIONED_METHOD,
  VersionedLoopbackEngine,
  type JsonValue,
  type Request as EngineRequest,
  type Response as EngineResponse,
} from "@dohc/workspace-engine-client";
import {
  EngineRequestError,
  EngineWorkspaceSessions,
  type EngineDaemonClient,
} from "@dohc/workspace-engine-client/daemon";
import {
  EngineRelayClient,
  RelayConfiguredDaemonClientSource,
  RelayTransportRouteGuard,
} from "../workspaces/engineRelayClient";
import {
  createCaptureLiveStores,
  type CaptureVersionedTextStore,
} from "../workspaces/workspaceEngineCaptureLiveStore";

// A daemon double for the RECIPIENT side of a relay share, built so the
// desktop share-view and share-mount suites can drive their production code
// paths — EngineRelayClient.pullShareView and createCaptureLiveStores — with
// no legacy TypeScript engine store anywhere in the picture.
//
// It lives here rather than beside the other loopbacks in
// packages/workspace-engine-client because share.view.pull is not part of that
// package's versioned surface: the transport has to reach an HTTP relay double
// and it wires desktop-only modules (engineRelayClient,
// workspaceEngineCaptureLiveStore). Putting it in the package would drag relay
// wire concepts into a package that deliberately knows nothing about them.
// `src/testing/` is already the desktop home for cross-suite test helpers.
//
// What is real here and what is not:
//  - REAL: the versioned file state. Ops replay through VersionedLoopbackEngine
//    as ordinary `versionedText.write` / `versionedText.delete` calls, and
//    `versionedText.list` answers with true sha256 and contentKind. That is
//    what `repairSharedViewProjection` compares disk against, so the repair
//    tests exercise real state rather than a canned answer.
//  - REAL: the relay HTTP conversation. The log is paged, blobs are fetched by
//    sha256 and hash-verified, and the bearer token comes from what
//    `workspace.open` was told — so a wrong token or a revoked share reaches
//    the same 401 / 404 translation the daemon produces.
//  - NOT REAL: the grant. This double serves whatever the relay double put in
//    the log; it does not re-check `grantedSelector`. Containment is the Rust
//    share boundary's job (`crates/dohc-engine-sync/src/share.rs`) and is
//    tested there. Do not read a passing test here as proof a scope holds.
//    For the same reason its pull answers with NO refusals: it refuses
//    nothing, because it checks nothing.
//  - NOT REAL: durability. Cursors and file state live in this object, so they
//    survive a `workspace.close` (as the daemon's SQLite would) but not the
//    process. Anything that must be proven ON DISK needs a real daemon.

const SHARE_LOG_PAGE_LIMIT = 500;
const REPLAYABLE_ORIGINS = new Set([
  "api",
  "local-file",
  "restore",
  "sync",
  "unknown",
]);

interface ShareLogPage {
  ops: Array<{
    relaySeq: number;
    opKind: string;
    payload: unknown;
  }>;
  nextCursor: number;
  hasMore: boolean;
}

interface OpenWorkspaceState {
  rootDir: string;
  relay: { baseUrl: string; bearerToken: string } | null;
}

interface ChangedPath {
  [key: string]: JsonValue | undefined;
  path: string;
  operation: "write" | "delete";
  contentKind: "text" | "binary";
}

function sha256Hex(value: Uint8Array | string): string {
  return createHash("sha256")
    .update(typeof value === "string" ? Buffer.from(value, "utf8") : value)
    .digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requiredString(
  params: Record<string, unknown>,
  key: string,
  method: string,
): string {
  const value = stringField(params, key);
  if (value === null) throw new Error(`${method}.${key} must be a string.`);
  return value;
}

function replayOrigin(payload: Record<string, unknown>): string {
  const metadata = asRecord(payload.metadata);
  const origin = metadata === null ? null : stringField(metadata, "origin");
  return origin !== null && REPLAYABLE_ORIGINS.has(origin) ? origin : "sync";
}

// The client-side path gate the legacy recipient replay also applies: a
// misbehaving relay must not be able to plant secret-classified or untracked
// paths into the local view.
function pathReplayable(path: string): boolean {
  return classifyEngineFilePath(path).kind === "tracked";
}

export class ShareViewLoopbackTransport implements EngineDaemonClient {
  /** Every request the production client sent, in order. */
  readonly requests: EngineRequest[] = [];

  private readonly loopback = new VersionedLoopbackEngine();
  private readonly openWorkspaces = new Map<string, OpenWorkspaceState>();
  // The recipient's durable fetch cursor, one row per workspace — the daemon's
  // `sync_relay_cursors`. It is PRIVATE and only `sync.commitCursor` moves it.
  // A pull that advanced it directly would still make every "the second
  // refresh reports unchanged" assertion pass while proving nothing about
  // cursor persistence, which is exactly the hollow test this models away from.
  private readonly committedCursors = new Map<string, number>();
  private readonly relayFetch: NonNullable<SyncRelayConnection["fetch"]>;
  private nextLoopbackRequestId = 1;

  constructor(relayFetch: SyncRelayConnection["fetch"]) {
    if (relayFetch === undefined) {
      throw new Error(
        "ShareViewLoopbackTransport needs the share relay double's fetch.",
      );
    }
    this.relayFetch = relayFetch;
  }

  /** The committed cursor, so a test can assert persistence directly. */
  committedCursor(workspaceId: string): number {
    return this.committedCursors.get(workspaceId) ?? 0;
  }

  async sendRequest(request: EngineRequest): Promise<EngineResponse> {
    this.requests.push(request);
    const params = asRecord(request.params) ?? {};
    switch (request.method) {
      case "workspace.open":
        return { id: request.id, result: this.openWorkspace(params) };
      case "workspace.close":
        return { id: request.id, result: { closed: true } };
      case "share.view.pull":
        return {
          id: request.id,
          result: await this.pullShareView(request, params),
        };
      case "sync.commitCursor":
        return { id: request.id, result: this.commitCursor(request, params) };
      default:
        return await this.loopback.sendRequest(request);
    }
  }

  close(): void {}

  private openWorkspace(params: Record<string, unknown>): JsonValue {
    const workspaceId = requiredString(params, "workspaceId", "workspace.open");
    const rootDir = requiredString(params, "rootDir", "workspace.open");
    const relay = asRecord(params.relay);
    this.openWorkspaces.set(workspaceId, {
      rootDir,
      relay:
        relay === null
          ? null
          : {
              baseUrl: requiredString(relay, "baseUrl", "workspace.open.relay"),
              bearerToken: requiredString(
                relay,
                "bearerToken",
                "workspace.open.relay",
              ),
            },
    });
    // The handle IS the workspace id, which is what keeps the loopback's
    // per-workspace state and this transport's cursor rows in step. Two mounts
    // of one share in different hosts therefore get separate state, the way
    // two daemon workspaces would.
    return { workspace: workspaceId };
  }

  private commitCursor(
    request: EngineRequest,
    params: Record<string, unknown>,
  ): JsonValue {
    const workspaceId = requiredString(
      params,
      "workspaceId",
      "sync.commitCursor",
    );
    const cursor = asRecord(params.pendingCursor);
    if (cursor === null) {
      throw new Error("sync.commitCursor.pendingCursor must be an object.");
    }
    const kind = requiredString(cursor, "kind", "sync.commitCursor.pendingCursor");
    if (kind !== "shareView") {
      throw this.refuse(
        request,
        "INVALID_PARAMS",
        `sync.commitCursor cannot commit a ${kind} cursor here.`,
      );
    }
    const token = requiredString(
      cursor,
      "token",
      "sync.commitCursor.pendingCursor",
    );
    const next = Number(token);
    if (!Number.isSafeInteger(next) || next < 0) {
      throw new Error(`sync.commitCursor got an unusable cursor: ${token}`);
    }
    // Monotonic, like the daemon's row: a rewind would silently re-replay the
    // whole share instead of surfacing the bug that produced it.
    if (next < this.committedCursor(workspaceId)) {
      throw new Error(
        `sync.commitCursor tried to rewind ${workspaceId} to ${next}.`,
      );
    }
    this.committedCursors.set(workspaceId, next);
    return { committed: true, sharingDeclined: [] };
  }

  private async pullShareView(
    request: EngineRequest,
    params: Record<string, unknown>,
  ): Promise<JsonValue> {
    const workspaceId = requiredString(params, "workspaceId", "share.view.pull");
    const shareId = requiredString(params, "shareId", "share.view.pull");
    const open = this.openWorkspaces.get(workspaceId);
    if (open === undefined) {
      throw this.refuse(
        request,
        "WORKSPACE_UNAVAILABLE",
        "workspace operation failed",
      );
    }
    const relay = open.relay;
    if (relay === null) {
      throw this.refuse(
        request,
        "INVALID_PARAMS",
        "share.view.pull needs a relay-configured workspace.open.",
      );
    }
    const since = this.committedCursor(workspaceId);
    const page = await this.fetchLogPage(request, relay, shareId, since);

    const main = asRecord(
      await this.loopbackRequest(
        workspaceId,
        VERSIONED_METHOD.versionsEnsureMain,
        { workspaceId },
      ),
    );
    const versionId = main === null ? "main" : (stringField(main, "id") ?? "main");
    const changed = new Map<string, ChangedPath>();
    let applied = 0;

    const snapshot = async (path: string) =>
      asRecord(
        await this.loopbackRequest(workspaceId, VERSIONED_METHOD.textRead, {
          versionId,
          path,
        }),
      );

    const applyWrite = async (
      path: string,
      blobSha256: string,
      contentKind: "text" | "binary",
      origin: string,
    ): Promise<void> => {
      if (!pathReplayable(path)) return;
      const existing = await snapshot(path);
      if (
        existing !== null &&
        (stringField(existing, "contentKind") ?? "text") === contentKind &&
        stringField(existing, "sha256") === blobSha256
      ) {
        // Content-identical replay: nothing to write, but the path stays in the
        // change set so a crash between the store write and the disk write is
        // repaired by the retry (the legacy recipient replay does the same).
        changed.set(path, { path, operation: "write", contentKind });
        return;
      }
      const bytes = await this.fetchBlob(request, relay, shareId, blobSha256);
      if (contentKind === "binary") {
        await this.loopbackRequest(workspaceId, VERSIONED_METHOD.binaryWrite, {
          workspaceId,
          versionId,
          path,
          bytesBase64: Buffer.from(bytes).toString("base64"),
          origin,
        });
      } else {
        await this.loopbackRequest(workspaceId, VERSIONED_METHOD.textWrite, {
          workspaceId,
          versionId,
          path,
          text: Buffer.from(bytes).toString("utf8"),
          origin,
        });
      }
      applied += 1;
      changed.set(path, { path, operation: "write", contentKind });
    };

    const applyDelete = async (path: string, origin: string): Promise<void> => {
      if (!pathReplayable(path)) return;
      const existing = await snapshot(path);
      if (existing === null) {
        // Already gone from the store; a crash-retry may still owe the disk a
        // delete, so keep the path in the change set.
        changed.set(path, { path, operation: "delete", contentKind: "text" });
        return;
      }
      await this.loopbackRequest(workspaceId, VERSIONED_METHOD.textDelete, {
        workspaceId,
        versionId,
        path,
        origin,
      });
      applied += 1;
      changed.set(path, {
        path,
        operation: "delete",
        contentKind:
          (stringField(existing, "contentKind") ?? "text") === "binary"
            ? "binary"
            : "text",
      });
    };

    // Replay in relay order: per-origin causality is the relay log's append
    // order, and a read-only view needs no cross-origin merge.
    for (const op of page.ops) {
      const payload = asRecord(op.payload);
      if (payload === null) continue;
      if (op.opKind === "moment.append") {
        const origin = replayOrigin(payload);
        const operation = stringField(payload, "operation");
        const path = stringField(payload, "path");
        const afterPath = stringField(payload, "payloadAfterPath") ?? path;
        const beforePath = stringField(payload, "payloadBeforePath");
        const afterSha = stringField(payload, "payloadAfterBlobSha256");
        const contentKind =
          stringField(payload, "payloadAfterContentKind") === "binary"
            ? "binary"
            : "text";
        if (operation === "delete" && path !== null) {
          await applyDelete(path, origin);
        } else if (
          operation === "rename" &&
          beforePath !== null &&
          afterPath !== null &&
          afterSha !== null
        ) {
          if (beforePath !== afterPath) await applyDelete(beforePath, origin);
          await applyWrite(afterPath, afterSha, contentKind, origin);
        } else if (
          operation === "write" &&
          afterPath !== null &&
          afterSha !== null
        ) {
          await applyWrite(afterPath, afterSha, contentKind, origin);
        }
        continue;
      }
      if (op.opKind === "version.create") {
        const snapshots = Array.isArray(payload.forkSnapshots)
          ? payload.forkSnapshots
          : [];
        for (const raw of snapshots) {
          const entry = asRecord(raw);
          if (entry === null) continue;
          const path = stringField(entry, "path");
          const sha = stringField(entry, "blobSha256");
          if (path === null || sha === null) continue;
          await applyWrite(
            path,
            sha,
            stringField(entry, "contentKind") === "binary" ? "binary" : "text",
            "sync",
          );
        }
      }
      // workspace.init and anything unrecognized: nothing to replay.
    }

    return {
      fetched: page.ops.length,
      applied,
      skipped: page.ops.length - applied,
      // Always empty, and honestly so: this double does not enforce the grant
      // (see the header), so it never refuses an op. The field is present
      // because the daemon's response shape carries it and the client decodes
      // it strictly.
      refusals: [],
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
      changedPaths: [...changed.values()],
      // Opaque to the caller, and the ONLY way the cursor above advances.
      pendingCursor: { kind: "shareView", token: String(page.nextCursor) },
    };
  }

  private async fetchLogPage(
    request: EngineRequest,
    relay: { baseUrl: string; bearerToken: string },
    shareId: string,
    since: number,
  ): Promise<ShareLogPage> {
    const response = await this.shareFetch(
      request,
      relay,
      `/sync/shares/${encodeURIComponent(shareId)}/log?since=${since}&limit=${SHARE_LOG_PAGE_LIMIT}`,
    );
    const body = asRecord(await response.json());
    const ops = body !== null && Array.isArray(body.ops) ? body.ops : [];
    const nextCursor =
      body !== null && typeof body.nextCursor === "number"
        ? body.nextCursor
        : since;
    return {
      ops: ops.map((raw) => {
        const op = asRecord(raw) ?? {};
        return {
          relaySeq: Number(op.relaySeq ?? 0),
          opKind: stringField(op, "opKind") ?? "",
          payload: op.payload,
        };
      }),
      nextCursor,
      hasMore: body !== null && body.hasMore === true,
    };
  }

  private async fetchBlob(
    request: EngineRequest,
    relay: { baseUrl: string; bearerToken: string },
    shareId: string,
    sha256: string,
  ): Promise<Uint8Array> {
    const response = await this.shareFetch(
      request,
      relay,
      `/sync/shares/${encodeURIComponent(shareId)}/blobs/${sha256}`,
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (sha256Hex(bytes) !== sha256) {
      throw new Error(`Shared blob ${sha256} failed hash verification.`);
    }
    return bytes;
  }

  private async shareFetch(
    request: EngineRequest,
    relay: { baseUrl: string; bearerToken: string },
    path: string,
  ): Promise<globalThis.Response> {
    const response = await this.relayFetch(
      `${relay.baseUrl.replace(/\/+$/u, "")}${path}`,
      { headers: { authorization: `Bearer ${relay.bearerToken}` } },
    );
    if (response.status === 401) {
      throw this.refuse(request, "AUTH_FAILED", "relay rejected the token");
    }
    // The relay answers EVERY recipient denial — revoked, not yours, never
    // existed — with one generic 404, and the daemon reports them all as an
    // unavailable share.
    if (response.status === 404) {
      throw this.refuse(request, "SHARE_UNAVAILABLE", "workspace operation failed");
    }
    if (!response.ok) {
      throw new Error(`Share request failed (${response.status})`);
    }
    return response;
  }

  private async loopbackRequest(
    workspaceId: string,
    method: string,
    params: Record<string, JsonValue | undefined>,
  ): Promise<JsonValue> {
    const response = await this.loopback.sendRequest({
      id: this.nextLoopbackRequestId++,
      method,
      workspace: workspaceId,
      params: params as JsonValue,
    });
    return response.result;
  }

  private refuse(
    request: EngineRequest,
    code: "AUTH_FAILED" | "SHARE_UNAVAILABLE" | "WORKSPACE_UNAVAILABLE" | "INVALID_PARAMS",
    message: string,
  ): Error {
    return new EngineRequestError(request.id, { code, message, retry: "no" });
  }
}

export interface ShareViewDaemonHarness {
  readonly transport: ShareViewLoopbackTransport;
  readonly sessions: EngineWorkspaceSessions;
  readonly routes: RelayTransportRouteGuard;
  /**
   * The relay connection a production caller passes down to
   * refreshSharedViewOnce / refreshShareMountOnce. It deliberately carries NO
   * `fetch`: the only route to the relay double is through the daemon
   * transport, so nothing in the exercised path can quietly bypass it.
   */
  readonly relay: SyncRelayConnection;
  /** A daemon-backed store for one workspace, through production wiring. */
  openStore(workspace: {
    workspaceId: string;
    rootPath: string;
  }): CaptureVersionedTextStore;
  /** The production `pullShareView` for one workspace, as refresh's `pull`. */
  pullFor(target: {
    workspaceId: string;
    rootPath: string;
    shareMount?: true;
  }): (input: {
    shareId: string;
    grantedSelector: { paths: string[]; versionId: string | null };
  }) => Promise<PullShareViewResult>;
  closeAll(): Promise<void>;
}

/**
 * Wires the transport above into the production daemon path: the relay route
 * guard, the relay-configured client source, EngineWorkspaceSessions,
 * EngineRelayClient, and createCaptureLiveStores. Nothing here reimplements a
 * production behaviour — the test drives the same objects main.ts does.
 *
 * Pass the share relay double's connection (baseUrl, token, fetch). The
 * baseUrl and token flow through `workspace.open`, so the double's
 * authorization check is genuinely exercised.
 */
export function createShareViewDaemonHarness(
  relay: SyncRelayConnection,
): ShareViewDaemonHarness {
  const transport = new ShareViewLoopbackTransport(relay.fetch);
  const routes = new RelayTransportRouteGuard();
  const sessions = new EngineWorkspaceSessions(
    new RelayConfiguredDaemonClientSource(
      { currentClient: () => transport },
      routes,
    ),
    { transportRebindAttempts: 1 },
  );
  const live = new EngineRelayClient({
    sessions,
    routes,
    requestDeadlineMs: 5_000,
  });
  const bound: SyncRelayConnection = {
    baseUrl: relay.baseUrl,
    token: relay.token,
  };
  return {
    transport,
    sessions,
    routes,
    relay: bound,
    openStore(workspace) {
      // Bind before opening: `workspace.open` only carries relay configuration
      // for a workspace whose route is already bound, and a mount's repair pass
      // opens the store before the first pull. Production does the same —
      // EngineRelayClient.bind runs before the refresh.
      live.bind({ ...workspace, relay: bound });
      return createCaptureLiveStores(workspace, sessions).store;
    },
    pullFor(target) {
      const client = live.bind({ ...target, relay: bound });
      return async ({ shareId, grantedSelector }) =>
        await client.pullShareView({ shareId, grantedSelector });
    },
    async closeAll() {
      await sessions.closeAll();
    },
  };
}
