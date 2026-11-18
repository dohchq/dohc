import {
  createReceivedIdentity,
  tokenizeReceivedPayload,
  type ReceivedRecipient,
} from "./receivedIdentity";
import { visibleSharePath } from "@dohc/security-contract/share-selector";
import { createAccountlessPathProjection } from "./accountlessPathProjection";
import { createHmac } from "node:crypto";
import { asRecord } from "@dohc/workspace-core";
import { readAuthorized } from "./shareAuthorization";
import { COLLECTION_CREATE_ORIGIN_PREFIX, COLLECTION_FILE_ORIGIN_PREFIX } from "./relayLogInputs";
import {
  boundaryMove,
  filterOpForShare,
  groupChannelIsOrdinary,
  hasValidShareMomentShape,
  fileSideOf,
  isGroupSelector,
  parseShareOpPayloadWithReferencedPaths,
  pathLevel,
  pathVisibleThroughShare,
  targetVersionId,
  type AnyShareSelector,
  type ChatShareChannelKind,
  type ChatShareThreadResolver,
  type ShareSelector,
  type ThreadFileBinding,
} from "./shareFilter";
import {
  SHARED_BLOB_CANDIDATE_LIMIT,
  type SyncRelayLogRow,
  type SyncRelayStorage,
} from "./storage";
import { LINK_REVISION_SCAN_LIMIT } from "./storage/limits";
import { MAX_LOG_PAGE_SIZE } from "./wireLimits";
import { sharedMomentAuthors } from "./sharedMomentAuthors";

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
    | "hasRefusedSettlement"
    | "fetchLogPageDescending"
    | "listObjectMomentLogRowsByBlob"
    | "listVersionCreateLogRowsByBlob"
    | "getBlob"
    | "currentObjectBlobByteLength"
    | "laterObjectMomentPaths"
    | "listLinkRevisionLogRows"
    | "currentObjectFile"
    | "isCurrentFileState"
    | "listCurrentFileLogRowsByBlob"
    | "indexReceivedWorkTargets"
    | "readShareTx"
  >,
  linkFreshnessPageSize: number,
  linkKey?: string | Uint8Array,
) {
  // The thread→channel resolver the chat share filter scopes by. Backed
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
      // Memoized for the same reason: the file-chat filter asks
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
    if (row.opKind !== "moment.append") return null;
    if (isGroupSelector(selector) && !groupChannelIsOrdinary(selector, chatResolver)) return null;
    const files = fileSideOf(selector);
    const parsed = files && parseShareOpPayloadWithReferencedPaths(row.payloadJson);
    const record = parsed && asRecord(parsed.payload);
    if (!files || !record || !hasValidShareMomentShape(record)) return null;
    // The accountless replica never held what lies outside it, so it gets
    // only the half it sees.
    const moved = boundaryMove(
      files,
      record,
      (path) => projection.projectPath(path) !== null,
      chatResolver,
    );
    return moved?.decision.allowed ? projection.projectPayload(moved.decision.payload) : null;
  };

  // Below Edit a recipient reads current files only. A moment or fork
  // snapshot is current while the file it produced is still that file's
  // state (docs/engineering/security-boundaries.md).
  const isCurrentState = (
    workspaceId: string,
    selector: ShareSelector,
    row: Pick<SyncRelayLogRow, "relaySeq">,
    path: unknown,
  ) =>
    typeof path === "string" &&
    storage.isCurrentFileState({
      workspaceId,
      versionId: targetVersionId(selector),
      path,
      relaySeq: row.relaySeq,
    });

  // History needs Edit on the file. A member's level differs by folder, so
  // it is judged at each path, never once for the reader.
  const editAt = (selector: ShareSelector, path: unknown) =>
    typeof path === "string" && pathLevel(selector, path) === "edit";
  const momentAtEdit = (selector: ShareSelector, served: Record<string, unknown>) =>
    editAt(selector, served.path) &&
    [served.payloadBeforePath, served.payloadAfterPath].every(
      (path) => path == null || editAt(selector, path),
    );
  // One level everywhere: a named path share or a link.
  const levelEverywhere = (selector: ShareSelector) =>
    "access" in selector && !selector.levelAt ? selector.access : null;

  // Rewrites a served file op where the recipient is below Edit, or drops it.
  // A replaced write is dropped. A replaced rename becomes a delete of its old
  // path, so a recipient that already holds that path loses it. A delete is
  // served without content: the engine records the deleted content as its
  // after-hash. No such op keeps a before-hash.
  const currentFilesOp = (
    workspaceId: string,
    selector: ShareSelector,
    row: Pick<SyncRelayLogRow, "relaySeq" | "opKind">,
    served: Record<string, unknown>,
  ): Record<string, unknown> | null => {
    if (row.opKind === "version.create") {
      const snapshots = Array.isArray(served.forkSnapshots) ? served.forkSnapshots : [];
      served.forkSnapshots = snapshots.filter(
        (snapshot: Record<string, unknown>) =>
          editAt(selector, snapshot.path) ||
          isCurrentState(workspaceId, selector, row, snapshot.path),
      );
      return served;
    }
    if (row.opKind !== "moment.append" || momentAtEdit(selector, served)) return served;
    served.payloadBeforeBlobSha256 = null;
    if (served.operation === "delete") {
      delete served.payloadAfterBlobSha256;
      delete served.payloadAfterContentKind;
      return served;
    }
    if (isCurrentState(workspaceId, selector, row, served.payloadAfterPath ?? served.path))
      return served;
    if (served.operation !== "rename" || typeof served.payloadBeforePath !== "string") return null;
    return {
      operation: "delete",
      versionId: served.versionId,
      metadata: served.metadata,
      payloadBeforeBlobSha256: null,
      path: served.payloadBeforePath,
      payloadBeforePath: served.payloadBeforePath,
      ...(served.objectId !== undefined ? { objectId: served.objectId } : {}),
    };
  };

  const filteredLogPage = (
    workspaceId: string,
    shareId: string,
    authorize: () => AnyShareSelector,
    since: number,
    limit: number,
    audience: "authenticated" | "accountless",
    half?: "chat" | "files",
    recipient?: ReceivedRecipient,
    currentOnly = false,
    epochLogFloor = 0,
  ): {
    ops: Array<Record<string, unknown>>;
    nextCursor: number;
    hasMore: boolean;
  } => {
    const observed = new Map<
      string,
      Parameters<SyncRelayStorage["indexReceivedWorkTargets"]>[0][number]
    >();
    const page = readAuthorized(storage, authorize, (selector) => {
      const identity = createReceivedIdentity(
        linkKey,
        (recipient, workspaceId, objectId, objectToken) => {
          const sourceHandle = identity.source(recipient, workspaceId);
          if (sourceHandle)
            observed.set(objectToken, {
              recipient,
              workspaceId,
              objectId,
              objectToken,
              sourceHandle,
            });
        },
      );
      const chatResolver = chatResolverFor(workspaceId);
      const fileSelector = fileSideOf(selector);
      const accountlessProjection =
        audience === "accountless" && fileSelector
          ? createAccountlessPathProjection(fileSelector)
          : null;
      const currentFiles = new Map<string, ReturnType<typeof storage.currentObjectFile>>();
      // A named recipient and a member's browser read history only where they
      // have Edit. A link keeps its own revision rule.
      const currentFilesSelector =
        fileSelector &&
        levelEverywhere(fileSelector) !== "edit" &&
        (audience === "authenticated" || (!currentOnly && "reach" in fileSelector))
          ? fileSelector
          : null;
      return scanFilteredLog(
        storage,
        {
          workspaceId,
          since,
          limit,
          maxRawRows: audience === "accountless" ? MAX_RAW_ROWS_PER_LINK_PAGE : limit,
        },
        (row) => {
          // A departed publication names a path its document no longer holds.
          if (row.settlementAdmission?.status === "refused" || row.relayAdmission !== undefined)
            return null;
          if (audience === "accountless" && !ACCOUNTLESS_FILE_REPLAY_OP_KINDS.has(row.opKind)) {
            return null;
          }
          const decision = filterOpForShare(
            selector,
            row.opKind,
            row.payloadJson,
            chatResolver,
            half,
          );
          let payload = decision.allowed
            ? accountlessProjection
              ? accountlessProjection.projectPayload(decision.payload)
              : decision.payload
            : accountlessProjection
              ? matchRefusedBoundaryMove(selector, accountlessProjection, row, chatResolver)
              : null;
          if (payload === null) return null;
          const authenticatedMoment =
            audience === "authenticated" && row.opKind === "moment.append";
          const original =
            recipient || authenticatedMoment
              ? (JSON.parse(row.payloadJson) as Record<string, unknown>)
              : undefined;
          if (recipient && original)
            tokenizeReceivedPayload({
              identity,
              recipient,
              workspaceId,
              selector,
              chat: chatResolver,
              opKind: row.opKind,
              original,
              served: payload as Record<string, unknown>,
              ...(accountlessProjection ? { projectPath: accountlessProjection.projectPath } : {}),
            });
          if (currentFilesSelector) {
            payload = currentFilesOp(
              workspaceId,
              currentFilesSelector,
              row,
              payload as Record<string, unknown>,
            );
            if (payload === null) return null;
          }
          if (currentOnly) {
            if (!fileSelector || !accountlessProjection || !recipient) return null;
            const reset = { relaySeq: row.relaySeq, opKind: "files.reset", payload: {} };
            if (row.opKind === "version.create") return reset;
            if (row.opKind !== "moment.append") return null;
            const objectId = original?.objectId;
            const receivedObject = identity.object(recipient, workspaceId, objectId);
            if (typeof objectId !== "string" || !receivedObject) return reset;
            const versionId = targetVersionId(fileSelector);
            if (!currentFiles.has(objectId)) {
              currentFiles.set(
                objectId,
                storage.currentObjectFile({ workspaceId, versionId, objectId, epochLogFloor }),
              );
            }
            const current = currentFiles.get(objectId)!;
            if (current === "reset") return reset;
            const projected =
              current === null || visibleSharePath(fileSelector, current.path) === null
                ? null
                : accountlessProjection.projectPath(current.path);
            return {
              relaySeq: row.relaySeq,
              opKind: "file.current",
              payload: {
                objectId: receivedObject,
                file:
                  current && projected !== null
                    ? {
                        objectId: receivedObject,
                        path: projected,
                        blobSha256: current.blobSha256,
                        contentKind: current.contentKind,
                      }
                    : null,
              },
            };
          }
          if (authenticatedMoment && original) {
            (payload as Record<string, unknown>).authors = sharedMomentAuthors(
              row.admittedAuthorSnapshot,
            );
            const mark = original.attributionUnavailable;
            if (mark && typeof mark === "object" && !Array.isArray(mark)) {
              const unavailable = mark as Record<string, unknown>;
              if (
                typeof unavailable.settlementId === "string" &&
                unavailable.settlementId.length > 0 &&
                unavailable.settlementId.length <= 512 &&
                typeof unavailable.reason === "string" &&
                unavailable.reason.length > 0 &&
                unavailable.reason.length <= 4096 &&
                typeof original.momentId === "string" &&
                storage.hasRefusedSettlement({
                  workspaceId,
                  originId: row.originId,
                  originSeq: row.originSeq,
                  momentId: original.momentId,
                  settlementId: unavailable.settlementId,
                  reason: unavailable.reason,
                })
              ) {
                (payload as Record<string, unknown>).metadata = {
                  origin: "sync",
                  summary: "Attribution unavailable",
                };
              }
            }
          }
          const collectionOriginPrefix = row.originId.startsWith(COLLECTION_FILE_ORIGIN_PREFIX)
            ? COLLECTION_FILE_ORIGIN_PREFIX
            : row.originId.startsWith(COLLECTION_CREATE_ORIGIN_PREFIX)
              ? COLLECTION_CREATE_ORIGIN_PREFIX
              : undefined;
          return {
            relaySeq: row.relaySeq,
            ...(audience === "authenticated"
              ? {
                  originId:
                    collectionOriginPrefix !== undefined
                      ? `${collectionOriginPrefix}${createHmac("sha256", shareId).update(row.originId).digest("hex")}`
                      : row.originId,
                }
              : {}),
            originSeq: row.originSeq,
            opKind: row.opKind,
            payload,
            recordedAtMs: row.recordedAtMs,
            ...(decision.allowed && decision.reachMove ? { reachMove: decision.reachMove } : {}),
          };
        },
      );
    });
    if (observed.size) storage.indexReceivedWorkTargets([...observed.values()]);
    return { ops: page.items, nextCursor: page.nextCursor, hasMore: page.hasMore };
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
    const fileSelector = fileSideOf(selector);
    const accountlessProjection = fileSelector
      ? createAccountlessPathProjection(fileSelector)
      : null;
    for (let pagesRead = 0; pagesRead < LINK_FRESHNESS_PAGE_BUDGET; pagesRead += 1) {
      const rows = storage.fetchLogPageDescending({
        workspaceId,
        beforeRelaySeq,
        limit: linkFreshnessPageSize,
      });
      for (const row of rows) {
        if (row.settlementAdmission?.status === "refused" || row.relayAdmission !== undefined)
          continue;
        if (row.relaySeq <= epochLogFloor) {
          return { lastSettledAtMs: null, lastSettledKnown: true };
        }
        if (!("kind" in selector) && !FILE_FRESHNESS_OP_KINDS.has(row.opKind)) {
          continue;
        }
        if (filterOpForShare(selector, row.opKind, row.payloadJson, chatResolver).allowed) {
          return { lastSettledAtMs: row.recordedAtMs, lastSettledKnown: true };
        }
        if (
          accountlessProjection !== null &&
          matchRefusedBoundaryMove(selector, accountlessProjection, row, chatResolver) !== null
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

  // A named recipient's blob: the after-content of an op the log would serve.
  // Every readable level reads a current file, so the search starts from the
  // current files: a cap on historical candidates could hide a current file
  // whose bytes many newer objects once held, and the recipient's pull would
  // stop at it. An earlier version needs Edit where the op wrote it.
  const namedShareBlob = (
    workspaceId: string,
    selector: AnyShareSelector,
    sha256: string,
  ): Uint8Array | null => {
    if (
      isGroupSelector(selector) &&
      !groupChannelIsOrdinary(selector, chatResolverFor(workspaceId))
    ) {
      return null;
    }
    const fileSelector = fileSideOf(selector);
    if (!fileSelector) return null;
    selector = fileSelector;
    const versionId = targetVersionId(selector);
    const chatResolver = chatResolverFor(workspaceId);
    const level = levelEverywhere(selector);
    if (level !== "edit") {
      // Page past rows the share filter refuses, so they cannot hide an admitted file.
      const produced = ({ path, row }: { path: string; row: SyncRelayLogRow }) => {
        const decision = filterOpForShare(selector, row.opKind, row.payloadJson, chatResolver);
        if (!decision.allowed || !decision.blobSha256s.includes(sha256)) return false;
        const served = decision.payload as Record<string, unknown>;
        if (row.opKind === "version.create")
          return (Array.isArray(served.forkSnapshots) ? served.forkSnapshots : []).some(
            (snapshot: Record<string, unknown>) =>
              snapshot.path === path && snapshot.blobSha256 === sha256,
          );
        return (served.payloadAfterPath ?? served.path) === path;
      };
      for (let afterPath: string | undefined; ;) {
        const page = storage.listCurrentFileLogRowsByBlob({
          workspaceId,
          versionId,
          selectorPaths: selector.paths,
          sha256,
          ...(afterPath === undefined ? {} : { afterPath }),
        });
        if (page.some(produced)) return storage.getBlob(workspaceId, sha256);
        if (page.length < SHARED_BLOB_CANDIDATE_LIMIT) break;
        afterPath = page.at(-1)!.path;
      }
      if (level !== null) return null;
    }
    const candidates = [
      ...storage.listObjectMomentLogRowsByBlob({
        workspaceId,
        versionId,
        sha256,
        semantics: "historical-log",
        ...(selector.paths.length > 0 ? { selectorPaths: selector.paths } : {}),
      }),
      ...storage.listVersionCreateLogRowsByBlob({ workspaceId, versionId, sha256 }),
    ]
      .sort((left, right) => right.relaySeq - left.relaySeq)
      .slice(0, SHARED_BLOB_CANDIDATE_LIMIT);
    const reachable = candidates.some((row) => {
      const decision = filterOpForShare(selector, row.opKind, row.payloadJson, chatResolver);
      if (!decision.allowed || !decision.blobSha256s.includes(sha256)) return false;
      if (level === "edit") return true;
      const served = decision.payload as Record<string, unknown>;
      return row.opKind === "version.create"
        ? (Array.isArray(served.forkSnapshots) ? served.forkSnapshots : []).some(
            (snapshot: Record<string, unknown>) =>
              snapshot.blobSha256 === sha256 && editAt(selector, snapshot.path),
          )
        : momentAtEdit(selector, served);
    });
    return reachable ? storage.getBlob(workspaceId, sha256) : null;
  };

  // A share link reads an earlier revision only of a file still in the share
  // (docs/engineering/security-boundaries.md). The revision must be the after-content of a log row above
  // the epoch floor that this link's filter admits, and that row's object must
  // be the current file at a selected path now. The hash alone grants nothing.
  // Storage returns only rows whose object is still in the share, so deleted
  // or moved-out objects cannot fill the candidate cap.
  const linkRevisionByteLength = (
    workspaceId: string,
    selector: ShareSelector,
    sha256: string,
    epochLogFloor: number,
  ): number | null => {
    if ("reach" in selector && selector.reach)
      return namedShareBlob(workspaceId, selector, sha256)?.byteLength ?? null;
    const versionId = targetVersionId(selector);
    const candidates = [
      ...storage.listLinkRevisionLogRows({
        workspaceId,
        versionId,
        selectorPaths: selector.paths,
        sha256,
        epochLogFloor,
      }),
      ...storage.listVersionCreateLogRowsByBlob({
        workspaceId,
        versionId,
        sha256,
        aboveRelaySeq: epochLogFloor,
      }),
    ];
    const chatResolver = chatResolverFor(workspaceId);
    for (const row of candidates) {
      const decision = filterOpForShare(selector, row.opKind, row.payloadJson, chatResolver);
      if (!decision.allowed || !decision.blobSha256s.includes(sha256)) continue;
      for (const objectId of revisionObjectIds(selector, row, sha256)) {
        // The object must have stayed where this share admits it since the
        // revision: a delete, or any path the filter refuses, withdraws it.
        const laterPaths = storage.laterObjectMomentPaths({
          workspaceId,
          versionId,
          objectId,
          afterRelaySeq: row.relaySeq,
          limit: LINK_REVISION_SCAN_LIMIT + 1,
        });
        if (
          laterPaths.length > LINK_REVISION_SCAN_LIMIT ||
          laterPaths.some((path) => path === null || !pathVisibleThroughShare(selector, path))
        ) {
          continue;
        }
        const byteLength = storage.currentObjectBlobByteLength({
          workspaceId,
          versionId,
          selectorPaths: selector.paths,
          objectId,
          sha256,
          epochLogFloor,
        });
        if (byteLength !== null) return byteLength;
      }
    }
    return null;
  };

  return {
    chatResolverFor,
    filteredLogPage,
    newestFilteredOpFreshness: (
      workspaceId: string,
      authorize: () => AnyShareSelector,
      epochLogFloor: number,
    ) =>
      readAuthorized(storage, authorize, (selector) =>
        newestFilteredOpFreshness(workspaceId, selector, epochLogFloor),
      ),
    namedShareBlob: (workspaceId: string, authorize: () => AnyShareSelector, sha256: string) =>
      readAuthorized(storage, authorize, (selector) =>
        namedShareBlob(workspaceId, selector, sha256),
      ),
    linkRevisionByteLength: (
      workspaceId: string,
      authorize: () => ShareSelector,
      sha256: string,
      epochLogFloor: number,
    ) =>
      readAuthorized(storage, authorize, (selector) =>
        linkRevisionByteLength(workspaceId, selector, sha256, epochLogFloor),
      ),
  };
}

/**
 * Serves the rows `admit` maps, reading at most `maxRawRows` raw log rows.
 * The cursor passes every row read, served or not, so a run of rows the
 * reader may not see never stalls it.
 */
export function scanFilteredLog<T>(
  storage: Pick<SyncRelayStorage, "fetchLogPage">,
  input: { workspaceId: string; since: number; limit: number; maxRawRows: number },
  admit: (row: SyncRelayLogRow) => T | null,
): { items: T[]; nextCursor: number; hasMore: boolean } {
  const items: T[] = [];
  let nextCursor = input.since;
  let consumed = 0;
  for (;;) {
    const page = storage.fetchLogPage({
      workspaceId: input.workspaceId,
      sinceRelaySeq: nextCursor,
      limit: Math.min(MAX_LOG_PAGE_SIZE, input.maxRawRows - consumed),
    });
    for (const [index, row] of page.rows.entries()) {
      consumed += 1;
      nextCursor = row.relaySeq;
      const item = admit(row);
      if (item === null) continue;
      items.push(item);
      if (items.length === input.limit) {
        return { items, nextCursor, hasMore: index < page.rows.length - 1 || page.hasMore };
      }
    }
    if (!page.hasMore || consumed >= input.maxRawRows) {
      return { items, nextCursor, hasMore: page.hasMore };
    }
  }
}

// The objects whose after-content in an admitted row is `sha256`: the moment's
// object, or each selected fork-snapshot file with that content.
function revisionObjectIds(
  selector: ShareSelector,
  row: Pick<SyncRelayLogRow, "opKind" | "payloadJson">,
  sha256: string,
): string[] {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payloadJson);
  } catch {
    return [];
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const record = payload as Record<string, unknown>;
  const objectId = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0;
  if (row.opKind === "moment.append") return objectId(record.objectId) ? [record.objectId] : [];
  if (row.opKind !== "version.create" || !Array.isArray(record.forkSnapshots)) return [];
  return record.forkSnapshots.flatMap((raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const snapshot = raw as Record<string, unknown>;
    return snapshot.blobSha256 === sha256 &&
      objectId(snapshot.objectId) &&
      typeof snapshot.path === "string" &&
      visibleSharePath(selector, snapshot.path) === snapshot.path
      ? [snapshot.objectId]
      : [];
  });
}
