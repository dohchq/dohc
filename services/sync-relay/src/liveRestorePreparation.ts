import {encodeNativeRestoreInput,DEFAULT_MAX_BLOB_BYTES} from "@dohc/workspace-engine-client/daemon";
import {resolveLiveRestorePoint, type OrderedLiveUpdateCutPolicy} from "@dohc/ydoc-projection/restore-proof";
import {configRecord} from "./deviceLiveHostConfig";
import {authorityInteger} from "./storage/liveDocumentAuthority";
import {deliverStopRestore, snapshotStopRestoreLookup} from "./liveRestoreDelivery";
import {parseLiveUpdateDigest} from "@dohc/live-session-contract/live-update-admission";
import {snapshotHostCoordinate} from "./liveTicketInputs";

const policyKeys = ["maxStructVisits", "maxValueNodeVisits", "maxDecodedPayloadByteVisits", "maxStructClientGroupVisits",
  "maxDeleteClientGroupVisits", "maxDeleteIntervalVisits", "maxIndexOperations"] as const;
const reservationBytes = (maxBytes: number, workingReserveBytes: number) => 16 * maxBytes + workingReserveBytes;

/** Private operator limits. No public restore permission or shipping default is implied. */
export function parseLiveRestoreConfig(value: unknown) {
  if (value === undefined) return undefined;
  const row = configRecord(value, ["maxBytes", "maxEvents", "aggregateBytes", "workingReserveBytes", "maxOperations", "validation"]);
  const validation = configRecord(row.validation, [...policyKeys]);
  const policy: OrderedLiveUpdateCutPolicy = Object.freeze({
    maxStructVisits: authorityInteger(validation.maxStructVisits, 1),
    maxValueNodeVisits: authorityInteger(validation.maxValueNodeVisits, 1),
    maxDecodedPayloadByteVisits: authorityInteger(validation.maxDecodedPayloadByteVisits, 1),
    maxStructClientGroupVisits: authorityInteger(validation.maxStructClientGroupVisits, 1),
    maxDeleteClientGroupVisits: authorityInteger(validation.maxDeleteClientGroupVisits, 1),
    maxDeleteIntervalVisits: authorityInteger(validation.maxDeleteIntervalVisits, 1),
    maxIndexOperations: authorityInteger(validation.maxIndexOperations, 1),
  });
  const maxBytes = authorityInteger(row.maxBytes, 5), maxEvents = authorityInteger(row.maxEvents, 1);
  const aggregateBytes = authorityInteger(row.aggregateBytes, 1), workingReserveBytes = authorityInteger(row.workingReserveBytes, 1);
  const maxOperations = authorityInteger(row.maxOperations, 1);
  // Byte spans cover transport output, storage copies, both history captures and content validation.
  // The operator reserve covers parsed metadata and CRDT working allocations; this is not an RSS cap.
  const charge = reservationBytes(maxBytes, workingReserveBytes);
  if (maxBytes > DEFAULT_MAX_BLOB_BYTES || !Number.isSafeInteger(charge) || charge > aggregateBytes) {
    throw new TypeError("Restore preparation exceeds its configured aggregate budget.");
  }
  return Object.freeze({maxBytes, maxEvents, aggregateBytes, workingReserveBytes, maxOperations, validation: policy});
}
export type LiveRestoreConfig = NonNullable<ReturnType<typeof parseLiveRestoreConfig>>;

/** Shared by all workspace consumers on one configured host connection. */
export class LiveRestorePreparation {
  #bytes = 0;
  #operations = 0;
  readonly config: LiveRestoreConfig;
  readonly #reservationBytes: number;
  constructor(config: LiveRestoreConfig) {
    this.config = parseLiveRestoreConfig(config)!;
    this.#reservationBytes = reservationBytes(this.config.maxBytes, this.config.workingReserveBytes);
  }

  #reserve(signal: AbortSignal | undefined): () => void {
    const config = this.config;
    if (signal?.aborted) throw signal.reason;
    if (this.#operations >= config.maxOperations || this.#reservationBytes > config.aggregateBytes - this.#bytes) {
      throw new Error("Restore preparation capacity is full.");
    }
    this.#bytes += this.#reservationBytes; this.#operations++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#bytes -= this.#reservationBytes; this.#operations--;
    };
  }

  async #reserved<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
    const release = this.#reserve(signal);
    try {
      return await run();
    } finally {release();}
  }

  async prepare(options: Parameters<typeof deliverStopRestore>[0]) {
    const config = this.config, lookup = snapshotStopRestoreLookup(options.lookup), signal = options.signal;
    const check = () => {if (signal?.aborted) throw signal.reason;};
    return this.#reserved(signal, async () => {
      const stopped = await deliverStopRestore({...options, lookup});
      check();
      if (stopped.kind === "pending") return stopped;
      const {store, connection} = options;
      const input = {...lookup, host: connection.host, maxBytes: config.maxBytes, maxEvents: config.maxEvents};
      const saved = store.readStopRestoreProposal(input, config.validation);
      if (saved) return {kind: "prepared" as const, proposalDigest: saved.proposalDigest,
        candidateDigest: saved.candidateDigest, recordedAtMs: saved.recordedAtMs, replayed: true};
      const selected = store.captureStopRestorePoint(input);
      const point = resolveLiveRestorePoint(selected, config.validation);
      const json = JSON.stringify({fence: stopped.receipt, point});
      const bytes = encodeNativeRestoreInput(Buffer.from(json), config.maxBytes);
      const output = await connection.client.sendLiveRestore({id: connection.nextRequestId(), workspace: connection.workspace,
        deadlineMs: connection.deadlineMs}, "prepare", bytes, config.maxBytes, signal);
      check(); selected.assertCurrent();
      const recorded = store.recordStopRestoreProposal(input, output.bytes, config.validation, Date.now());
      return {kind: "prepared" as const, ...recorded};
    });
  }

  /** Keep the complete review charged until its response closes or expires. */
  async review(options: Parameters<typeof deliverStopRestore>[0]) {
    const config = this.config, signal = options.signal;
    const input = {...snapshotStopRestoreLookup(options.lookup), host: snapshotHostCoordinate(options.connection.host),
      maxBytes: config.maxBytes, maxEvents: config.maxEvents, maxOutputBytes: config.maxBytes};
    const deadlineMs = Math.min(authorityInteger(options.connection.deadlineMs, 1), 2_147_483_647);
    const release = this.#reserve(signal), lifetime = new AbortController();
    const startedAt = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const close = (reason: unknown = new Error("Restore review closed.")) => {
      if (lifetime.signal.aborted) return;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      release();
      lifetime.abort(reason);
    };
    const abort = () => close(signal?.reason);
    signal?.addEventListener("abort", abort, {once: true});
    timer = setTimeout(() => close(new Error("Restore review expired.")), deadlineMs);
    timer.unref();
    try {
      const review = options.store.readStopRestoreReview(input, config.validation);
      if (signal?.aborted) throw signal.reason;
      if (performance.now() - startedAt >= deadlineMs) throw new Error("Restore review expired.");
      return {review, close: () => close(), invalidated: lifetime.signal, maxOutputBytes: config.maxBytes} as const;
    } catch (error) {
      close(error);
      throw error;
    }
  }

  /** The caller must authenticate the owner before using this confirmation boundary. */
  async confirm(options: Parameters<typeof deliverStopRestore>[0], expectedDigest: string) {
    return this.#complete(options, expectedDigest, true);
  }

  /** Continue only the durable proposal selected by the private caller. */
  async complete(options: Parameters<typeof deliverStopRestore>[0], expectedDigest: string) {
    return this.#complete(options, expectedDigest, false);
  }

  async #complete(options: Parameters<typeof deliverStopRestore>[0], expectedDigest: string, requireReview: boolean) {
    const config = this.config, signal = options.signal, store = options.store, deliveryKind = options.deliveryKind;
    const proposalDigest = parseLiveUpdateDigest(expectedDigest);
    const connection = {...options.connection, host: snapshotHostCoordinate(options.connection.host),
      nextRequestId: options.connection.nextRequestId.bind(options.connection)};
    const input = {...snapshotStopRestoreLookup(options.lookup), host: connection.host,
      maxBytes: config.maxBytes, maxEvents: config.maxEvents};
    const check = () => {if (signal?.aborted) throw signal.reason;};
    return this.#reserved(signal, async () => {
      const retained = store.readStopRestoreLifecycle(input);
      let current = retained ?? (requireReview
        ? store.admitReviewedStopRestoreProposal({...input, maxOutputBytes: config.maxBytes}, proposalDigest, config.validation, Date.now(), signal)
        : store.admitStopRestoreProposal(input, proposalDigest, config.validation, Date.now()));
      const verify = () => {
        check();
        if (current.proposalDigest !== proposalDigest || current.preparation.fence.operation.origin.kind !== deliveryKind) {
          throw new Error("Restore continuation does not match the retained proposal.");
        }
      };
      const send = async (operation: "apply" | "settle" | "resume", settlementId?: string) => {
        verify();
        const header = {...current.preparation, candidateDigest: current.candidateDigest,
          nativeSourceManifestDigest: current.nativeSourceManifestDigest, admitted: current.admitted,
          ...(settlementId === undefined ? {} : {settlementId})};
        const bytes = encodeNativeRestoreInput(Buffer.from(JSON.stringify(header)), config.maxBytes);
        const output = await connection.client.sendLiveRestore({id: connection.nextRequestId(), workspace: connection.workspace,
          deadlineMs: connection.deadlineMs}, operation, bytes, config.maxBytes, signal);
        check();
        return JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(output.bytes)) as unknown;
      };
      verify();
      if (current.phase === "relay-admitted") {
        current = store.acknowledgeStopRestoreReplacement(input, await send("apply"));
      }
      if (current.phase === "native-applied") {
        current = store.acknowledgeStopRestoreSettlement(input, await send("settle"));
        if (current.phase === "native-applied") {
          return {kind: "pending" as const, reason: "Restore materialization is pending.", proposalDigest};
        }
      }
      if (current.phase === "settled") {
        if (!current.settlement?.materialized) throw new Error("Restore settlement is not materialized.");
        current = store.acknowledgeStopRestoreResume(input, await send("resume", current.settlement.settlementId));
      }
      verify();
      if (current.phase !== "resumed" || !current.resume) throw new Error("Restore continuation did not resume.");
      return {kind: "resumed" as const, proposalDigest, receipt: current.resume};
    });
  }
}
