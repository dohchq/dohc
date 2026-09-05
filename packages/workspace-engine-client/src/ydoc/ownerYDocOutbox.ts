import { createHash } from "node:crypto";
import { parseLiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import type { LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import { parseLiveUpdateReceipt } from "@dohc/live-session-contract/live-update-admission";
import type { LiveUpdateReceipt } from "@dohc/live-session-contract/live-update-admission";
import type { DaemonRequesterClient } from "../live/daemonLiveAdapter";
import { WorkspaceDaemonRequester } from "../live/daemonLiveAdapter";
import type { WorkspaceHandle } from "./generated/WorkspaceHandle";
import type { JsonValue } from "./generated/serde_json/JsonValue";

export { parseLiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
export type { LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";

export const OWNER_YDOC_OUTBOX_METHOD = {
  append: "ydoc.ownerOutbox.append",
  readPending: "ydoc.ownerOutbox.readPending",
  acknowledge: "ydoc.ownerOutbox.acknowledge",
  quarantine: "ydoc.ownerOutbox.quarantine",
} as const;

export interface OwnerYDocOutboxLimits {
  readonly maxPendingBytes: number;
  readonly maxPendingAgeMs: number;
}

export interface OwnerYDocOutboxAppendInput {
  readonly binding: LiveObjectBinding;
  readonly baseUpdate: Uint8Array;
  readonly appendKey: string;
  readonly update: Uint8Array;
  readonly limits: OwnerYDocOutboxLimits;
}

export interface OwnerYDocOutboxAppendResult {
  readonly outboxId: string;
  readonly sequence: number;
  readonly deliveryId: string;
  readonly updateDigest: string;
  readonly pendingBytes: number;
  readonly oldestEntryAtMs: number;
  readonly state: OwnerYDocOutboxState;
}

export type OwnerYDocOutboxState = "active" | "sealed" | "quarantined";

export interface OwnerYDocOutboxEntry {
  readonly sequence: number;
  readonly appendKey: string;
  readonly deliveryId: string;
  readonly updateDigest: string;
  readonly update: Uint8Array;
  readonly byteLength: number;
  readonly createdAtMs: number;
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
}

export class OwnerYDocOutboxReadChangedError extends Error {
  constructor() {
    super("Owner outbox changed during read. Retry from the beginning.");
    this.name = "OwnerYDocOutboxReadChangedError";
  }
}

type ReadPart = "header" | "base" | "entryHeader" | "update";
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
  if (part !== "header" && part !== "base" && part !== "entryHeader" && part !== "update") {
    throw new TypeError("Unknown owner outbox read part.");
  }
  return {
    snapshot: digestField(raw, "snapshot"),
    part,
    sequence: wireInteger(raw, "sequence"),
    offset: wireInteger(raw, "offset"),
  };
}

function headerRecord(bytes: Uint8Array): Record<string, unknown> {
  return record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), "owner outbox header");
}

export interface OwnerYDocOutboxQuarantineInput {
  readonly outboxId: string;
  readonly reason: string;
  readonly observedBinding?: LiveObjectBinding;
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
    const raw = record(
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
      "owner outbox append result",
    );
    return {
      outboxId: stringField(raw, "outboxId"),
      sequence: wireInteger(raw, "sequence", 1),
      deliveryId: stringField(raw, "deliveryId"),
      updateDigest: stringField(raw, "updateDigest"),
      pendingBytes: wireInteger(raw, "pendingBytes"),
      oldestEntryAtMs: wireInteger(raw, "oldestEntryAtMs"),
      state: state(raw.state),
    };
  }

  async readPending(outboxId: string): Promise<OwnerYDocOutboxPending> {
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
    const baseUpdate = await readPart("base", 0, wireInteger(raw, "baseByteLength", 1), baseUpdateDigest);
    const entries: OwnerYDocOutboxEntry[] = [];
    let lastSequence = 0;
    let remaining = pendingBytes;
    for (let index = 0; index < count; index += 1) {
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
      entries.push({
        sequence,
        appendKey: stringField(entry, "appendKey"),
        deliveryId: stringField(entry, "deliveryId"),
        updateDigest, update, byteLength,
        createdAtMs: wireInteger(entry, "createdAtMs"),
      });
      remaining -= byteLength;
      lastSequence = sequence;
    }
    if (remaining !== 0 || next !== null) throw new TypeError("Owner outbox snapshot is incomplete.");
    const observed = raw.observedBinding;
    return {
      outboxId: stringField(raw, "outboxId"),
      binding: parseLiveObjectBinding(raw.binding),
      baseUpdateDigest,
      baseUpdate,
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
      } as unknown as JsonValue,
      { workspace: this.workspace },
    );
  }
}
