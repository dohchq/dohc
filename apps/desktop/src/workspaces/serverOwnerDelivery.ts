import {parseLiveObjectBinding} from "@dohc/live-session-contract/live-object-binding";
import {parseLiveUpdateIdentifier} from "@dohc/live-session-contract/live-update-admission";
import type {DesktopOwnerDeliveryDocument} from "./desktopOwnerDelivery";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import {ownerDeliveryWait} from "./ownerDeliveryWait";

/** Only authenticated, ready server targets may enter native owner enrollment. */
export function readyOwnerDeliveryDocuments(value: unknown, workspaceId: string): DesktopOwnerDeliveryDocument[] {
  if (!value || typeof value !== "object" || !("ok" in value) || value.ok !== true ||
    !("documents" in value) || !Array.isArray(value.documents) || value.documents.length > 64) {
    throw new Error("Invalid owner live document response.");
  }
  const documents: DesktopOwnerDeliveryDocument[] = [];
  const objects = new Set<string>();
  for (const row of value.documents) {
    if (!row || typeof row !== "object" || typeof row.path !== "string" ||
      !["preparing", "ready", "paused", "unavailable"].includes(row.status)) throw new Error("Invalid owner live document status.");
    if (row.status !== "ready") continue;
    if (!row.document || typeof row.document !== "object") throw new Error("Missing owner live document binding.");
    const binding = parseLiveObjectBinding(row.document.binding);
    if (binding.workspaceId !== workspaceId || binding.mainVersionId !== "main" || binding.currentPath !== row.path || objects.has(binding.objectId)) {
      throw new Error("Owner live document binding differs from the requested workspace.");
    }
    objects.add(binding.objectId);
    documents.push({binding, relayDatabaseNamespace: parseLiveUpdateIdentifier(row.document.relayDatabaseNamespace),
      shareId: parseLiveUpdateIdentifier(row.document.shareId)});
  }
  return documents;
}

/** One workspace and one document per pass, with no unbounded concurrent work. */
export function startServerOwnerDelivery(options: {
  workspaceIds(): string[];
  attemptTimeoutMs: number;
  retryDelayMs: number;
  runPass(workspaceId: string, documentIndex: number, signal: AbortSignal): Promise<{documentCount: number; acknowledged: boolean}>;
  onError(error: unknown): void;
}) {
  const lifetime = new AbortController(), nextDocument = new Map<string, number>();
  const retries = Effect.runSync(Queue.sliding<void>(1));
  let nextWorkspace = 0;
  let retryWorkspace: string | undefined;
  const pass = Effect.tryPromise({
    try: async () => {
      const requested = retryWorkspace; retryWorkspace = undefined;
      const workspaces = options.workspaceIds();
      for (const id of nextDocument.keys()) if (!workspaces.includes(id)) nextDocument.delete(id);
      if (!workspaces.length) return {documentCount: 0, acknowledged: false};
      if (requested && workspaces.includes(requested)) nextWorkspace = workspaces.indexOf(requested);
      const workspaceId = workspaces[nextWorkspace % workspaces.length]!;
      nextWorkspace = (nextWorkspace + 1) % workspaces.length;
      const index = nextDocument.get(workspaceId) ?? 0;
      const result = await options.runPass(workspaceId, index, AbortSignal.any([lifetime.signal, AbortSignal.timeout(options.attemptTimeoutMs)]));
      if (lifetime.signal.aborted) return {documentCount: 0, acknowledged: false};
      nextDocument.set(workspaceId, result.documentCount ? (index + 1) % result.documentCount : 0);
      return {documentCount: result.documentCount, acknowledged: result.acknowledged || index + 1 < result.documentCount};
    },
    catch: error => error,
  }).pipe(Effect.catch(error => {
    if (!lifetime.signal.aborted) {try {options.onError(error);} catch { /* Keep retrying after a logging failure. */ }}
    return Effect.succeed({documentCount: 0, acknowledged: false});
  }));
  const finished = Effect.runPromiseExit(Effect.scoped(Effect.gen(function* () {
    yield* Effect.acquireRelease(Effect.succeed(retries), Queue.shutdown);
    let delayMs = 0;
    while (!lifetime.signal.aborted) {
      if (delayMs === 0) yield* ownerDeliveryWait(0);
      else {
        const requested = yield* Effect.raceFirst(
          ownerDeliveryWait(delayMs).pipe(Effect.as(false)),
          Queue.take(retries).pipe(Effect.as(true)),
        );
        if (requested) yield* ownerDeliveryWait(0);
      }
      yield* Queue.clear(retries);
      // A retry wakes the idle wait, but never releases an unfinished pass.
      const result = yield* Effect.uninterruptible(pass);
      delayMs = retryWorkspace ? 0 : result.acknowledged ? Math.min(options.retryDelayMs, 200)
        : result.documentCount === 0 ? Math.min(options.retryDelayMs * 5, 60_000) : options.retryDelayMs;
    }
  })), {signal: lifetime.signal});
  return {
    retry(workspaceId: string) {
      if (lifetime.signal.aborted) return;
      retryWorkspace = workspaceId;
      Queue.offerUnsafe(retries, undefined);
    },
    async stop() {
      lifetime.abort();
      const exit = await finished;
      if (exit._tag === "Failure" && !Cause.hasInterruptsOnly(exit.cause)) throw Cause.squash(exit.cause);
    },
  };
}
