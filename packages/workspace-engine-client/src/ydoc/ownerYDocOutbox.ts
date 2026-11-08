import {parseAutomationDeclaration, type AutomationDeclaration} from "@dohc/live-session-contract/live-authorship";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseLiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import type { LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import { parseAgentDeclaration, parseLiveUpdateReceipt } from "@dohc/live-session-contract/live-update-admission";
import type { AgentDeclaration, LiveUpdateReceipt } from "@dohc/live-session-contract/live-update-admission";
import type { DaemonRequesterClient } from "../live/daemonLiveAdapter";
import { WorkspaceDaemonRequester } from "../live/daemonLiveAdapter";
import type { JsonValue, WorkspaceHandle } from "../protocol";
import { decodeOwnerYDocOutboxAppendResult, type OwnerYDocOutboxAppendResult } from "./ydocWireContract";

export type { OwnerYDocOutboxAppendResult } from "./ydocWireContract";

export { parseLiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
export type { LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";

const OWNER_YDOC_OUTBOX_METHOD = {
  append: "ydoc.ownerOutbox.append",
  readPending: "ydoc.ownerOutbox.readPending",
  listRestoreFenced: "ydoc.ownerOutbox.listRestoreFenced",
  acknowledge: "ydoc.ownerOutbox.acknowledge",
  quarantine: "ydoc.ownerOutbox.quarantine",
  retry: "ydoc.ownerOutbox.retry",
} as const;

interface OwnerYDocOutboxLimits {
  readonly maxPendingBytes: number;
  readonly maxPendingAgeMs: number;
}

export interface OwnerYDocOutboxRestoreFenced {
  readonly outboxId: string;
  readonly binding: LiveObjectBinding;
  readonly pendingBytes: number;
}

export interface OwnerYDocOutboxAppendInput {
  readonly binding: LiveObjectBinding;
  readonly baseUpdate: Uint8Array;
  readonly appendKey: string;
  readonly update: Uint8Array;
  readonly limits: OwnerYDocOutboxLimits;
}

type OwnerYDocOutboxState = "active" | "sealed" | "quarantined";

export interface OwnerYDocOutboxEntry {
  readonly sequence: number;
  readonly appendKey: string;
  readonly deliveryId: string;
  readonly updateDigest: string;
  readonly update: Uint8Array;
  readonly byteLength: number;
  readonly createdAtMs: number;
  /** Present when the engine recorded the queued edit as a person's. Never authority. */
  readonly personEdit?: true;
  /** The agent the queued edit declared; absent when it declared none. Never authority. */
  readonly agentDeclaration?: AgentDeclaration;
  readonly automationDeclaration?: AutomationDeclaration;
  /** The local journal update this entry queued, with the author this engine recorded on it. Never authority. */
  readonly nativeSource?: OwnerYDocNativeSource;
}

interface OwnerYDocNativeSource {
  readonly binding: LiveObjectBinding;
  readonly adoptionId: string;
  readonly nativeSequence: number;
  readonly updateDigest: string;
  readonly origin:
    | {
        readonly kind: "nativeUpdate";
        readonly actorOriginId: string | null;
        readonly actorKind: string | null;
        readonly onBehalfOf: string | null;
        readonly chainDepth: number | null;
        readonly recordedAtMs: number;
      }
    | { readonly kind: "adoptionSeed" };
}

/** A refused queue with the accepted state its entries build on, for a recovery copy. */
export interface OwnerYDocOutboxRecovery extends OwnerYDocOutboxPending {
  /** The lineage's accepted checkpoint; null once this computer holds no binding for it. */
  readonly checkpoint: Uint8Array | null;
  /** The digest of `checkpoint`, which a confirmation of this copy names. */
  readonly checkpointDigest: string | null;
}

export interface OwnerYDocOutboxPending {
  readonly outboxId: string;
  readonly binding: LiveObjectBinding;
  readonly baseUpdateDigest: string;
  readonly baseUpdate: Uint8Array;
  readonly state: OwnerYDocOutboxState;
  readonly pendingBytes: number;
  readonly oldestEntryAtMs: number | null;
  readonly entries: readonly OwnerYDocOutboxEntry[];
  readonly quarantineReason: string | null;
  readonly observedBinding: LiveObjectBinding | null;
  /** The quarantined head its owner asked to try once more. */
  readonly retryDeliveryId: string | null;
}

export interface OwnerYDocOutboxHead extends Omit<OwnerYDocOutboxPending, "entries"> {
  readonly entry: OwnerYDocOutboxEntry | null;
}

export type OwnerYDocOutboxDeliveryHead = Omit<OwnerYDocOutboxHead, "baseUpdate"> & {
  /**
   * Whether the queue holds its lineage's refused adoption seed, with no Try
   * again granted, at the restore generation its document still has. No
   * settlement may pass that seed.
   */
  readonly frozenAtRefusedSeed: boolean;
  /** The checkpoint a recovery copy of the queue reads now. */
  readonly checkpointDigest: string | null;
  /**
   * `checkpointDigest` while the queue holds its lineage's refused adoption
   * seed at any restore generation, so a recovery copy must hold it; else null.
   */
  readonly recoveryCheckpointDigest: string | null;
};

export class OwnerYDocOutboxReadChangedError extends Error {
  constructor() {
    super("Owner outbox changed during read. Retry from the beginning.");
    this.name = "OwnerYDocOutboxReadChangedError";
  }
}

type ReadPart = "header" | "base" | "entryHeader" | "update" | "checkpoint";
interface ReadCursor {
  snapshot: string;
  part: ReadPart;
  sequence: number;
  offset: number;
}

function digestField(value: Record<string, unknown>, name: string): string {
  const digest = stringField(value, name);
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new TypeError(`${name} must be a SHA-256 digest.`);
  return digest;
}

function readCursor(value: unknown): ReadCursor {
  const raw = record(value, "owner outbox read cursor");
  const part = raw.part;
  if (part !== "header" && part !== "base" && part !== "entryHeader" && part !== "update" && part !== "checkpoint") {
    throw new TypeError("Unknown owner outbox read part.");
  }
  return {
    snapshot: digestField(raw, "snapshot"),
    part,
    sequence: wireInteger(raw, "sequence"),
    offset: wireInteger(raw, "offset"),
  };
}

const nullableField = <T>(value: Record<string, unknown>, name: string, check: (field: unknown) => field is T): T | null => {
  const field = value[name];
  if (field !== null && !check(field)) throw new TypeError(`${name} is invalid.`);
  return field as T | null;
};
const isText = (field: unknown): field is string => typeof field === "string" && field.length > 0;
const isWireInteger = (field: unknown): field is number => Number.isSafeInteger(field) && (field as number) >= 0;

function nativeSource(value: unknown, updateDigest: string): OwnerYDocNativeSource {
  const raw = record(value, "native source");
  const origin = record(raw.origin, "native source origin");
  if (Object.keys(raw).sort().join() !== "adoptionId,binding,nativeSequence,origin,updateDigest"
    || digestField(raw, "updateDigest") !== updateDigest) throw new TypeError("Invalid native source.");
  const source = {binding: parseLiveObjectBinding(raw.binding), adoptionId: stringField(raw, "adoptionId"),
    nativeSequence: wireInteger(raw, "nativeSequence"), updateDigest};
  if (origin.kind === "adoptionSeed" && Object.keys(origin).length === 1) return {...source, origin: {kind: "adoptionSeed"}};
  if (origin.kind !== "nativeUpdate" || Object.keys(origin).sort().join() !== "actorKind,actorOriginId,chainDepth,kind,onBehalfOf,recordedAtMs") {
    throw new TypeError("Invalid native source origin.");
  }
  return {...source, origin: {kind: "nativeUpdate", actorOriginId: nullableField(origin, "actorOriginId", isText),
    actorKind: nullableField(origin, "actorKind", isText), onBehalfOf: nullableField(origin, "onBehalfOf", isText),
    chainDepth: nullableField(origin, "chainDepth", isWireInteger), recordedAtMs: wireInteger(origin, "recordedAtMs")}};
}

function headerRecord(bytes: Uint8Array): Record<string, unknown> {
  return record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), "owner outbox header");
}

export interface OwnerYDocOutboxQuarantineInput {
  readonly outboxId: string;
  readonly reason: string;
  readonly observedBinding?: LiveObjectBinding;
  /**
   * The terminal refusal of the head this records. The engine records it at
   * most once, and only while it is that head's own attempt.
   */
  readonly refusal?: { readonly deliveryId: string; readonly key: string };
}

export interface OwnerYDocOutboxRetryInput {
  readonly outboxId: string;
  /** The binding generation the owner saw quarantined. */
  readonly binding: LiveObjectBinding;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function stringField(
  value: Record<string, unknown>,
  name: string,
): string {
  const field = value[name];
  if (typeof field !== "string" || field.length === 0) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return field;
}

function wireInteger(
  value: Record<string, unknown>,
  name: string,
  minimum = 0,
): number {
  const field = value[name];
  if (!Number.isSafeInteger(field) || (field as number) < minimum) {
    throw new TypeError(`${name} must be a safe integer no smaller than ${minimum}.`);
  }
  return field as number;
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function base64ToBytes(value: unknown, name: string): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new TypeError(`${name} must be canonical base64.`);
  }
  return new Uint8Array(Buffer.from(value, "base64"));
}

function assertLimits(limits: OwnerYDocOutboxLimits): void {
  for (const [name, value] of [
    ["maxPendingBytes", limits.maxPendingBytes],
    ["maxPendingAgeMs", limits.maxPendingAgeMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive safe integer.`);
    }
  }
}

function state(value: unknown): OwnerYDocOutboxState {
  if (value !== "active" && value !== "sealed" && value !== "quarantined") {
    throw new TypeError("state is not an owner outbox state.");
  }
  return value;
}

function nullableString(value: unknown, name: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new TypeError(`${name} must be a string or null.`);
  return value;
}


export class OwnerYDocOutbox {
  private readonly requester: WorkspaceDaemonRequester;
  private disposed = false;

  constructor(
    client: DaemonRequesterClient,
    readonly workspace: WorkspaceHandle,
  ) {
    this.requester = new WorkspaceDaemonRequester(client);
  }

  dispose(): void {
    this.disposed = true;
  }

  private assertLive(): void {
    if (this.disposed) throw new Error("Owner Y.Doc outbox is disposed.");
  }

  async append(input: OwnerYDocOutboxAppendInput): Promise<OwnerYDocOutboxAppendResult> {
    this.assertLive();
    const binding = parseLiveObjectBinding(input.binding);
    assertLimits(input.limits);
    if (input.baseUpdate.byteLength === 0 || input.update.byteLength === 0) {
      throw new TypeError("baseUpdate and update must be non-empty.");
    }
    if (typeof input.appendKey !== "string" || input.appendKey.length === 0) {
      throw new TypeError("appendKey must be a non-empty string.");
    }
    return decodeOwnerYDocOutboxAppendResult(
      await this.requester.request(
        OWNER_YDOC_OUTBOX_METHOD.append,
        {
          binding,
          baseUpdateBase64: bytesToBase64(input.baseUpdate),
          appendKey: input.appendKey,
          updateBase64: bytesToBase64(input.update),
          limits: input.limits,
        } as unknown as JsonValue,
        { workspace: this.workspace },
      ),
    );
  }

  async listRestoreFenced(input: { readonly after?: string; readonly limit?: number } = {}): Promise<{
    readonly queues: readonly OwnerYDocOutboxRestoreFenced[];
    readonly next: string | null;
  }> {
    this.assertLive();
    const limit = input.limit ?? 64;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw new TypeError("Invalid recovery page size.");
    if (input.after !== undefined) stringField({ after: input.after }, "after");
    const raw = record(await this.requester.request(
      OWNER_YDOC_OUTBOX_METHOD.listRestoreFenced,
      { after: input.after ?? null, limit },
      { workspace: this.workspace },
    ), "owner outbox recovery list");
    if (Object.keys(raw).sort().join() !== "next,queues" || !Array.isArray(raw.queues) || raw.queues.length > limit) {
      throw new TypeError("Invalid owner outbox recovery list.");
    }
    let previous = input.after ?? "";
    const queues = raw.queues.map(value => {
      const row = record(value, "owner outbox recovery descriptor");
      if (Object.keys(row).sort().join() !== "binding,outboxId,pendingBytes") {
        throw new TypeError("Invalid owner outbox recovery descriptor.");
      }
      const outboxId = stringField(row, "outboxId");
      if (outboxId <= previous) throw new TypeError("Owner outbox recovery cursor did not advance.");
      previous = outboxId;
      return { outboxId, binding: parseLiveObjectBinding(row.binding), pendingBytes: wireInteger(row, "pendingBytes", 1) };
    });
    const next = raw.next === null ? null : stringField(raw, "next");
    if (next !== null && (queues.length === 0 || next !== previous)) {
      throw new TypeError("Invalid owner outbox recovery continuation.");
    }
    return { queues, next };
  }

  async readPending(outboxId: string): Promise<OwnerYDocOutboxPending> {
    return this.readSnapshot(outboxId, false);
  }

  /** Reads the whole queue, then the accepted checkpoint it builds on, which may have advanced since. */
  async readRecovery(outboxId: string): Promise<OwnerYDocOutboxRecovery> {
    const {checkpoint, checkpointDigest, ...pending} = await this.readSnapshot(outboxId, false, undefined, true);
    return {...pending, checkpoint: checkpoint ?? null, checkpointDigest: checkpoint === undefined ? null : checkpointDigest};
  }

  /** Reads the complete base and first pending update, with queue-wide admission metadata. */
  async readHead(outboxId: string): Promise<OwnerYDocOutboxHead> {
    const { entries, ...pending } = await this.readSnapshot(outboxId, true);
    return { ...pending, entry: entries[0] ?? null };
  }

  /** Reads one update for an already adopted lineage, without retransferring its immutable base. */
  async readDeliveryHead(outboxId: string, binding: LiveObjectBinding): Promise<OwnerYDocOutboxDeliveryHead> {
    const { entries, ...pending } = await this.readSnapshot(outboxId, true, parseLiveObjectBinding(binding));
    return { ...pending, entry: entries[0] ?? null };
  }

  private readSnapshot(outboxId: string, headOnly: boolean): Promise<OwnerYDocOutboxPending>;
  private readSnapshot(outboxId: string, headOnly: false, deliveryBinding: undefined, withCheckpoint: true): Promise<OwnerYDocOutboxPending & {checkpoint?: Uint8Array; checkpointDigest: string | null}>;
  private readSnapshot(outboxId: string, headOnly: boolean, deliveryBinding: LiveObjectBinding): Promise<Omit<OwnerYDocOutboxPending, "baseUpdate"> & {frozenAtRefusedSeed: boolean; checkpointDigest: string | null; recoveryCheckpointDigest: string | null}>;
  private async readSnapshot(outboxId: string, headOnly: boolean, deliveryBinding?: LiveObjectBinding, withCheckpoint = false): Promise<Omit<OwnerYDocOutboxPending, "baseUpdate"> & {baseUpdate?: Uint8Array; checkpoint?: Uint8Array; checkpointDigest?: string | null; frozenAtRefusedSeed?: boolean; recoveryCheckpointDigest?: string | null}> {
    this.assertLive();
    let next: ReadCursor | null | undefined;
    let snapshot: string | undefined;
    const readPart = async (
      part: ReadPart,
      sequence: number,
      expectedLength?: number,
      expectedDigest?: string,
    ): Promise<Uint8Array> => {
      let offset = 0;
      let total: number | undefined = expectedLength;
      let digest: string | undefined = expectedDigest;
      const chunks: Uint8Array[] = [];
      const hash = createHash("sha256");
      while (true) {
        this.assertLive();
        if (next === null) throw new TypeError("Owner outbox read ended before the complete snapshot.");
        const requested: ReadCursor | undefined = next;
        const page = record(await this.requester.request(
          OWNER_YDOC_OUTBOX_METHOD.readPending,
          { outboxId, ...(requested === undefined ? {} : { cursor: requested }) } as unknown as JsonValue,
          { workspace: this.workspace },
        ), "owner outbox read page");
        this.assertLive();
        if (page.kind === "readChanged") throw new OwnerYDocOutboxReadChangedError();
        if (page.kind !== "page") throw new TypeError("Expected an owner outbox read page.");
        const current = readCursor(page);
        snapshot ??= current.snapshot;
        if (current.snapshot !== snapshot || current.part !== part || current.sequence !== sequence
          || current.offset !== offset || (requested !== undefined && (
            requested.snapshot !== current.snapshot || requested.part !== current.part
            || requested.sequence !== current.sequence || requested.offset !== current.offset
          ))) {
          throw new TypeError("Owner outbox page does not match its cursor.");
        }
        const pageTotal = wireInteger(page, "totalBytes", 1);
        const pageDigest = digestField(page, "digest");
        total ??= pageTotal;
        digest ??= pageDigest;
        if (pageTotal !== total || pageDigest !== digest) {
          // The checkpoint sits outside the snapshot: an acceptance may advance
          // it, and the header that names its digest, between pages.
          if (part === "checkpoint" || part === "header") throw new OwnerYDocOutboxReadChangedError();
          throw new TypeError("Owner outbox part length or digest changed.");
        }
        const bytes = base64ToBytes(page.bytesBase64, "bytesBase64");
        if (bytes.byteLength === 0 || bytes.byteLength > total - offset) {
          throw new TypeError("Owner outbox page must make bounded byte progress.");
        }
        chunks.push(bytes);
        hash.update(bytes);
        offset += bytes.byteLength;
        next = page.nextCursor === null ? null : readCursor(page.nextCursor);
        if (offset === total) {
          if (hash.digest("hex") !== digest) throw new TypeError("Owner outbox part digest does not match its bytes.");
          const assembled = Buffer.concat(chunks, total);
          return new Uint8Array(assembled.buffer, assembled.byteOffset, assembled.byteLength);
        }
        if (next === null || next.snapshot !== snapshot || next.part !== part
          || next.sequence !== sequence || next.offset !== offset) {
          throw new TypeError("Owner outbox page cursor does not advance.");
        }
      }
    };
    const raw = headerRecord(await readPart("header", 0));
    if (stringField(raw, "outboxId") !== outboxId) throw new TypeError("Owner outbox id changed.");
    const pendingBytes = wireInteger(raw, "pendingBytes");
    const count = wireInteger(raw, "pendingEntryCount");
    const nextSequence = wireInteger(raw, "nextSequence", 1);
    if (count >= nextSequence || count > pendingBytes) throw new TypeError("Invalid owner outbox entry count.");
    const baseUpdateDigest = digestField(raw, "baseUpdateDigest");
    const baseByteLength = wireInteger(raw, "baseByteLength", 1);
    const binding = parseLiveObjectBinding(raw.binding);
    const firstEntryCursor = raw.firstEntryCursor === null ? null : readCursor(raw.firstEntryCursor);
    if ((count === 0) !== (firstEntryCursor === null) || (firstEntryCursor !== null && (
      firstEntryCursor.snapshot !== snapshot || firstEntryCursor.part !== "entryHeader"
      || firstEntryCursor.offset !== 0 || firstEntryCursor.sequence < 1 || firstEntryCursor.sequence >= nextSequence
    ))) throw new TypeError("Owner outbox first entry cursor does not match its header.");
    if (deliveryBinding !== undefined && (!isDeepStrictEqual(binding, deliveryBinding)
      || baseUpdateDigest !== deliveryBinding.lineageClaimId)) {
      throw new TypeError("Owner outbox binding changed.");
    }
    const baseCursor = next as ReadCursor | null | undefined;
    if (baseCursor == null || baseCursor.snapshot !== snapshot || baseCursor.part !== "base"
      || baseCursor.sequence !== 0 || baseCursor.offset !== 0) {
      throw new TypeError("Owner outbox base cursor does not match its header.");
    }
    const baseUpdate = deliveryBinding === undefined ? await readPart("base", 0, baseByteLength, baseUpdateDigest) : undefined;
    if (deliveryBinding === undefined && !isDeepStrictEqual(next, firstEntryCursor)) {
      throw new TypeError("Owner outbox first entry cursor changed.");
    }
    next = firstEntryCursor;
    const entries: OwnerYDocOutboxEntry[] = [];
    let lastSequence = 0;
    let remaining = pendingBytes;
    const readCount = headOnly ? Math.min(count, 1) : count;
    for (let index = 0; index < readCount; index += 1) {
      // readPart updates the cursor after each awaited page, including when
      // the next entry skips an already acknowledged sequence.
      const cursor = next as ReadCursor | null | undefined;
      if (cursor == null || cursor.part !== "entryHeader" || cursor.offset !== 0
        || cursor.sequence <= lastSequence || cursor.sequence >= nextSequence) {
        throw new TypeError("Owner outbox entry cursor is not ordered.");
      }
      const entry = headerRecord(await readPart("entryHeader", cursor.sequence));
      const sequence = wireInteger(entry, "sequence", 1);
      if (sequence !== cursor.sequence) throw new TypeError("Owner outbox entry sequence changed.");
      const byteLength = wireInteger(entry, "byteLength", 1);
      if (byteLength > remaining) throw new TypeError("Owner outbox entry exceeds pending bytes.");
      const updateDigest = digestField(entry, "updateDigest");
      const update = await readPart("update", sequence, byteLength, updateDigest);
      if (Object.hasOwn(entry, "agentDeclaration") && Object.hasOwn(entry, "automationDeclaration")) throw new TypeError("Owner draft declares two author kinds.");
      if (Object.hasOwn(entry, "personEdit") && entry.personEdit !== true) throw new TypeError("Invalid owner person marker.");
      entries.push({
        sequence,
        appendKey: stringField(entry, "appendKey"),
        deliveryId: stringField(entry, "deliveryId"),
        updateDigest, update, byteLength,
        createdAtMs: wireInteger(entry, "createdAtMs"),
        ...(entry.personEdit === true ? {personEdit: true as const} : {}),
        ...(Object.hasOwn(entry, "automationDeclaration") ? {automationDeclaration: parseAutomationDeclaration(entry.automationDeclaration)} : {}),
        ...(Object.hasOwn(entry, "agentDeclaration")
          ? { agentDeclaration: parseAgentDeclaration(entry.agentDeclaration) }
          : {}),
        ...(Object.hasOwn(entry, "nativeSource") ? {nativeSource: nativeSource(entry.nativeSource, updateDigest)} : {}),
      });
      remaining -= byteLength;
      lastSequence = sequence;
    }
    if (readCount === count) {
      if (remaining !== 0 || next !== null) throw new TypeError("Owner outbox snapshot is incomplete.");
    } else {
      const cursor = next as ReadCursor | null | undefined;
      if (remaining < count - readCount || cursor == null || cursor.snapshot !== snapshot
        || cursor.part !== "entryHeader" || cursor.offset !== 0
        || cursor.sequence <= lastSequence || cursor.sequence >= nextSequence) {
        throw new TypeError("Owner outbox suffix does not match its header.");
      }
    }
    // Read after the entries, so it covers every entry accepted before them.
    // Only this queue's own binding has one, and its bytes must match the header's digest.
    let checkpoint: Uint8Array | undefined;
    const named = withCheckpoint || deliveryBinding !== undefined;
    const checkpointDigest = !named || raw.checkpointDigest === null ? null : digestField(raw, "checkpointDigest");
    if (withCheckpoint && checkpointDigest !== null) {
      next = {snapshot: snapshot!, part: "checkpoint", sequence: 0, offset: 0};
      checkpoint = await readPart("checkpoint", 0, undefined, checkpointDigest);
    }
    if (deliveryBinding !== undefined && typeof raw.frozenAtRefusedSeed !== "boolean") throw new TypeError("frozenAtRefusedSeed must be a boolean.");
    const recoveryCheckpointDigest = deliveryBinding === undefined || raw.recoveryCheckpointDigest === null ? null
      : digestField(raw, "recoveryCheckpointDigest");
    if (recoveryCheckpointDigest !== null && recoveryCheckpointDigest !== checkpointDigest) {
      throw new TypeError("Owner outbox recovery checkpoint does not match its header.");
    }
    const observed = raw.observedBinding;
    return {
      ...(checkpoint === undefined ? {} : {checkpoint}),
      ...(named ? {checkpointDigest} : {}),
      ...(deliveryBinding === undefined ? {} : {frozenAtRefusedSeed: raw.frozenAtRefusedSeed as boolean, recoveryCheckpointDigest}),
      outboxId: stringField(raw, "outboxId"),
      binding,
      baseUpdateDigest,
      ...(baseUpdate === undefined ? {} : {baseUpdate}),
      state: state(raw.state),
      pendingBytes,
      oldestEntryAtMs:
        raw.oldestEntryAtMs === null
          ? null
          : wireInteger(raw, "oldestEntryAtMs"),
      entries,
      quarantineReason: nullableString(raw.quarantineReason, "quarantineReason"),
      observedBinding:
        observed === null ? null : parseLiveObjectBinding(observed),
      retryDeliveryId: nullableString(raw.retryDeliveryId, "retryDeliveryId"),
    };
  }

  async acknowledge(
    outboxId: string,
    receipts: readonly LiveUpdateReceipt[],
  ): Promise<{ acknowledged: number; pendingBytes: number; oldestEntryAtMs: number | null }> {
    this.assertLive();
    if (receipts.length === 0) throw new TypeError("receipts must not be empty.");
    for (let index = 0; index < receipts.length; index += 1) {
      if (!Object.hasOwn(receipts, index)) {
        throw new TypeError("receipts must be dense.");
      }
    }
    const validatedReceipts = Array.from(receipts, parseLiveUpdateReceipt);
    const raw = record(
      await this.requester.request(
        OWNER_YDOC_OUTBOX_METHOD.acknowledge,
        { outboxId, receipts: validatedReceipts } as unknown as JsonValue,
        { workspace: this.workspace },
      ),
      "owner outbox acknowledge result",
    );
    return {
      acknowledged: wireInteger(raw, "acknowledged", 1),
      pendingBytes: wireInteger(raw, "pendingBytes"),
      oldestEntryAtMs:
        raw.oldestEntryAtMs === null
          ? null
          : wireInteger(raw, "oldestEntryAtMs"),
    };
  }

  async quarantine(input: OwnerYDocOutboxQuarantineInput): Promise<void> {
    this.assertLive();
    await this.requester.request(
      OWNER_YDOC_OUTBOX_METHOD.quarantine,
      {
        outboxId: input.outboxId,
        reason: input.reason,
        ...(input.observedBinding === undefined
          ? {}
          : {
              observedBinding: parseLiveObjectBinding(
                input.observedBinding,
              ),
            }),
        ...(input.refusal === undefined
          ? {}
          : { refusal: { deliveryId: input.refusal.deliveryId, key: input.refusal.key } }),
      } as unknown as JsonValue,
      { workspace: this.workspace },
    );
  }

  /**
   * The owner's Try again: grants the quarantined head one more delivery
   * attempt at this binding generation. Delivery takes it on its next pass.
   */
  async retry(input: OwnerYDocOutboxRetryInput): Promise<{ retryDeliveryId: string }> {
    this.assertLive();
    const raw = record(
      await this.requester.request(
        OWNER_YDOC_OUTBOX_METHOD.retry,
        { outboxId: input.outboxId, binding: parseLiveObjectBinding(input.binding) } as unknown as JsonValue,
        { workspace: this.workspace },
      ),
      "owner outbox retry result",
    );
    return { retryDeliveryId: stringField(raw, "retryDeliveryId") };
  }
}
