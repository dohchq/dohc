import { rm } from "node:fs/promises";
import { join } from "node:path";
import { isFolderMarkerPath } from "@dohc/security-contract/access-rules";
import { OPERATION_ID_PREFIX } from "@dohc/workspace-contracts/engine";
import { liveDocumentKindForPath } from "@dohc/workspace-contracts/live-documents";
import {
  workspaceDestinationError,
  workspaceNameError,
} from "@dohc/workspace-contracts/workspace-paths";
import { validateUserWritePath } from "@dohc/workspace-core";
import {
  DaemonRefusalError,
  openEngineYdocProviderSession,
  VersionedLiveAdapter,
  type WriteAuthor,
} from "@dohc/workspace-engine-client";
import { currentAccountFeedCursor, hiddenFile } from "./accountFeed";
import { badRequest, RelayError } from "./errors";
import { liveEditors } from "./liveEditors";
import { LiveRoomUnsavedError, type LiveRooms } from "./liveRoom";
import { untilAborted } from "./namedLiveFrameHost";
import { observeRelayWrites } from "./relayWriteChanges";
import type { CopyVisitor, ServerCopies } from "./serverCopies";
import type { SyncRelayStorage } from "./storage";
import {
  ServiceHostRetirementConflict,
  type RetireIdleServiceHostEnrollmentResult,
  type ServiceHostRetirementPreparation,
} from "./storage/serviceHostEnrollment";

export type AccountFileWriteOperation =
  | "createPage"
  | "renameFile"
  | "deleteFile"
  | "restoreDeletedFile";
export const isAccountFileWriteOperation = (name: string): name is AccountFileWriteOperation =>
  name === "createPage" ||
  name === "renameFile" ||
  name === "deleteFile" ||
  name === "restoreDeletedFile";

export type AccountFileWriteRefusal =
  | "path-exists"
  | "not-found"
  | "stale-object"
  | "live-active"
  | "live-unsettled"
  | "restore-unavailable";

export type AccountFileWriteResult =
  | {
      readonly ok: true;
      readonly path: string;
      readonly objectId: string;
      readonly fromPath?: string;
      readonly linksUpdated?: number;
      readonly deleteMomentId?: string;
    }
  | { readonly ok: false; readonly refusal: AccountFileWriteRefusal; readonly reason: string };

export interface AccountFileWriteLiveHost {
  stop<T>(
    document: { workspaceId: string; objectId: string },
    fence: (prepared?: ServiceHostRetirementPreparation) => T,
    signal?: AbortSignal,
  ): Promise<T | "waiting">;
  reconcile(): void;
}

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,96}$/u;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;
const ENROLLMENT_DRAIN_WAIT_MS = 10_000;
const UNSETTLED_CODES = new Set([
  "conflict",
  "edits-pending",
  "host-diverged",
  "host-moved",
  "host-no-edit-grant",
  "host-not-loaded",
  "host-paused",
  "host-start-failed",
  "restore-in-progress",
]);
const UNSETTLED_MSG =
  "Recent live edits have not finished saving yet. Wait a moment, then try again.";
const ACTIVE_MSG = "Someone is editing this page right now. Close it everywhere, then try again.";
const parentDir = (path: string) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
const refuse = (refusal: AccountFileWriteRefusal, reason: string): AccountFileWriteResult => ({
  ok: false,
  refusal,
  reason,
});

const COLLECTION_MARKER_BATCH_TARGETS = 64;
const COLLECTION_MARKER_BATCH_BYTES = 32 * 1024;

function collectionMarkerPaths(path: string, allowDocumentCollection = false): string[] {
  const segments = path.split("/");
  const markers: string[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    const prefix = segments.slice(0, i).join("/");
    markers.push(prefix ? `${prefix}/dataset.json` : "dataset.json");
    if (!allowDocumentCollection)
      markers.push(prefix ? `${prefix}/collection.yaml` : "collection.yaml");
  }
  return markers;
}

export async function assertOutsideCollection(
  files: VersionedLiveAdapter,
  workspaceId: string,
  path: string,
  allowDocumentCollection = false,
): Promise<void> {
  const markers = collectionMarkerPaths(path, allowDocumentCollection);
  let batch: Array<{ path: string }> = [];
  let batchBytes = 0;
  const flush = async () => {
    if (!batch.length) return;
    const resolved = await files.resolveFiles({ workspaceId, targets: batch });
    if (resolved.results.some((entry) => entry.status === "found"))
      throw badRequest("This path cannot be changed here.");
    batch = [];
    batchBytes = 0;
  };
  for (const marker of markers) {
    const bytes = Buffer.byteLength(marker, "utf8");
    if (
      batch.length >= COLLECTION_MARKER_BATCH_TARGETS ||
      (batch.length > 0 && batchBytes + bytes > COLLECTION_MARKER_BATCH_BYTES)
    )
      await flush();
    batch.push({ path: marker });
    batchBytes += bytes;
  }
  await flush();
}

export function parseFields(args: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (
    !args ||
    typeof args !== "object" ||
    Array.isArray(args) ||
    Object.keys(args).some((k) => !allowed.includes(k))
  )
    throw badRequest("Invalid file operation arguments.");
  return args as Record<string, unknown>;
}
export async function seedRichDocLineage(
  storage: SyncRelayStorage,
  replica: {
    readonly client: Parameters<typeof openEngineYdocProviderSession>[0]["transport"];
    readonly workspace: string;
  },
  input: {
    readonly workspaceId: string;
    readonly path: string;
    readonly objectId: string;
    readonly force?: boolean;
  },
): Promise<void> {
  if (
    !input.force &&
    storage.mainLiveLineageExists({ workspaceId: input.workspaceId, objectId: input.objectId })
  )
    return;
  const session = await openEngineYdocProviderSession({
    transport: replica.client,
    workspace: replica.workspace,
    versionId: "main",
    path: input.path,
    expectedObjectId: input.objectId,
    contentKind: "richdoc",
    seedAbsentLineage: true,
    onRemoteUpdate: () => undefined,
  });
  try {
    await session.close({ settle: false });
  } catch (error) {
    await session.evict().catch(() => undefined);
    throw error;
  }
}
export const parseRequestId = (v: unknown) => {
  if (typeof v !== "string" || !REQUEST_ID_RE.test(v) || v.includes(":undo:"))
    throw badRequest("A valid requestId is required.");
  return v;
};
const parseId = (v: unknown, label: string) => {
  if (typeof v !== "string" || !v.length || v.length > 128)
    throw badRequest(`A valid ${label} is required.`);
  return v;
};
export const parseObjectId = (v: unknown) => parseId(v, "expectedObjectId");

export function validateAllowedFileWritePath(
  value: unknown,
  options: { readonly allowSketch: boolean; readonly checkDestination: boolean | "name" },
): { readonly path: string; readonly kind: "page" | "sketch" } {
  if (
    typeof value !== "string" ||
    !value.length ||
    Buffer.byteLength(value, "utf8") > 1_024 ||
    CONTROL_CHARS.test(value) ||
    hiddenFile(value) ||
    isFolderMarkerPath(value) ||
    value.split("/").some((s) => s.startsWith("."))
  )
    throw badRequest("This path cannot be changed here.");
  const checked = validateUserWritePath(value);
  if (!checked.ok || checked.normalized !== value)
    throw badRequest("This path cannot be changed here.");
  const base = value.slice(value.lastIndexOf("/") + 1);
  const kind =
    /\.md$/i.test(base) && base.length > 3
      ? "page"
      : /\.excalidraw$/i.test(base) && base.length > 11
        ? "sketch"
        : null;
  const badDestination =
    options.checkDestination === "name"
      ? workspaceNameError(base, "win32") !== null
      : options.checkDestination && workspaceDestinationError(value, "win32") !== null;
  if (kind === null || (!options.allowSketch && kind !== "page") || badDestination)
    throw badRequest("This path cannot be changed here.");
  return { path: value, kind };
}

export function parseAccountFileWrite(operation: AccountFileWriteOperation, args: unknown) {
  if (operation === "createPage") {
    const body = parseFields(args, ["path", "requestId"]);
    const { path } = validateAllowedFileWritePath(body.path, {
      allowSketch: false,
      checkDestination: true,
    });
    return { operation, path, requestId: parseRequestId(body.requestId) } as const;
  }
  if (operation === "renameFile") {
    const body = parseFields(args, ["fromPath", "toPath", "expectedObjectId", "requestId"]);
    const from = validateAllowedFileWritePath(body.fromPath, {
      allowSketch: true,
      checkDestination: false,
    });
    const to = validateAllowedFileWritePath(body.toPath, {
      allowSketch: true,
      checkDestination: "name",
    });
    if (
      from.kind !== to.kind ||
      from.path === to.path ||
      parentDir(from.path) !== parentDir(to.path)
    )
      throw badRequest(
        "Rename must keep the same folder and file kind and choose a different name.",
      );
    return {
      operation,
      fromPath: from.path,
      toPath: to.path,
      expectedObjectId: parseObjectId(body.expectedObjectId),
      requestId: parseRequestId(body.requestId),
    } as const;
  }
  if (operation === "restoreDeletedFile") {
    const body = parseFields(args, ["path", "objectId", "deleteMomentId", "requestId"]);
    const { path } = validateAllowedFileWritePath(body.path, {
      allowSketch: true,
      checkDestination: false,
    });
    return {
      operation,
      path,
      objectId: parseObjectId(body.objectId),
      deleteMomentId: parseId(body.deleteMomentId, "deleteMomentId"),
      requestId: parseRequestId(body.requestId),
    } as const;
  }
  const body = parseFields(args, ["path", "expectedObjectId", "requestId"]);
  const { path } = validateAllowedFileWritePath(body.path, {
    allowSketch: true,
    checkDestination: false,
  });
  return {
    operation,
    path,
    expectedObjectId: parseObjectId(body.expectedObjectId),
    requestId: parseRequestId(body.requestId),
  } as const;
}

const isDrained = (storage: SyncRelayStorage, workspaceId: string, objectId: string) => {
  const row = storage.readServiceHostEnrollmentByObjectId(workspaceId, objectId);
  return (
    !row ||
    (row.retired &&
      row.hostDrainedAtMs !== null &&
      !storage.isHostedForLiveEditing(workspaceId, objectId))
  );
};

async function waitForDrain(
  storage: SyncRelayStorage,
  workspaceId: string,
  objectId: string,
  signal: AbortSignal,
) {
  if (isDrained(storage, workspaceId, objectId)) return true;
  return await new Promise<boolean>((resolve, reject) => {
    let done = false;
    const stop = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      unwatch();
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => stop(() => reject(signal.reason));
    const check = () => {
      if (isDrained(storage, workspaceId, objectId)) stop(() => resolve(true));
    };
    const unwatch = observeRelayWrites(storage, check);
    const deadline = setTimeout(
      () => stop(() => resolve(isDrained(storage, workspaceId, objectId))),
      ENROLLMENT_DRAIN_WAIT_MS,
    );
    deadline.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    else check();
  });
}

async function prepareLiveMutation(
  deps: {
    storage: SyncRelayStorage;
    liveHost?: () => AccountFileWriteLiveHost | undefined;
    liveRooms?: () => Pick<LiveRooms, "saveFirst"> | undefined;
  },
  workspaceId: string,
  objectId: string,
  toPath: string | undefined,
  ownerUserId: string,
  nowMs: () => number,
  signal: AbortSignal,
): Promise<
  | { readonly blocked: AccountFileWriteResult }
  | { readonly blocked: null; readonly release: () => void }
> {
  if (liveEditors(deps.storage).connected({ workspaceId, objectId }))
    return { blocked: refuse("live-active", ACTIVE_MSG) };
  const host = deps.liveHost?.();
  const rooms = deps.liveRooms?.();
  const fence = (
    prepared?: ServiceHostRetirementPreparation,
  ): RetireIdleServiceHostEnrollmentResult =>
    deps.storage.retireIdleServiceHostEnrollment({
      workspaceId,
      objectId,
      toPath,
      ownerUserId,
      prepared,
      drainNow: host === undefined,
      nowMs: nowMs(),
      guard: () => signal.throwIfAborted(),
    });
  const stop = async (): Promise<RetireIdleServiceHostEnrollmentResult | "waiting"> => {
    const enrolled = deps.storage.readServiceHostEnrollmentByObjectId(workspaceId, objectId);
    return enrolled && host ? await host.stop({ workspaceId, objectId }, fence, signal) : fence();
  };
  let outcome: RetireIdleServiceHostEnrollmentResult | "waiting";
  try {
    outcome = rooms
      ? await rooms
          .saveFirst({ workspaceId, objectId }, stop, signal, { whileHosted: true })
          .catch((error: unknown) => {
            if (error instanceof LiveRoomUnsavedError) return "waiting" as const;
            throw error;
          })
      : await stop();
  } catch (error) {
    if (
      error instanceof ServiceHostRetirementConflict ||
      (error instanceof RelayError && UNSETTLED_CODES.has(error.code))
    )
      return { blocked: refuse("live-unsettled", UNSETTLED_MSG) };
    throw error;
  }
  if (outcome === "waiting" || outcome.status === "unsettled")
    return { blocked: refuse("live-unsettled", UNSETTLED_MSG) };
  if (outcome.status === "active") return { blocked: refuse("live-active", ACTIVE_MSG) };
  if (outcome.status === "retired" && host) {
    host.reconcile();
    try {
      if (!(await waitForDrain(deps.storage, workspaceId, objectId, signal))) {
        outcome.release();
        return { blocked: refuse("live-unsettled", UNSETTLED_MSG) };
      }
    } catch (error) {
      outcome.release();
      throw error;
    }
  }
  return { blocked: null, release: outcome.release };
}

export async function runAccountFileWrite(
  deps: {
    storage: SyncRelayStorage;
    copies: ServerCopies;
    liveHost?: () => AccountFileWriteLiveHost | undefined;
    liveRooms?: () => Pick<LiveRooms, "saveFirst"> | undefined;
  },
  input: {
    workspaceId: string;
    owner: string;
    operation: AccountFileWriteOperation;
    args: unknown;
    visitor: Extract<CopyVisitor, { reason: "account" }>;
    authorize(): Promise<void>;
    nowMs(): number;
  },
): Promise<{ result: AccountFileWriteResult; cursor: string }> {
  const parsed = parseAccountFileWrite(input.operation, input.args);
  const { workspaceId, owner, visitor } = input;
  const signal = visitor.signal;
  const authorize = () => untilAborted(input.authorize(), signal);
  const author: WriteAuthor = { kind: "human", humanId: owner };
  const objectAt = (path: string) =>
    deps.storage.objectIdAtPathInVersion({ workspaceId, versionId: "main", path });
  const unconfirmed = (what: string) =>
    new RelayError("server_busy", `Your server could not confirm ${what} yet. Try again.`, 503);
  const complete = async (answer: AccountFileWriteResult) => {
    await authorize();
    deps.copies.hold(visitor.userId, workspaceId);
    return answer;
  };

  const result = await deps.copies.withServerCopy(owner, workspaceId, visitor, (replica) =>
    replica.withRecordWork(async (): Promise<AccountFileWriteResult> => {
      await authorize();
      await replica.sync(signal);
      await authorize();
      const files = new VersionedLiveAdapter(replica.client, replica.workspace, { workspaceId });

      if (parsed.operation === "createPage") {
        await files.ensureMainVersion({ workspaceId });
        await assertOutsideCollection(files, workspaceId, parsed.path);
        const correlationId = `phone-create:${parsed.requestId}`;
        let objectId: string;
        try {
          objectId = (
            await files.writeTextFile({
              workspaceId,
              versionId: "main",
              path: parsed.path,
              text: "",
              publish: true,
              createOnly: true,
              requestId: parsed.requestId,
              metadata: { origin: "api", correlationId },
              author,
            })
          ).object.id;
        } catch (error) {
          if (!(error instanceof DaemonRefusalError)) throw error;
          const existing = await files.readTextFile({
            workspaceId,
            versionId: "main",
            path: parsed.path,
          });
          if (!existing) throw error;
          if (existing.metadataCorrelationId !== correlationId)
            return refuse("path-exists", "A file with this name already exists.");
          objectId = existing.objectId;
        }
        await seedRichDocLineage(deps.storage, replica, {
          workspaceId,
          path: parsed.path,
          objectId,
        });
        await replica.sync(signal);
        if (
          objectAt(parsed.path) !== objectId ||
          !deps.storage.mainLiveLineageExists({ workspaceId, objectId })
        )
          throw unconfirmed("the new page");
        return await complete({ ok: true, path: parsed.path, objectId });
      }

      if (parsed.operation === "restoreDeletedFile") {
        const rich = liveDocumentKindForPath(parsed.path) === "richdoc";
        await assertOutsideCollection(files, workspaceId, parsed.path, rich);
        const moment = await files.getMoment({ workspaceId, momentId: parsed.deleteMomentId });
        const unavailable = () =>
          refuse("restore-unavailable", "This deleted file can no longer be restored.");
        if (
          !moment ||
          moment.versionId !== "main" ||
          moment.operation !== "delete" ||
          moment.objectId !== parsed.objectId ||
          moment.path !== parsed.path ||
          !moment.beforePresent ||
          moment.beforeContentKind !== "text"
        )
          return unavailable();
        const text =
          moment.beforeText ??
          (moment.beforeBlobSha256
            ? await files.readTextBlob({ workspaceId, sha256: moment.beforeBlobSha256 })
            : null);
        if (text === null) return unavailable();
        const correlationId = `phone-restore:${parsed.requestId}`;
        const hadLineage =
          rich && deps.storage.mainLiveLineageExists({ workspaceId, objectId: parsed.objectId });
        const confirmRestored = async (replayed: boolean): Promise<AccountFileWriteResult> => {
          if (
            rich &&
            !(
              replayed &&
              liveEditors(deps.storage).connected({ workspaceId, objectId: parsed.objectId })
            )
          ) {
            try {
              await seedRichDocLineage(deps.storage, replica, {
                workspaceId,
                path: parsed.path,
                objectId: parsed.objectId,
                force: true,
              });
            } catch (error) {
              if (hadLineage || !(error instanceof DaemonRefusalError)) throw error;
            }
          }
          await replica.sync(signal);
          if (objectAt(parsed.path) !== parsed.objectId) throw unconfirmed("the restore");
          return await complete({ ok: true, path: parsed.path, objectId: parsed.objectId });
        };
        const checkExisting = async (): Promise<AccountFileWriteResult | "replay" | null> => {
          const hit = (await files.resolveFiles({ workspaceId, targets: [{ path: parsed.path }] }))
            .results[0];
          if (hit?.status !== "found") return null;
          if (hit.objectId === parsed.objectId) {
            const { moments } = await files.listMoments({
              workspaceId,
              versionId: "main",
              objectId: parsed.objectId,
              limit: 10,
              metadataOnly: true,
            });
            if (
              moments.some(
                (m) =>
                  m.path === parsed.path &&
                  m.metadataOrigin === "restore" &&
                  m.metadataCorrelationId === correlationId,
              )
            )
              return "replay";
          }
          return refuse("path-exists", "A file with this name already exists.");
        };
        const runMutation = <T>(work: () => Promise<T>) =>
          replica.withSyncPaused ? replica.withSyncPaused(work, signal) : work();
        const outcome = await runMutation(
          async (): Promise<AccountFileWriteResult | "replay" | null> => {
            const already = await checkExisting();
            if (already) return already;
            if (replica.root)
              await rm(join(replica.root, parsed.path), { force: true }).catch(() => undefined);
            try {
              const written = await files.writeTextFile({
                workspaceId,
                versionId: "main",
                path: parsed.path,
                text,
                publish: true,
                createOnly: true,
                restoreBeforeMomentId: parsed.deleteMomentId,
                requestId: parsed.requestId,
                metadata: { origin: "restore", correlationId },
                author,
              });
              if (written.object.id !== parsed.objectId) throw unconfirmed("the restore");
              return null;
            } catch (error) {
              if (!(error instanceof DaemonRefusalError)) throw error;
              const code = error.message;
              if (code === "live-page-owned" || code === "live-document-binding-active")
                return refuse("live-active", ACTIVE_MSG);
              if (code === "target-path-exists" || code === "restore-path-collision")
                return refuse("path-exists", "A file with this name already exists.");
              if (
                code === "synced-deletion-revival-refused" ||
                code === "restore-head-changed" ||
                code === "invalid-input"
              )
                return (await checkExisting()) ?? unavailable();
              throw error;
            }
          },
        );
        if (outcome && outcome !== "replay") return outcome;
        return await confirmRestored(outcome === "replay");
      }

      const operationId = `${OPERATION_ID_PREFIX}${parsed.requestId}`;
      const isRename = parsed.operation === "renameFile";
      const srcPath = isRename ? parsed.fromPath : parsed.path;
      const dstPath = isRename ? parsed.toPath : null;
      const caseOnly = dstPath !== null && srcPath.toLowerCase() === dstPath.toLowerCase();
      const rich = liveDocumentKindForPath(srcPath) === "richdoc";
      const resolve = async () => {
        await assertOutsideCollection(files, workspaceId, srcPath, !isRename && rich);
        const targets = dstPath ? [{ path: srcPath }, { path: dstPath }] : [{ path: srcPath }];
        const { versionId, results } = await files.resolveFiles({ workspaceId, targets });
        return { versionId, from: results[0], to: dstPath ? results[1] : undefined };
      };
      const blockedTarget = (to: Awaited<ReturnType<typeof resolve>>["to"]) =>
        to?.status === "found" && (!caseOnly || to.objectId !== parsed.expectedObjectId);
      const stale = () =>
        refuse(
          "stale-object",
          `This file changed before it could be ${isRename ? "renamed" : "deleted"}. Try again.`,
        );
      const finish = async (
        objectId: string,
        deleteMomentId?: string,
      ): Promise<AccountFileWriteResult> => {
        if (dstPath !== null) {
          const linksUpdated = caseOnly
            ? 0
            : (
                await files.rewriteHistoryLinks({
                  workspaceId,
                  operationId,
                  requestId: `${parsed.requestId}:links`,
                  author,
                  cancelSignal: signal,
                })
              ).links;
          await replica.sync(signal);
          if (objectAt(dstPath) !== objectId || (!caseOnly && objectAt(srcPath) === objectId))
            throw unconfirmed("the rename");
          if (rich) {
            const rebound = deps.storage.rebindRetiredServiceHostEnrollment({
              workspaceId,
              objectId,
              toPath: dstPath,
              ownerUserId: owner,
              guard: () => signal.throwIfAborted(),
            });
            if (rebound.status === "blocked") throw unconfirmed("the rename");
          }
          return await complete({
            ok: true,
            fromPath: srcPath,
            path: dstPath,
            objectId,
            linksUpdated,
          });
        }
        await replica.sync(signal);
        if (objectAt(srcPath) === objectId) throw unconfirmed("the deletion");
        deps.storage.clearDrainedDeletedServiceHostEnrollment({
          workspaceId,
          objectId,
          ownerUserId: owner,
          guard: () => signal.throwIfAborted(),
        });
        return await complete({
          ok: true,
          path: srcPath,
          objectId,
          ...(deleteMomentId ? { deleteMomentId } : {}),
        });
      };

      let { versionId, from, to } = await resolve();
      if (from?.status !== "found" || from.objectId !== parsed.expectedObjectId) {
        const canReplay =
          versionId === "main" &&
          (dstPath === null || (to?.status === "found" && to.objectId === parsed.expectedObjectId));
        if (canReplay) {
          const opMoments = (
            await files.readHistoryPage({
              workspaceId,
              versionId: "main",
              objectId: parsed.expectedObjectId,
              operationId,
              limit: 10,
            })
          ).moments;
          const replayed = opMoments.find((m) =>
            dstPath !== null
              ? m.operation === "rename" &&
                m.objectId === parsed.expectedObjectId &&
                m.beforePath === srcPath &&
                m.path === dstPath &&
                m.metadataCorrelationId === operationId
              : m.operation === "delete" &&
                m.objectId === parsed.expectedObjectId &&
                m.path === srcPath &&
                m.metadataCorrelationId === operationId,
          );
          if (replayed)
            return await finish(
              parsed.expectedObjectId,
              dstPath === null ? replayed.momentId : undefined,
            );
        }
        return from?.status === "found"
          ? stale()
          : refuse("not-found", "This file is no longer here.");
      }
      if (blockedTarget(to)) return refuse("path-exists", "A file with this name already exists.");
      let releaseLiveFence: (() => void) | undefined;
      try {
        if (rich) {
          const prepared = await prepareLiveMutation(
            deps,
            workspaceId,
            parsed.expectedObjectId,
            dstPath ?? undefined,
            owner,
            input.nowMs,
            signal,
          );
          if (prepared.blocked) return prepared.blocked;
          releaseLiveFence = prepared.release;
          await replica.sync(signal);
          await authorize();
        }
        const runMutation = <T>(work: () => Promise<T>) =>
          replica.withSyncPaused ? replica.withSyncPaused(work, signal) : work();
        let deleteMomentId: string | undefined;
        const refused = await runMutation(async (): Promise<AccountFileWriteResult | null> => {
          const hold = await files.holdCapture({ operationId });
          try {
            ({ from, to } = await resolve());
            if (from?.status !== "found")
              return refuse("not-found", "This file is no longer here.");
            if (from.objectId !== parsed.expectedObjectId) return stale();
            if (blockedTarget(to))
              return refuse("path-exists", "A file with this name already exists.");
            if (dstPath !== null) {
              const renamed = await files.renameTextFile({
                workspaceId,
                versionId: "main",
                fromPath: srcPath,
                toPath: dstPath,
                requestId: parsed.requestId,
                captureHoldId: hold.holdId,
                metadata: { origin: "api" },
                author,
              });
              if (renamed.object.id !== parsed.expectedObjectId) throw unconfirmed("the rename");
            } else {
              const deleted = await files.deleteTextFile({
                workspaceId,
                versionId: "main",
                path: srcPath,
                expectedObjectId: parsed.expectedObjectId,
                requestId: parsed.requestId,
                captureHoldId: hold.holdId,
                metadata: { origin: "api" },
                author,
              });
              if (replica.root)
                await rm(join(replica.root, srcPath), { force: true }).catch(() => undefined);
              deleteMomentId = deleted.moment.momentId;
            }
            return null;
          } finally {
            await files.releaseCapture(hold.holdId).catch(() => undefined);
          }
        });
        if (refused) return refused;
        return await finish(parsed.expectedObjectId, deleteMomentId);
      } finally {
        releaseLiveFence?.();
      }
    }),
  );
  return { result, cursor: currentAccountFeedCursor(deps.storage, workspaceId, null) };
}
