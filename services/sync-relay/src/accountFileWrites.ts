import { LIVE_MARKDOWN_MAX_BYTES } from "@dohc/live-session-contract/limits";
import { isFolderMarkerPath } from "@dohc/security-contract/access-rules";
import { OPERATION_ID_PREFIX } from "@dohc/workspace-contracts/engine";
import { liveDocumentKindForPath } from "@dohc/workspace-contracts/live-documents";
import { workspaceDestinationError } from "@dohc/workspace-contracts/workspace-paths";
import { validateUserWritePath } from "@dohc/workspace-core";
import {
  DaemonRefusalError,
  openEngineYdocProviderSession,
  VersionedLiveAdapter,
  type WriteAuthor,
} from "@dohc/workspace-engine-client";
import { currentAccountFeedCursor, hiddenFile } from "./accountFeed";
import { badRequest, RelayError } from "./errors";
import { untilAborted } from "./namedLiveFrameHost";
import { observeRelayWrites } from "./relayWriteChanges";
import type { CopyVisitor, ServerCopies } from "./serverCopies";
import type { SyncRelayStorage } from "./storage";
import {
  ServiceHostRetirementConflict,
  type RetireIdleServiceHostEnrollmentResult,
  type ServiceHostRetirementPreparation,
} from "./storage/serviceHostEnrollment";

export type AccountFileWriteOperation = "createPage" | "renameFile" | "deleteFile";
export const isAccountFileWriteOperation = (name: string): name is AccountFileWriteOperation =>
  name === "createPage" || name === "renameFile" || name === "deleteFile";

export type AccountFileWriteRefusal =
  | "invalid-path"
  | "path-exists"
  | "not-found"
  | "stale-object"
  | "live-active"
  | "live-unsettled";

export type AccountFileWriteResult =
  | {
      readonly ok: true;
      readonly path: string;
      readonly objectId: string;
      readonly fromPath?: string;
      readonly linksUpdated?: number;
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
const refuse = (refusal: AccountFileWriteRefusal, reason: string): AccountFileWriteResult => ({
  ok: false,
  refusal,
  reason,
});

function parseFields(args: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (
    !args ||
    typeof args !== "object" ||
    Array.isArray(args) ||
    Object.keys(args).some((k) => !allowed.includes(k))
  )
    throw badRequest("Invalid file operation arguments.");
  return args as Record<string, unknown>;
}
const parseRequestId = (v: unknown) => {
  if (typeof v !== "string" || !REQUEST_ID_RE.test(v) || v.includes(":undo:"))
    throw badRequest("A valid requestId is required.");
  return v;
};
const parseObjectId = (v: unknown) => {
  if (typeof v !== "string" || !v.length || v.length > 128)
    throw badRequest("A valid expectedObjectId is required.");
  return v;
};

export function validateAllowedFileWritePath(
  value: unknown,
  options: { readonly allowSketch: boolean; readonly checkDestination: boolean },
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
  if (
    kind === null ||
    (!options.allowSketch && kind !== "page") ||
    (options.checkDestination && workspaceDestinationError(value, "win32") !== null)
  )
    throw badRequest("This path cannot be changed here.");
  return { path: value, kind };
}

export function parseAccountFileWrite(operation: AccountFileWriteOperation, args: unknown) {
  if (operation === "createPage") {
    const body = parseFields(args, ["path", "requestId", "content"]);
    const { path } = validateAllowedFileWritePath(body.path, {
      allowSketch: false,
      checkDestination: true,
    });
    const content = body.content === undefined ? "" : body.content;
    if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > LIVE_MARKDOWN_MAX_BYTES)
      throw badRequest("Invalid page content.");
    return { operation, path, content, requestId: parseRequestId(body.requestId) } as const;
  }
  if (operation === "renameFile") {
    const body = parseFields(args, ["fromPath", "toPath", "expectedObjectId", "requestId"]);
    const from = validateAllowedFileWritePath(body.fromPath, {
      allowSketch: true,
      checkDestination: false,
    });
    const to = validateAllowedFileWritePath(body.toPath, {
      allowSketch: true,
      checkDestination: true,
    });
    if (from.kind !== to.kind || from.path === to.path)
      throw badRequest("Rename must keep the same file kind and choose a different path.");
    return {
      operation,
      fromPath: from.path,
      toPath: to.path,
      expectedObjectId: parseObjectId(body.expectedObjectId),
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
      clearInterval(poll);
      unwatch();
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => stop(() => reject(signal.reason));
    const check = () => {
      if (isDrained(storage, workspaceId, objectId)) stop(() => resolve(true));
    };
    const unwatch = observeRelayWrites(storage, check);
    const poll = setInterval(check, 50);
    poll.unref?.();
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
  deps: { storage: SyncRelayStorage; liveHost?: () => AccountFileWriteLiveHost | undefined },
  workspaceId: string,
  objectId: string,
  ownerUserId: string,
  nowMs: () => number,
  signal: AbortSignal,
): Promise<AccountFileWriteResult | null> {
  const host = deps.liveHost?.();
  const fence = (
    prepared?: ServiceHostRetirementPreparation,
  ): RetireIdleServiceHostEnrollmentResult =>
    deps.storage.retireIdleServiceHostEnrollment({
      workspaceId,
      objectId,
      ownerUserId,
      prepared,
      drainNow: host === undefined,
      nowMs: nowMs(),
      guard: () => signal.throwIfAborted(),
    });
  let outcome: RetireIdleServiceHostEnrollmentResult | "waiting";
  try {
    const enrolled = deps.storage.readServiceHostEnrollmentByObjectId(workspaceId, objectId);
    outcome =
      enrolled && host ? await host.stop({ workspaceId, objectId }, fence, signal) : fence();
  } catch (error) {
    if (
      error instanceof ServiceHostRetirementConflict ||
      (error instanceof RelayError && UNSETTLED_CODES.has(error.code))
    )
      return refuse("live-unsettled", UNSETTLED_MSG);
    throw error;
  }
  if (outcome === "waiting" || outcome.status === "unsettled")
    return refuse("live-unsettled", UNSETTLED_MSG);
  if (outcome.status === "active")
    return refuse(
      "live-active",
      "Someone is editing this page right now. Close it everywhere, then try again.",
    );
  if (outcome.status === "retired" && host) {
    host.reconcile();
    if (!(await waitForDrain(deps.storage, workspaceId, objectId, signal)))
      return refuse("live-unsettled", UNSETTLED_MSG);
  }
  return null;
}

export async function runAccountFileWrite(
  deps: {
    storage: SyncRelayStorage;
    copies: ServerCopies;
    liveHost?: () => AccountFileWriteLiveHost | undefined;
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
        const correlationId = `phone-create:${parsed.requestId}`;
        let objectId: string;
        try {
          objectId = (
            await files.writeTextFile({
              workspaceId,
              versionId: "main",
              path: parsed.path,
              text: parsed.content,
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
        if (!deps.storage.mainLiveLineageExists({ workspaceId, objectId })) {
          const session = await openEngineYdocProviderSession({
            transport: replica.client,
            workspace: replica.workspace,
            versionId: "main",
            path: parsed.path,
            expectedObjectId: objectId,
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
        await replica.sync(signal);
        if (
          objectAt(parsed.path) !== objectId ||
          !deps.storage.mainLiveLineageExists({ workspaceId, objectId })
        )
          throw unconfirmed("the new page");
        return await complete({ ok: true, path: parsed.path, objectId });
      }

      const operationId = `${OPERATION_ID_PREFIX}${parsed.requestId}`;
      const isRename = parsed.operation === "renameFile";
      const srcPath = isRename ? parsed.fromPath : parsed.path;
      const dstPath = isRename ? parsed.toPath : null;
      const caseOnly = dstPath !== null && srcPath.toLowerCase() === dstPath.toLowerCase();
      const rich = liveDocumentKindForPath(srcPath) === "richdoc";
      const resolve = async () => {
        const targets = dstPath ? [{ path: srcPath }, { path: dstPath }] : [{ path: srcPath }];
        const { results } = await files.resolveFiles({ workspaceId, targets });
        return { from: results[0], to: results[1] };
      };
      const blockedTarget = (to: Awaited<ReturnType<typeof resolve>>["to"]) =>
        to?.status === "found" && (!caseOnly || to.objectId !== parsed.expectedObjectId);
      const stale = () =>
        refuse(
          "stale-object",
          `This file changed before it could be ${isRename ? "renamed" : "deleted"}. Try again.`,
        );
      const finish = async (objectId: string): Promise<AccountFileWriteResult> => {
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
          if (objectAt(dstPath) !== objectId || (!caseOnly && objectAt(srcPath) !== undefined))
            throw unconfirmed("the rename");
          if (rich)
            deps.storage.rebindRetiredServiceHostEnrollment({
              workspaceId,
              objectId,
              toPath: dstPath,
              ownerUserId: owner,
              guard: () => signal.throwIfAborted(),
            });
          return await complete({
            ok: true,
            fromPath: srcPath,
            path: dstPath,
            objectId,
            linksUpdated,
          });
        }
        await replica.sync(signal);
        if (objectAt(srcPath) !== undefined) throw unconfirmed("the deletion");
        deps.storage.clearDrainedDeletedServiceHostEnrollment({
          workspaceId,
          objectId,
          ownerUserId: owner,
          guard: () => signal.throwIfAborted(),
        });
        return await complete({ ok: true, path: srcPath, objectId });
      };

      let { from, to } = await resolve();
      if (from?.status !== "found") {
        const latest = (
          await files.listMoments({
            workspaceId,
            versionId: "main",
            objectId: parsed.expectedObjectId,
            limit: 1,
            metadataOnly: true,
          })
        ).moments[0];
        const replayed =
          dstPath !== null
            ? to?.status === "found" &&
              to.objectId === parsed.expectedObjectId &&
              latest?.operation === "rename" &&
              latest.beforePath === srcPath &&
              latest.path === dstPath &&
              latest.metadataCorrelationId === operationId
            : latest?.operation === "delete" &&
              latest.path === srcPath &&
              latest.metadataCorrelationId === operationId;
        return replayed
          ? await finish(parsed.expectedObjectId)
          : refuse("not-found", "This file is no longer here.");
      }
      if (from.objectId !== parsed.expectedObjectId) return stale();
      if (blockedTarget(to)) return refuse("path-exists", "A file with this name already exists.");
      if (rich) {
        const blocked = await prepareLiveMutation(
          deps,
          workspaceId,
          parsed.expectedObjectId,
          owner,
          input.nowMs,
          signal,
        );
        if (blocked) return blocked;
        await replica.sync(signal);
        await authorize();
        ({ from, to } = await resolve());
        if (from?.status !== "found" || from.objectId !== parsed.expectedObjectId) return stale();
        if (blockedTarget(to))
          return refuse("path-exists", "A file with this name already exists.");
      }
      let mutatedObjectId = parsed.expectedObjectId;
      const hold = await files.holdCapture({ operationId });
      try {
        if (dstPath !== null) {
          mutatedObjectId = (
            await files.renameTextFile({
              workspaceId,
              versionId: "main",
              fromPath: srcPath,
              toPath: dstPath,
              requestId: parsed.requestId,
              captureHoldId: hold.holdId,
              metadata: { origin: "api" },
              author,
            })
          ).object.id;
        } else {
          await files.deleteTextFile({
            workspaceId,
            versionId: "main",
            path: srcPath,
            expectedObjectId: parsed.expectedObjectId,
            requestId: parsed.requestId,
            captureHoldId: hold.holdId,
            metadata: { origin: "api" },
            author,
          });
        }
      } finally {
        await files.releaseCapture(hold.holdId).catch(() => undefined);
      }
      return await finish(mutatedObjectId);
    }),
  );
  return { result, cursor: currentAccountFeedCursor(deps.storage, workspaceId, null) };
}
