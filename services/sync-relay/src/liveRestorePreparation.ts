import {encodeNativeRestoreInput,DEFAULT_MAX_BLOB_BYTES} from "@dohc/workspace-engine-client/daemon";
import {resolveLiveRestorePoint, type OrderedLiveUpdateCutPolicy} from "@dohc/ydoc-projection/restore-proof";
import {configRecord} from "./deviceLiveHostConfig";
import {authorityInteger} from "./storage/liveDocumentAuthority";
import {deliverStopRestore, snapshotStopRestoreLookup} from "./liveRestoreDelivery";

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

  async prepare(options: Parameters<typeof deliverStopRestore>[0]) {
    const config = this.config, lookup = snapshotStopRestoreLookup(options.lookup), signal = options.signal;
    const check = () => {if (signal?.aborted) throw signal.reason;};
    check();
    if (this.#operations >= config.maxOperations || this.#reservationBytes > config.aggregateBytes - this.#bytes) {
      throw new Error("Restore preparation capacity is full.");
    }
    this.#bytes += this.#reservationBytes; this.#operations++;
    try {
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
    } finally {this.#bytes -= this.#reservationBytes; this.#operations--;}
  }
}
