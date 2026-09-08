import { jsonResponse } from "@dohc/service-http";
import type { DiscussionActivityHub } from "./discussionActivity";
import { badRequest, notFound, relayError } from "./errors";
import { assertChatAuthorship, parseLogOp } from "./relayLogInputs";
import { parseCursor, parseLimit, parseString, parseWorkspaceId, readJsonObject } from "./requestInputs";
import type { EnforceWorkspaceIdentityResult, SyncRelayStorage } from "./storage";
import { MAX_OPS_PER_REQUEST, MAX_ORIGIN_ID_CHARS } from "./wireLimits";

export type WorkspaceReplicationRoute =
  | { route: "bootstrap"; workspaceId: string }
  | { route: "epoch"; workspaceId: string }
  | { route: "log"; workspaceId: string }
  | { route: "log-coordinate"; workspaceId: string; originId: string; originSeq: number };

const MAX_IDENTITY_BYTES = 512;

export function createWorkspaceReplicationRoutes(
  storage: Pick<SyncRelayStorage,
    | "claimWorkspace"
    | "claimWorkspaceIdentity"
    | "getWorkspaceBootstrap"
    | "rotateWorkspaceIdentity"
    | "appendLogBatch"
    | "fetchLogPage"
    | "fetchLogCoordinate"
    | "getWorkspaceIdentity"
    | "verifyWorkspaceIdentity"
    | "getEpochLogFloor"
  >,
  nowMs: () => number,
  discussionActivity: Pick<DiscussionActivityHub, "wake">,
) {
  async function respondToWorkspaceRegistration(
    request: Request,
    actor: { userId: string },
  ): Promise<Response> {
    if (request.method === "POST") {
      const input = await readJsonObject(request);
      const workspaceId = parseWorkspaceId(input.workspaceId);
      // Parse before claimWorkspace mutates storage: a malformed partial
      // identity must not reserve a brand-new workspace row.
      const identity = parseOptionalWorkspaceIdentity(input);
      const result = storage.claimWorkspace({
        workspaceId,
        ownerUserId: actor.userId,
        createdAtMs: nowMs(),
      });
      if (result === "not-owner") throw notFound();
      if (identity !== null) {
        assertWorkspaceIdentityResult(
          storage.claimWorkspaceIdentity({ workspaceId, ...identity }),
        );
      }
      return jsonResponse({ ok: true, workspaceId, created: result === "created" });
    }

    throw relayError("method_not_allowed");
  }

  async function respondToWorkspaceReplication(
    request: Request,
    route: WorkspaceReplicationRoute,
    actor: { userId: string },
  ): Promise<Response> {
    if (route.route === "bootstrap" && request.method === "GET") {
      const bootstrap = storage.getWorkspaceBootstrap(route.workspaceId);
      return jsonResponse({
        ok: true,
        hasContent: bootstrap.hasContent,
        replicationEpoch: bootstrap.identity?.replicationEpoch ?? null,
        streamIdentity: bootstrap.identity?.streamIdentity ?? null,
      });
    }
    if (route.route === "bootstrap") throw relayError("method_not_allowed");

    if (route.route === "epoch" && request.method === "POST") {
      const input = await readJsonObject(request);
      const replicationEpoch = parseWorkspaceIdentityValue(
        input.replicationEpoch,
        "replicationEpoch",
      );
      const streamIdentity = parseWorkspaceIdentityValue(
        input.streamIdentity,
        "streamIdentity",
      );
      const result = storage.rotateWorkspaceIdentity({
        workspaceId: route.workspaceId,
        ownerUserId: actor.userId,
        replicationEpoch,
        streamIdentity,
        rotatedAtMs: nowMs(),
      });
      if (result === "not-owner") throw notFound();
      if (result === "epoch-superseded") throw relayError("epoch_superseded");
      return jsonResponse({
        ok: true,
        rotated: result === "rotated",
        replicationEpoch,
        streamIdentity,
      });
    }
    if (route.route === "epoch") throw relayError("method_not_allowed");

    if (route.route === "log" && request.method === "POST") {
      const input = await readJsonObject(request);
      const identity = parseOptionalWorkspaceIdentity(input);
      const originId = parseString(input.originId, "originId", MAX_ORIGIN_ID_CHARS);
      if (!Array.isArray(input.ops)) throw badRequest("ops must be an array");
      if (input.ops.length > MAX_OPS_PER_REQUEST) throw badRequest("too many ops");
      // MU-C0 verified authorship — the trust boundary. Every chat op that
      // names an author must claim the authenticated pusher. The relay refuses
      // authorless messages and unknown chat ops. This check runs before
      // parseLogOp and appendLogBatch, so the relay rejects the full batch
      // before it writes any operation.
      assertChatAuthorship(input.ops, actor.userId);
      const ops = input.ops.map(parseLogOp);
      const result = storage.appendLogBatch({
        workspaceId: route.workspaceId,
        originId,
        ops,
        // Identity claim/verification rides the append's BEGIN IMMEDIATE
        // transaction. A gap/conflict/quota/blob failure later in append
        // rolls back a first-adopt claim together with the batch.
        guard: ({ enforceWorkspaceIdentity: enforceInAppend }) => {
          enforceWorkspaceIdentity(
            storage,
            route.workspaceId,
            identity,
            enforceInAppend,
          );
        },
      });
      if (result.inserted > 0) {
        discussionActivity.wake(`log:${route.workspaceId}`);
      }
      return jsonResponse({
        ok: true,
        accepted: ops.length,
        inserted: result.inserted,
        skipped: result.skipped,
        currentMaxOriginSeq: result.currentMaxOriginSeq,
      });
    }

    if (route.route === "log" && request.method === "GET") {
      const url = new URL(request.url);
      const identity = parseOptionalWorkspaceIdentityQuery(url.searchParams);
      const epochLogFloor = enforceWorkspaceIdentity(
        storage,
        route.workspaceId,
        identity,
      );
      const requestedSince = parseCursor(url.searchParams.get("since"));
      const since = Math.max(requestedSince, epochLogFloor);
      const limit = parseLimit(url.searchParams.get("limit"));
      const page = storage.fetchLogPage({
        workspaceId: route.workspaceId,
        sinceRelaySeq: since,
        limit,
      });
      return jsonResponse({
        ok: true,
        ops: page.rows.map((row) => ({
          relaySeq: row.relaySeq,
          workspaceId: row.workspaceId,
          originId: row.originId,
          originSeq: row.originSeq,
          opKind: row.opKind,
          payload: JSON.parse(row.payloadJson) as unknown,
          recordedAtMs: row.recordedAtMs,
        })),
        // A hidden epoch floor is a read filter, not a served log row. An
        // empty response therefore cannot advance the caller's cursor: the
        // strict page contract requires nextCursor to equal the final
        // relaySeq, or the requested cursor when no row was served.
        nextCursor: page.rows.length === 0 ? requestedSince : page.nextCursor,
        hasMore: page.hasMore,
      });
    }

    if (route.route === "log-coordinate" && request.method === "GET") {
      const url = new URL(request.url);
      const identity = parseOptionalWorkspaceIdentityQuery(url.searchParams);
      const epochLogFloor = enforceWorkspaceIdentity(
        storage,
        route.workspaceId,
        identity,
      );
      const row = storage.fetchLogCoordinate({
        workspaceId: route.workspaceId,
        originId: route.originId,
        originSeq: route.originSeq,
      });
      if (!row) return jsonResponse({ ok: true, status: "absent" });
      const op = {
        relaySeq: row.relaySeq,
        workspaceId: row.workspaceId,
        originId: row.originId,
        originSeq: row.originSeq,
        opKind: row.opKind,
        payload: JSON.parse(row.payloadJson) as unknown,
        recordedAtMs: row.recordedAtMs,
      };
      if (row.relaySeq <= epochLogFloor) {
        return jsonResponse({
          ok: true,
          status: "presentBelowEpochFloor",
          op,
        });
      }
      return jsonResponse({
        ok: true,
        status: "present",
        op,
      });
    }

    throw relayError("method_not_allowed");
  }

  return { respondToWorkspaceRegistration, respondToWorkspaceReplication };
}

function parseWorkspaceIdentityValue(value: unknown, name: string): string {
  const parsed = parseString(value, name, MAX_IDENTITY_BYTES);
  if (Buffer.byteLength(parsed, "utf8") > MAX_IDENTITY_BYTES) {
    throw badRequest(`${name} is too long`);
  }
  return parsed;
}

interface OptionalWorkspaceIdentity {
  replicationEpoch: string;
  streamIdentity: string;
}

function parseOptionalWorkspaceIdentity(
  input: Record<string, unknown>,
): OptionalWorkspaceIdentity | null {
  return parseOptionalWorkspaceIdentityValues(
    input.replicationEpoch,
    input.streamIdentity,
  );
}

function parseOptionalWorkspaceIdentityQuery(
  searchParams: URLSearchParams,
): OptionalWorkspaceIdentity | null {
  return parseOptionalWorkspaceIdentityValues(
    searchParams.has("replicationEpoch")
      ? searchParams.get("replicationEpoch")
      : undefined,
    searchParams.has("streamIdentity") ? searchParams.get("streamIdentity") : undefined,
  );
}

function parseOptionalWorkspaceIdentityValues(
  replicationEpochValue: unknown,
  streamIdentityValue: unknown,
): OptionalWorkspaceIdentity | null {
  const hasReplicationEpoch = replicationEpochValue !== undefined;
  const hasStreamIdentity = streamIdentityValue !== undefined;
  if (!hasReplicationEpoch && !hasStreamIdentity) return null;
  if (hasReplicationEpoch !== hasStreamIdentity) {
    throw badRequest("replicationEpoch and streamIdentity must be supplied together");
  }
  return {
    replicationEpoch: parseWorkspaceIdentityValue(
      replicationEpochValue,
      "replicationEpoch",
    ),
    streamIdentity: parseWorkspaceIdentityValue(
      streamIdentityValue,
      "streamIdentity",
    ),
  };
}

function enforceWorkspaceIdentity(
  storage: Pick<SyncRelayStorage, "getWorkspaceIdentity" | "verifyWorkspaceIdentity" | "getEpochLogFloor">,
  workspaceId: string,
  identity: OptionalWorkspaceIdentity | null,
  claimInAppend?: (
    identity: OptionalWorkspaceIdentity | null,
  ) => EnforceWorkspaceIdentityResult,
): number {
  if (claimInAppend) {
    assertWorkspaceIdentityResult(claimInAppend(identity));
    return 0;
  }
  if (identity === null) {
    if (storage.getWorkspaceIdentity(workspaceId) !== null) {
      throw relayError("identity_required");
    }
    return 0;
  }
  // GET is strictly read-only. An unset workspace cannot first-adopt identity
  // through a pull; there is no coordinate to verify, so it is reported as
  // unrecognized without writing.
  assertWorkspaceIdentityResult(
    storage.verifyWorkspaceIdentity({ workspaceId, ...identity }),
  );
  return storage.getEpochLogFloor(workspaceId);
}

function assertWorkspaceIdentityResult(
  result: EnforceWorkspaceIdentityResult,
): void {
  if (result === "epoch-superseded") throw relayError("epoch_superseded");
  if (result === "epoch-unknown") throw relayError("identity_not_recognized");
  if (result === "stream-mismatch") throw relayError("stream_identity_mismatch");
  if (result === "identity-required") throw relayError("identity_required");
}
