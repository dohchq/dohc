import {parseLiveObjectBinding} from "@dohc/live-session-contract/live-object-binding";
import {parseLiveUpdateIdentifier} from "@dohc/live-session-contract/live-update-admission";
import type {DesktopOwnerDeliveryDocument} from "./desktopOwnerDelivery";
import type {LiveDocumentPath} from "./moveAcceptedEditsGuard";
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
    documents.push({binding, relayDatabaseNamespace: parseLiveUpdateIdentifier(row.document.relayDatabaseNamespace)});
  }
  return documents;
}

/**
 * Every page a complete list names, ready or not, for the move guard. Call it
 * after readyOwnerDeliveryDocuments has accepted the same response.
 */
export function listedOwnerDeliveryPaths(value: unknown, ready: readonly DesktopOwnerDeliveryDocument[]): LiveDocumentPath[] {
  const listed = ready.map(({binding}) => ({path: binding.currentPath, objectId: binding.objectId}));
  for (const row of (value as {documents: {path: string; status: string; objectId?: unknown}[]}).documents) {
    if (row.status !== "ready" && typeof row.objectId === "string" && row.objectId) listed.push({path: row.path, objectId: row.objectId});
  }
  return listed;
}

/**
 * A move's catch-up: one observing owner sync for each listed page, in turn.
 * True only when each one answered. A page that isn't ready answers false.
 */
export async function catchUpOwnerDocuments(documents: readonly DesktopOwnerDeliveryDocument[], objectIds: readonly string[],
  sync: (document: DesktopOwnerDeliveryDocument) => Promise<string>, check: () => void = () => undefined): Promise<boolean> {
  for (const objectId of objectIds) {
    const document = documents.find(row => row.binding.objectId === objectId);
    if (!document) return false;
    const outcome = await sync(document);
    check();
    if (outcome !== "acknowledged" && outcome !== "empty" && outcome !== "unbound") return false;
  }
  return true;
}

/** One workspace and one document per pass, with no unbounded concurrent work. */
export function startServerOwnerDelivery(options: {
  workspaceIds(): string[];
  attemptTimeoutMs: number;
  retryDelayMs: number;
  runPass(workspaceId: string, documentIndex: number, signal: AbortSignal): Promise<{documentCount: number; acknowledged: boolean}>;
  /** One owner sync for each listed document, for a move waiting on them. True only when every one answered. */
  runTargetedPass?(workspaceId: string, objectIds: readonly string[], signal: AbortSignal): Promise<boolean>;
  onError(error: unknown): void;
}) {
  const lifetime = new AbortController(), nextDocument = new Map<string, number>();
  const retries = Effect.runSync(Queue.sliding<void>(1));
  let nextWorkspace = 0;
  let retryWorkspace: string | undefined;
  // One request per workspace. The move guard's coverage rule keeps a slot to one attempt.
  const targeted = new Map<string, {objectIds: readonly string[]; signal: AbortSignal; answer(answered: boolean): void}>();
  let lastTurnTargeted = false;
  const targetedTurn = async () => {
    for (const [id, request] of targeted) if (request.signal.aborted) {targeted.delete(id); request.answer(false);}
    const next = targeted.entries().next();
    if (next.done) return false;
    const [workspaceId, request] = next.value;
    targeted.delete(workspaceId);
    let answered = false;
    try {
      answered = await options.runTargetedPass!(workspaceId, request.objectIds,
        AbortSignal.any([lifetime.signal, request.signal, AbortSignal.timeout(options.attemptTimeoutMs)]));
    } catch { /* The waiting move goes ahead; ordinary passes report their own failures. */ }
    request.answer(answered && !lifetime.signal.aborted);
    return true;
  };
  const pass = Effect.tryPromise({
    try: async () => {
      // With more than one workspace open, each targeted turn is followed by an ordinary one.
      if (targeted.size && !(lastTurnTargeted && options.workspaceIds().length > 1) && await targetedTurn()) {
        lastTurnTargeted = true;
        return {documentCount: 1, acknowledged: false, targeted: true};
      }
      lastTurnTargeted = false;
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
    let delayMs = 0, ordinaryDelayMs = 0;
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
      // A targeted turn keeps the ordinary schedule, and an explicit retry whose wake-up it took.
      if ("targeted" in result) {delayMs = targeted.size || retryWorkspace ? 0 : ordinaryDelayMs; continue;}
      ordinaryDelayMs = retryWorkspace ? 0 : result.acknowledged ? Math.min(options.retryDelayMs, 200)
        : result.documentCount === 0 ? Math.min(options.retryDelayMs * 5, 60_000) : options.retryDelayMs;
      delayMs = targeted.size ? 0 : ordinaryDelayMs;
    }
  })), {signal: lifetime.signal});
  return {
    retry(workspaceId: string) {
      if (lifetime.signal.aborted) return;
      retryWorkspace = workspaceId;
      Queue.offerUnsafe(retries, undefined);
    },
    /** Resolves true once one owner sync answered for every listed document. Never rejects. */
    catchUp(workspaceId: string, objectIds: readonly string[], signal: AbortSignal): Promise<boolean> {
      if (lifetime.signal.aborted || signal.aborted || !options.runTargetedPass) return Promise.resolve(false);
      return new Promise<boolean>(answer => {
        targeted.get(workspaceId)?.answer(false);
        targeted.set(workspaceId, {objectIds: [...objectIds], signal, answer});
        Queue.offerUnsafe(retries, undefined);
      });
    },
    async stop() {
      lifetime.abort();
      for (const request of targeted.values()) request.answer(false);
      targeted.clear();
      const exit = await finished;
      if (exit._tag === "Failure" && !Cause.hasInterruptsOnly(exit.cause)) throw Cause.squash(exit.cause);
    },
  };
}
