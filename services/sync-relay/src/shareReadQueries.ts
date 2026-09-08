import { createAccountlessPathProjection } from "./accountlessPathProjection";
import {
  filterOpForShare,
  hasValidShareMomentShape,
  isChatChannelSelector,
  parseShareOpPayloadWithReferencedPaths,
  targetVersionId,
  type AnyShareSelector,
  type ChatShareChannelKind,
  type ChatShareThreadResolver,
  type ThreadFileBinding,
} from "./shareFilter";
import {
  SHARED_BLOB_CANDIDATE_LIMIT,
  type SyncRelayLogRow,
  type SyncRelayStorage,
} from "./storage";
import { MAX_LOG_PAGE_SIZE } from "./wireLimits";

// One accountless response may scan this many raw log rows for admitted ops.
export const MAX_RAW_ROWS_PER_LINK_PAGE = 10_000;
// Freshness reads inspect at most 20 pages, or 10,000 rows at the default page size.
export const LINK_FRESHNESS_PAGE_BUDGET = 20;
const ACCOUNTLESS_FILE_REPLAY_OP_KINDS = new Set([
  "workspace.init",
  "moment.append",
  "version.create",
]);
const FILE_FRESHNESS_OP_KINDS = new Set(["moment.append", "version.create"]);

export function createShareReadQueries(
  storage: Pick<
    SyncRelayStorage,
    | "findChannelCreateKind"
    | "findThreadCreateChannelWireId"
    | "findThreadCreateFileBinding"
    | "objectCurrentPath"
    | "objectIdAtPath"
    | "fetchLogPage"
    | "fetchLogPageDescending"
    | "listObjectMomentLogRowsByBlob"
    | "listVersionCreateLogRowsByBlob"
    | "getBlob"
  >,
  linkFreshnessPageSize: number,
) {
  // MU-C4: the thread→channel resolver the chat share filter scopes by. Backed
  // by the shared workspace's own log (earliest chat.thread.create wins), so a
  // member-pushed forgery can never re-bind an existing thread. Memoized per
  // resolver (= per request): the filter asks about the same threadId across
  // thread-scoped rows on the hot read path, and the underlying lookup is a log
  // scan. Safe because a resolver never outlives its request and the log it
  // reads is append-only with earliest-binding-wins semantics.
  const chatResolverFor = (workspaceId: string): ChatShareThreadResolver => {
    const threadCache = new Map<string, string | null | undefined>();
    const kindCache = new Map<string, ChatShareChannelKind | null | undefined>();
    const bindingCache = new Map<string, ThreadFileBinding | null | undefined>();
    const pathCache = new Map<string, string | null | undefined>();
    const objectAtPathCache = new Map<string, string | undefined>();
    return {
      channelKind: (channelWireId) => {
        if (kindCache.has(channelWireId)) return kindCache.get(channelWireId);
        const kind = storage.findChannelCreateKind(workspaceId, channelWireId);
        kindCache.set(channelWireId, kind);
        return kind;
      },
      threadChannelWireId: (threadId) => {
        if (threadCache.has(threadId)) return threadCache.get(threadId);
        const bound = storage.findThreadCreateChannelWireId(workspaceId, threadId);
        threadCache.set(threadId, bound);
        return bound;
      },
      // #646 PR2, memoized for the same reason: the file-chat filter asks
      // about the same threadId and the same objectId across every
      // thread-scoped row of a page.
      threadFileBinding: (threadId) => {
        if (bindingCache.has(threadId)) return bindingCache.get(threadId);
        const bound = storage.findThreadCreateFileBinding(workspaceId, threadId);
        bindingCache.set(threadId, bound);
        return bound;
      },
      objectCurrentPath: (objectId) => {
        if (pathCache.has(objectId)) return pathCache.get(objectId);
        const path = storage.objectCurrentPath(workspaceId, objectId);
        pathCache.set(objectId, path);
        return path;
      },
      objectIdAtPath: (path) => {
        if (objectAtPathCache.has(path)) return objectAtPathCache.get(path);
        const objectId = storage.objectIdAtPath(workspaceId, path);
        objectAtPathCache.set(path, objectId);
        return objectId;
      },
    };
  };

  const matchRefusedBoundaryMove = (
    selector: AnyShareSelector,
    projection: ReturnType<typeof createAccountlessPathProjection>,
    row: Pick<SyncRelayLogRow, "opKind" | "payloadJson">,
    chatResolver: ChatShareThreadResolver,
  ): unknown | null => {
    if (isChatChannelSelector(selector) || row.opKind !== "moment.append") {
      return null;
    }
    const parsed = parseShareOpPayloadWithReferencedPaths(row.payloadJson);
    if (!parsed) return null;
    const { payload } = parsed;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return null;
    }
    const record = payload as Record<string, unknown>;
    if (!hasValidShareMomentShape(record)) return null;
    if (record.operation !== "rename") return null;
    const beforePath = record.payloadBeforePath;
    const afterPath = record.payloadAfterPath;
    if (typeof beforePath !== "string" || typeof afterPath !== "string") {
      return null;
    }
    const projectedBeforePath = projection.projectPath(beforePath);
    const projectedAfterPath = projection.projectPath(afterPath);

    if (projectedBeforePath !== null && projectedAfterPath === null) {
      // Re-run the visible half as a delete so the existing filter validates
      // its version and before-path, then emits the standard minimal payload.
      const deletion = filterOpForShare(
        selector,
        row.opKind,
        JSON.stringify({
          operation: "delete",
          versionId: record.versionId,
          path: beforePath,
          payloadBeforeBlobSha256: record.payloadBeforeBlobSha256,
          payloadBeforePath: beforePath,
          ...(record.beforePath === beforePath ? { beforePath } : {}),
        }),
        chatResolver,
      );
      return deletion.allowed ? projection.projectPayload(deletion.payload) : null;
    }

    if (projectedBeforePath === null && projectedAfterPath !== null) {
      // The accountless replica never held the private predecessor, so expose
      // only the visible half as a create. The normal filter validates the
      // version and after-path and rebuilds the minimal replay payload.
      const arrival = filterOpForShare(
        selector,
        row.opKind,
        JSON.stringify({
          operation: "write",
          versionId: record.versionId,
          path: afterPath,
          payloadAfterBlobSha256: record.payloadAfterBlobSha256,
          payloadAfterPath: afterPath,
          ...(record.payloadAfterContentKind === "binary"
            ? { payloadAfterContentKind: "binary" }
            : {}),
        }),
        chatResolver,
      );
      return arrival.allowed ? projection.projectPayload(arrival.payload) : null;
    }

    return null;
  };

  const filteredLogPage = (
    workspaceId: string,
    selector: AnyShareSelector,
    since: number,
    limit: number,
    audience: "authenticated" | "accountless",
  ): {
    ops: Array<Record<string, unknown>>;
    nextCursor: number;
    hasMore: boolean;
  } => {
    const chatResolver = chatResolverFor(workspaceId);
    const accountlessProjection =
      audience === "accountless" && !isChatChannelSelector(selector)
        ? createAccountlessPathProjection(selector)
        : null;
    const ops: Array<Record<string, unknown>> = [];
    let nextCursor = since;
    let rawRowsConsumed = 0;

    for (;;) {
      const rawLimit =
        audience === "accountless"
          ? Math.min(
              MAX_LOG_PAGE_SIZE,
              MAX_RAW_ROWS_PER_LINK_PAGE - rawRowsConsumed,
            )
          : limit;
      const page = storage.fetchLogPage({
        workspaceId,
        sinceRelaySeq: nextCursor,
        limit: rawLimit,
      });

      for (const [index, row] of page.rows.entries()) {
        rawRowsConsumed += 1;
        nextCursor = row.relaySeq;
        if (
          audience === "accountless" &&
          !ACCOUNTLESS_FILE_REPLAY_OP_KINDS.has(row.opKind)
        ) {
          continue;
        }
        const decision = filterOpForShare(
          selector,
          row.opKind,
          row.payloadJson,
          chatResolver,
        );
        const payload = decision.allowed
          ? accountlessProjection
            ? accountlessProjection.projectPayload(decision.payload)
            : decision.payload
          : accountlessProjection
            ? matchRefusedBoundaryMove(
                selector,
                accountlessProjection,
                row,
                chatResolver,
              )
            : null;
        if (payload === null) continue;
        ops.push({
          relaySeq: row.relaySeq,
          ...(audience === "authenticated" ? { originId: row.originId } : {}),
          originSeq: row.originSeq,
          opKind: row.opKind,
          payload,
          recordedAtMs: row.recordedAtMs,
        });
        if (ops.length === limit) {
          return {
            ops,
            nextCursor,
            hasMore:
              (audience === "accountless" &&
                rawRowsConsumed === MAX_RAW_ROWS_PER_LINK_PAGE) ||
              index < page.rows.length - 1 ||
              page.hasMore,
          };
        }
      }

      if (audience === "authenticated" || !page.hasMore) {
        return { ops, nextCursor, hasMore: page.hasMore };
      }
      if (rawRowsConsumed === MAX_RAW_ROWS_PER_LINK_PAGE) {
        return { ops, nextCursor, hasMore: true };
      }
    }
  };

  const newestFilteredOpFreshness = (
    workspaceId: string,
    selector: AnyShareSelector,
    epochLogFloor: number,
  ):
    | { lastSettledAtMs: number; lastSettledKnown: true }
    | { lastSettledAtMs: null; lastSettledKnown: true }
    | { lastSettledAtMs: null; lastSettledKnown: false } => {
    let beforeRelaySeq: number | null = null;
    const chatResolver = chatResolverFor(workspaceId);
    const accountlessProjection = isChatChannelSelector(selector)
      ? null
      : createAccountlessPathProjection(selector);
    for (
      let pagesRead = 0;
      pagesRead < LINK_FRESHNESS_PAGE_BUDGET;
      pagesRead += 1
    ) {
      const rows = storage.fetchLogPageDescending({
        workspaceId,
        beforeRelaySeq,
        limit: linkFreshnessPageSize,
      });
      for (const row of rows) {
        if (row.relaySeq <= epochLogFloor) {
          return { lastSettledAtMs: null, lastSettledKnown: true };
        }
        if (
          !isChatChannelSelector(selector) &&
          !FILE_FRESHNESS_OP_KINDS.has(row.opKind)
        ) {
          continue;
        }
        if (filterOpForShare(selector, row.opKind, row.payloadJson, chatResolver).allowed) {
          return { lastSettledAtMs: row.recordedAtMs, lastSettledKnown: true };
        }
        if (
          accountlessProjection !== null &&
          matchRefusedBoundaryMove(
            selector,
            accountlessProjection,
            row,
            chatResolver,
          ) !== null
        ) {
          return { lastSettledAtMs: row.recordedAtMs, lastSettledKnown: true };
        }
      }
      if (rows.length < linkFreshnessPageSize) {
        return { lastSettledAtMs: null, lastSettledKnown: true };
      }
      beforeRelaySeq = rows[rows.length - 1]!.relaySeq;
    }
    return { lastSettledAtMs: null, lastSettledKnown: false };
  };

  const historicalSharedBlob = (
    workspaceId: string,
    selector: AnyShareSelector,
    sha256: string,
  ): Uint8Array | null => {
    if (isChatChannelSelector(selector)) return null;
    const versionId = targetVersionId(selector);
    const candidates = [
      ...storage.listObjectMomentLogRowsByBlob({
        workspaceId,
        versionId,
        sha256,
        semantics: "historical-log",
        ...(selector.paths.length > 0
          ? { selectorPaths: selector.paths }
          : {}),
      }),
      ...storage.listVersionCreateLogRowsByBlob({ workspaceId, versionId, sha256 }),
    ]
      .sort((left, right) => right.relaySeq - left.relaySeq)
      .slice(0, SHARED_BLOB_CANDIDATE_LIMIT);
    const chatResolver = chatResolverFor(workspaceId);
    const reachable = candidates.some((row) => {
      const decision = filterOpForShare(
        selector,
        row.opKind,
        row.payloadJson,
        chatResolver,
      );
      return decision.allowed && decision.blobSha256s.includes(sha256);
    });
    return reachable ? storage.getBlob(workspaceId, sha256) : null;
  };

  return {
    chatResolverFor,
    filteredLogPage,
    newestFilteredOpFreshness,
    historicalSharedBlob,
  };
}
