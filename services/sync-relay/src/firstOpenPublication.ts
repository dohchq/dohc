import {createHash} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {LIVE_MARKDOWN_MAX_BYTES} from "@dohc/live-session-contract/limits";
import {validateUserWritePath} from "@dohc/workspace-core";
import {firstOpenOutcome, type FirstOpenBaseBound, type FirstOpenFailure, type FirstOpenHostFailure, type FirstOpenOutcome} from "@dohc/workspace-contracts/first-open";
import {liveDocumentKindForPath} from "@dohc/workspace-contracts/live-documents";
import {firstOpenCandidateBinding, type FirstOpenCandidateCheck, type FirstOpenCandidateInput} from "@dohc/workspace-engine-client/daemon";
import type {OrderedLiveUpdateCutPolicy} from "@dohc/ydoc-projection/live-journal-validation";
import {badRequest, notFound, RelayError} from "./errors";
import {firstOpenBaseExceeds, firstOpenEncodingCap, type FirstOpenBaseBounds, type FirstOpenBaseInput,
  type FirstOpenBaseResult, type FirstOpenBaseSizes} from "./firstOpenBase";
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
/** The wait before the relay builds a source again after its build passed the deadline. Each repeat doubles it, up to the cap. */
export const FIRST_OPEN_DEADLINE_WAIT_MS = 60_000;
const FIRST_OPEN_DEADLINE_WAIT_CAP_MS = 60 * 60_000;
/**
 * How many sources' waits the relay keeps. Full, it forgets the wait it set
 * longest ago, and that source builds at once when asked again. Each wait
 * costs a build that held the one first-open slot to its deadline, so at the
 * default deadline the oldest of these was set at least 17 hours before, and
 * its wait has passed.
 */
const FIRST_OPEN_DEADLINE_WAITS = 1_024;

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

/**
 * What the service host's engine said about a candidate, or why it gave no
 * verdict. An answer holds only while `current()` does: the host that checked
 * still stands with the workspace attached. `host-capacity`: the host's
 * configuration can never admit this check. `integrity`: what the relay sent
 * and what the engine read disagree.
 */
export type FirstOpenNativeCheck =
  | {readonly kind: "answered"; readonly check: FirstOpenCandidateCheck; current(): boolean}
  | {readonly kind: "unavailable"; readonly reason: FirstOpenHostFailure | "busy"}
  | {readonly kind: "host-capacity"}
  | {readonly kind: "integrity"};
/** The running service host's check. Cancellation rejects with the signal's reason. */
export interface FirstOpenCheckHost {
  checkFirstOpenCandidate(workspaceId: string, input: FirstOpenCandidateInput, signal: AbortSignal): Promise<FirstOpenNativeCheck>;
}

/** The configured bound a base no longer fits, found inside the writer. */
class FirstOpenBoundExceeded extends Error {
  constructor(readonly bound: FirstOpenBaseBound) {super("A first-open base exceeds its configured bounds.");}
}
/**
 * A check that no longer holds in the writer. `host-absent`: the host that
 * checked retired or detached its workspace. `reconfigured`: the validation
 * policy the base was built under changed.
 */
class FirstOpenCheckLapsed extends Error {
  constructor(readonly reason: "host-absent" | "reconfigured") {super("A first-open check no longer holds.");}
}

/** A history read or build that failed rather than answered. */
class FirstOpenStepFailed extends Error {
  constructor(readonly reason: Exclude<FirstOpenFailure, "storage-failed">, cause: unknown) {super(`First-open ${reason}.`, {cause});}
}

// BUSY, LOCKED, NOMEM, IOERR, FULL and CANTOPEN can pass. Every other code, CORRUPT and NOTADB among them, is the relay's own fault.
const TRANSIENT_SQLITE = new Set([5, 6, 7, 10, 13, 14]);
// The history reader's read-only connection can also meet another connection's WAL recovery or setup, which passes:
// PROTOCOL, READONLY_RECOVERY and READONLY_CANTINIT. Every other READONLY code stays the relay's fault.
const TRANSIENT_READ_ONLY = new Set([15, 264, 1288]);
/** Whether a SQLite failure can pass, by its result code; undefined for an error SQLite did not raise. */
const sqliteTransient = (error: unknown, readOnly = false) => {
  const fault = error instanceof Error ? error as {code?: unknown; errcode?: unknown} : undefined;
  if (fault?.code !== "ERR_SQLITE_ERROR") return undefined;
  return typeof fault.errcode === "number" && (TRANSIENT_SQLITE.has(fault.errcode & 255) || (readOnly && TRANSIENT_READ_ONLY.has(fault.errcode)));
};

export type FirstOpenBuild = (policy: OrderedLiveUpdateCutPolicy, input: FirstOpenBaseInput, signal: AbortSignal) =>
  Promise<FirstOpenBaseResult | {kind: "busy"} | {kind: "deadline"}>;
export type FirstOpenPublisher = ReturnType<typeof createFirstOpenPublisher>;

/**
 * The engine's verdict on one candidate, as the writer may use it: the digest
 * of the exact bytes it checked against this request's source, the full state
 * it measured, and whether its host still stands. It never leaves the request.
 */
interface FirstOpenChecked {
  readonly candidateSha256: string;
  readonly sizes: FirstOpenBaseSizes;
  current(): boolean;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * Gives a hosted document with only ordinary history its first live base, or
 * says why not. `activation` answers the configuration the service host's
 * driver runs with, so the base fits what that driver captures and verifies.
 * `host` answers the running service host, whose engine checks each candidate
 * against its file before anything publishes it.
 */
export function createFirstOpenPublisher(options: {
  storage: SyncRelayStorage;
  /** The relay database namespace. */
  namespace: string;
  activation(): ServiceActivationConfig | undefined;
  host(): FirstOpenCheckHost | undefined;
  /** The first-open worker, unless a test injects another. */
  build?: FirstOpenBuild;
  /** The relay's monotonic clock, unless a test injects another. */
  nowMs?: () => number;
  /** How many sources' waits the relay keeps, unless a test keeps fewer. */
  maxDeadlineWaits?: number;
  /** Quiet interval after work for one object, across every source. Zero only isolates other gates in tests. */
  admissionIntervalMs?: number;
}) {
  const {storage, namespace, nowMs = () => performance.now(), maxDeadlineWaits = FIRST_OPEN_DEADLINE_WAITS} = options;
  const build: FirstOpenBuild = options.build ?? ((policy, input, signal) => liveValidation.buildFirstOpenBase(policy, input, signal));
  // A build that passes its deadline would pass it again on the same bytes, holding the one first-open slot every time,
  // so the relay itself makes the same source wait, whatever its clients do. A restart forgets every wait.
  const deadlineWaits = new Map<string, {waitMs: number; untilMs: number}>();
  const admissionIntervalMs = options.admissionIntervalMs ?? 60_000;
  if (!Number.isSafeInteger(admissionIntervalMs) || admissionIntervalMs < 0) throw new Error("Invalid first-open admission interval.");
  const admitted = new Map<string, number>();
  const admit = (workspaceId: string, objectId: string) => {
    if (admissionIntervalMs === 0) return () => {};
    const key = JSON.stringify([workspaceId, objectId]), now = nowMs();
    if ((admitted.get(key) ?? -Infinity) > now) return false;
    if (admitted.size >= 4_096) {
      let oldest: string | undefined, oldestUntil = Infinity;
      for (const [other, until] of admitted) {
        if (until <= now) admitted.delete(other);
        else if (until < oldestUntil) {oldest = other; oldestUntil = until;}
      }
      if (admitted.size >= 4_096 && !admitted.has(key)) {
        if (oldest === undefined) return false;
        admitted.delete(oldest);
      }
    }
    admitted.set(key, Infinity);
    return () => {admitted.set(key, nowMs() + admissionIntervalMs);};
  };
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
    // A check that cancellation or storage interrupted establishes nothing, so it keeps its own error.
    const revalidate = () => {
      signal.throwIfAborted();
      storage.captureStanding();
      let current: string | null;
      try {current = standing();}
      catch (error) {throw error instanceof RelayError ? notFound() : error;}
      if (current !== objectId) throw notFound();
    };
    let outcome: FirstOpenOutcome;
    try {outcome = await publish(objectId);}
    catch (error) {
      revalidate();
      const reason = error instanceof FirstOpenStepFailed ? error.reason : sqliteTransient(error) ? "storage-failed" : undefined;
      if (!reason) throw error;
      console.error("[sync-relay] first-open unavailable", error);
      return answer({kind: "unavailable", reason});
    }
    revalidate();
    return outcome;

  async function publish(objectId: string): Promise<FirstOpenOutcome> {
    const identity = storage.getWorkspaceIdentity(workspaceId);
    if (!identity) throw notFound();
    const named = {workspaceId, objectId, path: request.path, sourceMomentId: request.sourceMomentId, sourceDigest: request.sourceDigest};
    const originId = firstOpenOrigin(namespace, {...named, sourceByteLength: 0}, identity);
    // An exact receipt answers before freshness, conversion, current bounds or the engine, so a lost reply replays.
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
    // A failed history read or build says nothing about the document; a cancelled one stays cancelled, and a SQLite fault that can't pass stays the relay's.
    const step = async <T>(reason: FirstOpenStepFailed["reason"], run: () => Promise<T>) => {
      try {return await run();}
      catch (error) {throw signal.aborted || sqliteTransient(error, reason === "history-unavailable") === false ? error : new FirstOpenStepFailed(reason, error);}
    };
    const replayed = replay();
    if (replayed) return replayed;
    const config = options.activation();
    if (!config) throw notFound();

    // The relay's current ordinary text head, exactly as stored. No await separates it from the first look, so a stale head needs no second one.
    const head = storage.readFirstOpenMoment(workspaceId, objectId);
    if (!head || head.sourceMomentId !== request.sourceMomentId || head.path !== request.path || head.sourceDigest !== request.sourceDigest ||
      head.contentKind !== "text" || head.sourceByteLength === null) return answer({kind: "refused", reason: "stale-source"});
    // A live document holds no more Markdown than this, so nothing longer is built or sent to the engine.
    if (head.sourceByteLength > LIVE_MARKDOWN_MAX_BYTES) return answer({kind: "refused", reason: "too-large", code: "source-limit"});
    const source: FirstOpenSource = Object.freeze({...named, sourceByteLength: head.sourceByteLength});
    // A source whose build passed its deadline waits before it builds again; an edit is a new source. Its bytes passed the
    // checks below before that build, so inside the wait the relay reads only its history, which can still answer first.
    // A blob lost or corrupted inside the wait answers build-deadline, not integrity, until the wait ends.
    const waitKey = JSON.stringify([workspaceId, objectId, source.sourceDigest]);
    const waitLeft = () => (deadlineWaits.get(waitKey)?.untilMs ?? -Infinity) - nowMs();
    let prepared: FirstOpenPreparation | undefined;
    if (waitLeft() > 0) {
      prepared = await step("history-unavailable", () => storage.prepareFirstOpen(source, signal));
      if (prepared.kind !== "prepared") return refusal(prepared);
      // The history read can outlast the wait, and then the source builds now.
      const retryAfterMs = Math.ceil(waitLeft());
      if (retryAfterMs > 0) return answer({kind: "unavailable", reason: "build-deadline", retryAfterMs});
    }
    const releaseAdmission = admit(workspaceId, objectId);
    if (!releaseAdmission) return answer({kind: "unavailable", reason: "busy"});
    try {
      const bytes = storage.getBlob(workspaceId, head.sourceDigest);
      if (!bytes || bytes.byteLength !== head.sourceByteLength || sha256(bytes) !== head.sourceDigest) return answer({kind: "integrity", reason: "source-evidence"});
      let markdown: string;
      try {markdown = new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(bytes);}
      catch {return answer({kind: "refused", reason: "unsupported-source", cause: "not-utf8"});}

      const preparation = prepared ?? await step("history-unavailable", () => storage.prepareFirstOpen(source, signal));
      if (preparation.kind !== "prepared") return refusal(preparation);
      let proof = preparation.proof;
      const built = await step("worker-failed", () => build(config.validation, {document: {workspaceId, mainVersionId: "main", objectId},
        currentPath: source.path, headMomentId: source.sourceMomentId, markdown, sourceDigest: source.sourceDigest,
        sourceByteLength: source.sourceByteLength, bounds: bounds(config, source, identity, originId)}, signal));
      signal.throwIfAborted();
      if (built.kind === "busy") return answer({kind: "unavailable", reason: "busy"});
      if (built.kind === "deadline") {
        const previous = deadlineWaits.get(waitKey);
        const waitMs = previous ? Math.min(2 * previous.waitMs, FIRST_OPEN_DEADLINE_WAIT_CAP_MS) : FIRST_OPEN_DEADLINE_WAIT_MS;
        deadlineWaits.delete(waitKey);
        deadlineWaits.set(waitKey, {waitMs, untilMs: Math.ceil(nowMs()) + waitMs});
        if (deadlineWaits.size > maxDeadlineWaits) deadlineWaits.delete(deadlineWaits.keys().next().value!);
        console.error("[sync-relay] first-open build passed its deadline", workspaceId, objectId, source.sourceDigest);
        return answer({kind: "unavailable", reason: "build-deadline", retryAfterMs: waitMs});
      }
      deadlineWaits.delete(waitKey);
      if (built.kind === "refused") {
        switch (built.reason) {
          case "source-mismatch": return answer({kind: "integrity", reason: "source-evidence"});
          // The file's own content or a fault in the relay's projection or seed can leave the shared schema or read back as other
          // bytes, so both are logged. Any other fault is a malformed or mutated seed, the relay's fault.
          case "invalid-base":
            console.error("[sync-relay] first-open candidate invalid", built.fault, source.sourceDigest);
            if (built.fault === "invalid-schema") return answer({kind: "refused", reason: "unsupported-source", cause: "relay-projection"});
            return answer({kind: "integrity", reason: "candidate"});
          case "unsupported-source":
            console.error("[sync-relay] first-open candidate invalid", built.reason, source.sourceDigest);
            return answer({kind: "refused", reason: "unsupported-source", cause: "relay-projection"});
          default: return answer({kind: "refused", reason: "too-large", code: built.reason});
        }
      }

      // The engine checks this exact candidate outside the writer, encoding no more than every later bound leaves it.
      const room = firstOpenEncodingCap(built.base.byteLength, bounds(config, source, identity, originId));
      if ("exceeded" in room) return answer({kind: "refused", reason: "too-large", code: room.exceeded});
      const host = options.host();
      if (!host) return answer({kind: "unavailable", reason: "host-absent"});
      const asked: FirstOpenCandidateInput = {objectId, path: source.path, sourceMomentId: source.sourceMomentId,
        replicationEpoch: identity.replicationEpoch, streamIdentity: identity.streamIdentity, source: bytes, sourceSha256: source.sourceDigest,
        candidate: built.base, candidateSha256: built.lineageClaimId, maxFullStateBytes: room.cap};
      const native = await host.checkFirstOpenCandidate(workspaceId, asked, signal);
      signal.throwIfAborted();
      if (native.kind === "unavailable") return answer({kind: "unavailable", reason: native.reason});
      if (native.kind === "host-capacity") return answer({kind: "refused", reason: "too-large", code: "host-capacity"});
      if (native.kind === "integrity" || !isDeepStrictEqual(native.check.binding, firstOpenCandidateBinding(asked))) {
        return answer({kind: "integrity", reason: "check-evidence"});
      }
      const {check} = native;
      if (check.status === "refused") return answer({kind: "refused", reason: "unsupported-source", cause: check.cause});
      if (check.status === "too-large") return answer({kind: "refused", reason: "too-large", code: room.bound});
      const checked: FirstOpenChecked = Object.freeze({candidateSha256: built.lineageClaimId, current: native.current,
        sizes: Object.freeze({baseBytes: built.base.byteLength, fullStateBytes: check.fullStateByteLength})});

      // The writer commits only bytes with the checked digest, over the proof's source, which it rechecks.
      const base = {namespace, bytes: built.base, sha256: checked.candidateSha256, recordedAtMs: head.recordedAtMs};
      // The writer's own checks: authorization, standing, the checking host, the policy the base was built under and the bounds that apply now.
      const writerGuard = (context: AppendLogBatchGuardContext) => {
        if (standing(context.enforceWorkspaceIdentity) !== objectId) throw notFound();
        const current = options.activation();
        if (!current) throw notFound();
        if (!checked.current()) throw new FirstOpenCheckLapsed("host-absent");
        if (!isDeepStrictEqual(current.validation, config.validation)) throw new FirstOpenCheckLapsed("reconfigured");
        const exceeded = firstOpenBaseExceeds(checked.sizes, bounds(current, source, identity, originId));
        if (exceeded) throw new FirstOpenBoundExceeded(exceeded);
      };
      for (let attempt = 1; ; attempt++) {
        let written;
        try {written = storage.writeFirstOpen(proof, base, writerGuard);}
        catch (error) {
          if (error instanceof FirstOpenBoundExceeded) return answer({kind: "refused", reason: "too-large", code: error.bound});
          if (error instanceof FirstOpenCheckLapsed) return answer({kind: "unavailable", reason: error.reason});
          throw error;
        }
        if (written.kind === "published") return answer({kind: "published", receipt: written.receipt});
        if (written.kind === "occupied") return answer({kind: "integrity", reason: "reserved-receipt"});
        if (written.kind === "unchecked") return answer({kind: "integrity", reason: "check-evidence"});
        if (written.kind === "refused") return refusal(written);
        if (attempt === FIRST_OPEN_WRITER_ATTEMPTS) return replay() ?? answer({kind: "unavailable", reason: "contention"});
        const caught = await step("history-unavailable", () => storage.catchUpFirstOpen(proof, signal));
        if (caught.kind !== "prepared") return refusal(caught);
        proof = caught.proof;
      }
    } finally {releaseAdmission();}
  }
  };
}
