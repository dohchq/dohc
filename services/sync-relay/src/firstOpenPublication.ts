import {createHash} from "node:crypto";
import {validateUserWritePath} from "@dohc/workspace-core";
import {liveDocumentKindForPath} from "@dohc/workspace-contracts/live-documents";
import type {OrderedLiveUpdateCutPolicy} from "@dohc/ydoc-projection/live-journal-validation";
import {badRequest, notFound} from "./errors";
import {firstOpenBaseExceeds, type FirstOpenBaseBound, type FirstOpenBaseBounds, type FirstOpenBaseInput, type FirstOpenBaseResult} from "./firstOpenBase";
import {firstOpenOutcome, type FirstOpenFailure, type FirstOpenOutcome} from "./firstOpenOutcome";
import {liveValidation} from "./liveValidation";
import {assertSha256, parseString} from "./requestInputs";
import type {ServiceActivationConfig} from "./serviceActivationDriver";
import type {AppendLogBatchGuardContext, SyncRelayStorage} from "./storage";
import {firstOpenBasePayload, firstOpenOrigin, type FirstOpenPreparation} from "./storage/firstOpenEligibility";
import type {FirstOpenSource} from "./storage/firstOpenHistory";
import {activationDescriptorReserve, ordinaryActivationEntryBytes} from "./storage/ordinaryActivationSource";
import {enforceWorkspaceIdentity, parseOptionalWorkspaceIdentity} from "./workspaceReplicationRoutes";

/** Writer attempts per request: the first, then at most two after catching up. */
export const FIRST_OPEN_WRITER_ATTEMPTS = 3;

/** What a service host may name. The relay derives everything else. */
export interface FirstOpenRequest {
  readonly objectId: string;
  readonly path: string;
  readonly sourceMomentId: string;
  readonly sourceDigest: string;
  readonly identity: {readonly replicationEpoch: string; readonly streamIdentity: string} | null;
}
const FIELDS = new Set(["objectId", "path", "sourceMomentId", "sourceDigest", "replicationEpoch", "streamIdentity"]);

/** Refuses any field beyond the source and the replication identity: bytes, lineage, origin, time, authors and limits are the relay's. */
export function parseFirstOpenRequest(body: Record<string, unknown>): FirstOpenRequest {
  if (Object.keys(body).some(key => !FIELDS.has(key))) throw badRequest("first-open names only its source and replication identity");
  const path = parseString(body.path, "path", 1024), checked = validateUserWritePath(path);
  if (!checked.ok || checked.normalized !== path || liveDocumentKindForPath(path) !== "richdoc") throw badRequest("path must be a live Markdown document");
  const sourceDigest = parseString(body.sourceDigest, "sourceDigest", 64);
  assertSha256(sourceDigest);
  return Object.freeze({objectId: parseString(body.objectId, "objectId", 256), path, sourceMomentId: parseString(body.sourceMomentId, "sourceMomentId", 256),
    sourceDigest, identity: parseOptionalWorkspaceIdentity(body)});
}

/** The configured bound a base no longer fits, found inside the writer. */
class FirstOpenBoundExceeded extends Error {
  constructor(readonly bound: FirstOpenBaseBound) {super("A first-open base exceeds its configured bounds.");}
}

/** A history read or build that failed rather than answered. */
class FirstOpenStepFailed extends Error {
  constructor(readonly reason: Exclude<FirstOpenFailure, "storage-failed">, cause: unknown) {super(`First-open ${reason}.`, {cause});}
}

const sqliteFailure = (error: unknown) => error instanceof Error && (error as {code?: unknown}).code === "ERR_SQLITE_ERROR";

export type FirstOpenBuild = (policy: OrderedLiveUpdateCutPolicy, input: FirstOpenBaseInput, signal: AbortSignal) => Promise<FirstOpenBaseResult | {kind: "busy"}>;
export type FirstOpenPublisher = ReturnType<typeof createFirstOpenPublisher>;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * Gives a hosted document with only ordinary history its first live base, or
 * says why not. `activation` answers the configuration the service host's
 * driver runs with, so the base fits what that driver captures and verifies.
 */
export function createFirstOpenPublisher(options: {
  storage: SyncRelayStorage;
  /** The relay database namespace. */
  namespace: string;
  activation(): ServiceActivationConfig | undefined;
  /** The first-open worker, unless a test injects another. */
  build?: FirstOpenBuild;
}) {
  const {storage, namespace} = options;
  const build: FirstOpenBuild = options.build ?? ((policy, input, signal) => liveValidation.buildFirstOpenBase(policy, input, signal));
  // Every bound native capture and the relay's verifier apply to a base-only history.
  const bounds = (config: ServiceActivationConfig, source: FirstOpenSource, identity: {replicationEpoch: string; streamIdentity: string}, originId: string): FirstOpenBaseBounds => ({
    maxCaptureBytes: config.maxCaptureBytes, maxBytesPerDrain: config.maxBytesPerDrain,
    descriptorBytes: activationDescriptorReserve({relayDatabaseNamespace: namespace, workspaceId: source.workspaceId, objectId: source.objectId,
      currentPath: source.path, ...identity, baseOriginId: originId, sourceMomentId: source.sourceMomentId, sourceDigest: source.sourceDigest,
      sourceByteLength: source.sourceByteLength}),
    logEntryBytes: ordinaryActivationEntryBytes({relay_seq: Number.MAX_SAFE_INTEGER, origin_id: originId, origin_seq: 0, op_kind: "ydoc.update"},
      Buffer.byteLength(firstOpenBasePayload(source, "0".repeat(64)))),
  });

  return async (input: {workspaceId: string; ownerUserId: string; request: FirstOpenRequest; guard(): void; signal: AbortSignal}): Promise<FirstOpenOutcome> => {
    const {workspaceId, ownerUserId, request, guard, signal} = input;
    const answer = (value: Parameters<typeof firstOpenOutcome>[1]) => firstOpenOutcome({workspaceId, ...request}, value);
    // The document comes from its enrollment and its path's current binding, never from the caller.
    const standing = (inAppend?: AppendLogBatchGuardContext["enforceWorkspaceIdentity"]) => {
      guard();
      enforceWorkspaceIdentity(storage, workspaceId, request.identity, inAppend);
      return storage.readFirstOpenStanding({workspaceId, ownerUserId, path: request.path});
    };
    const objectId = standing();
    if (objectId === null || objectId !== request.objectId) throw notFound();
    // A document out of scope by the time the request ends answers as an absent one, whatever happened to it.
    const standingKept = () => {
      if (signal.aborted) return true;
      try {return standing() === objectId;} catch {return false;}
    };
    let outcome: FirstOpenOutcome;
    try {outcome = await publish(objectId);}
    catch (error) {
      if (!standingKept()) throw notFound();
      const reason = error instanceof FirstOpenStepFailed ? error.reason : !signal.aborted && sqliteFailure(error) ? "storage-failed" : undefined;
      if (!reason) throw error;
      console.error("[sync-relay] first-open unavailable", error);
      return answer({kind: "unavailable", reason});
    }
    if (!standingKept()) throw notFound();
    return outcome;

  async function publish(objectId: string): Promise<FirstOpenOutcome> {
    const identity = storage.getWorkspaceIdentity(workspaceId);
    if (!identity) throw notFound();
    const named = {workspaceId, objectId, path: request.path, sourceMomentId: request.sourceMomentId, sourceDigest: request.sourceDigest};
    const originId = firstOpenOrigin(namespace, {...named, sourceByteLength: 0}, identity);
    // An exact receipt answers before freshness, conversion or current bounds, so a lost reply replays.
    const replay = () => {
      const stored = storage.readFirstOpenReceipt(originId, {...named, sourceByteLength: 0});
      if (stored.kind === "receipt") return answer({kind: "replayed", receipt: stored.receipt});
      if (stored.kind === "occupied") return answer({kind: "integrity", reason: "reserved-receipt"});
      return undefined;
    };
    // Another request may publish this receipt after the first look; only then is history or a moved source this request's own.
    const refusal = (refused: Exclude<FirstOpenPreparation, {kind: "prepared"}> | {kind: "refused"; reason: "prior-authority" | "stale-source"}) => {
      if (refused.kind === "busy") return answer({kind: "unavailable", reason: "busy"});
      return replay() ?? answer(refused.reason === "prior-authority" ? {kind: "existing-history", reason: "prior-authority"} : {kind: "refused", reason: refused.reason});
    };
    // A failed history read or build says nothing about the document; a cancelled one stays cancelled.
    const step = async <T>(reason: FirstOpenStepFailed["reason"], run: () => Promise<T>) => {
      try {return await run();}
      catch (error) {throw signal.aborted ? error : new FirstOpenStepFailed(reason, error);}
    };
    const replayed = replay();
    if (replayed) return replayed;
    const config = options.activation();
    if (!config) throw notFound();

    // The relay's current ordinary text head, exactly as stored. No await separates it from the first look, so a stale head needs no second one.
    const head = storage.readFirstOpenMoment(workspaceId, objectId);
    if (!head || head.sourceMomentId !== request.sourceMomentId || head.path !== request.path || head.sourceDigest !== request.sourceDigest ||
      head.contentKind !== "text" || head.sourceByteLength === null) return answer({kind: "refused", reason: "stale-source"});
    const bytes = storage.getBlob(workspaceId, head.sourceDigest);
    if (!bytes || bytes.byteLength !== head.sourceByteLength || sha256(bytes) !== head.sourceDigest) return answer({kind: "integrity", reason: "source-evidence"});
    let markdown: string;
    try {markdown = new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(bytes);}
    catch {return answer({kind: "refused", reason: "unsupported-source"});}
    const source: FirstOpenSource = Object.freeze({...named, sourceByteLength: head.sourceByteLength});

    const preparation = await step("history-unavailable", () => storage.prepareFirstOpen(source, signal));
    if (preparation.kind !== "prepared") return refusal(preparation);
    let proof = preparation.proof;
    const built = await step("worker-failed", () => build(config.validation, {document: {workspaceId, mainVersionId: "main", objectId},
      currentPath: source.path, headMomentId: source.sourceMomentId, markdown, sourceDigest: source.sourceDigest,
      sourceByteLength: source.sourceByteLength, bounds: bounds(config, source, identity, originId)}, signal));
    signal.throwIfAborted();
    if (built.kind === "busy") return answer({kind: "unavailable", reason: "busy"});
    if (built.kind === "refused") {
      switch (built.reason) {
        case "source-mismatch": return answer({kind: "integrity", reason: "source-evidence"});
        case "invalid-base": return answer({kind: "integrity", reason: "candidate"});
        case "unsupported-source": return answer({kind: "refused", reason: "unsupported-source"});
        default: return answer({kind: "refused", reason: "too-large", code: built.reason});
      }
    }

    const base = {namespace, bytes: built.base, recordedAtMs: head.recordedAtMs};
    // The writer's own checks: authorization, standing and the bounds that apply now.
    const writerGuard = (context: AppendLogBatchGuardContext) => {
      if (standing(context.enforceWorkspaceIdentity) !== objectId) throw notFound();
      const current = options.activation();
      if (!current) throw notFound();
      const exceeded = firstOpenBaseExceeds(built.sizes, bounds(current, source, identity, originId));
      if (exceeded) throw new FirstOpenBoundExceeded(exceeded);
    };
    for (let attempt = 1; ; attempt++) {
      let written;
      try {written = storage.writeFirstOpen(proof, base, writerGuard);}
      catch (error) {
        if (error instanceof FirstOpenBoundExceeded) return answer({kind: "refused", reason: "too-large", code: error.bound});
        throw error;
      }
      if (written.kind === "published") return answer({kind: "published", receipt: written.receipt});
      if (written.kind === "occupied") return answer({kind: "integrity", reason: "reserved-receipt"});
      if (written.kind === "refused") return refusal(written);
      if (attempt === FIRST_OPEN_WRITER_ATTEMPTS) return replay() ?? answer({kind: "unavailable", reason: "contention"});
      const caught = await step("history-unavailable", () => storage.catchUpFirstOpen(proof, signal));
      if (caught.kind !== "prepared") return refusal(caught);
      proof = caught.proof;
    }
  }
  };
}
