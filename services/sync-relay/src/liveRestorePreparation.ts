import {encodeNativeRestoreInput} from "@dohc/workspace-engine-client/daemon";
import {resolveLiveRestorePoint, type OrderedLiveUpdateCutPolicy} from "@dohc/ydoc-projection/restore-proof";
import {configRecord} from "./deviceLiveHostConfig";
import {authorityInteger} from "./storage/liveDocumentAuthority";
import {deliverStopRestore, snapshotStopRestoreLookup} from "./liveRestoreDelivery";

const policyKeys = ["maxStructVisits", "maxValueNodeVisits", "maxDecodedPayloadByteVisits", "maxStructClientGroupVisits",
  "maxDeleteClientGroupVisits", "maxDeleteIntervalVisits", "maxIndexOperations"] as const;

/** Private operator limits. No public restore permission or shipping default is implied. */
export function parseLiveRestoreConfig(value: unknown) {
  if (value === undefined) return undefined;
  const row = configRecord(value, ["maxBytes", "maxEvents", "aggregateBytes", "workingReserveBytes", "maxOperations", "validation"]);
  const validation = configRecord(row.validation, [...policyKeys]);
  const policy = Object.freeze(Object.fromEntries(policyKeys.map(key => [key, authorityInteger(validation[key], 1)]))) as unknown as OrderedLiveUpdateCutPolicy;
  const maxBytes = authorityInteger(row.maxBytes, 5), maxEvents = authorityInteger(row.maxEvents, 1);
  const aggregateBytes = authorityInteger(row.aggregateBytes, 1), workingReserveBytes = authorityInteger(row.workingReserveBytes, 1);
  const maxOperations = authorityInteger(row.maxOperations, 1);
  // Byte spans cover transport output, storage copies, both history captures and content validation.
  // The operator reserve covers parsed metadata and CRDT working allocations; this is not an RSS cap.
  const reservationBytes = 16 * maxBytes + workingReserveBytes;
  if (maxBytes > 0xffff_ffff || !Number.isSafeInteger(reservationBytes) || reservationBytes > aggregateBytes) {
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
    this.#reservationBytes = 16 * this.config.maxBytes + this.config.workingReserveBytes;
  }

  async prepare(options: Parameters<typeof deliverStopRestore>[0]) {
    const config = this.config, lookup = snapshotStopRestoreLookup(options.lookup);
    const check = () => {if (options.signal?.aborted) throw options.signal.reason;};
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
      check();
      if (saved) return {kind: "prepared" as const, proposalDigest: saved.proposalDigest,
        candidateDigest: saved.candidateDigest, recordedAtMs: saved.recordedAtMs, replayed: true};
      const selected = store.captureStopRestorePoint(input);
      const point = resolveLiveRestorePoint(selected, config.validation);
      const json = JSON.stringify({fence: stopped.receipt, point});
      if (Buffer.byteLength(json) > config.maxBytes - 4) throw new Error("Restore preparation header exceeds its configured bound.");
      const bytes = encodeNativeRestoreInput(Buffer.from(json), config.maxBytes);
      selected.assertCurrent(); check();
      const output = await connection.client.sendLiveRestore({id: connection.nextRequestId(), workspace: connection.workspace,
        deadlineMs: connection.deadlineMs}, "prepare", bytes, config.maxBytes, options.signal);
      check(); selected.assertCurrent();
      const recorded = store.recordStopRestoreProposal(input, output.bytes, config.validation, Date.now());
      check();
      return {kind: "prepared" as const, ...recorded};
    } finally {this.#bytes -= this.#reservationBytes; this.#operations--;}
  }
}
