import { validateUserWritePath } from "@dohc/workspace-core/paths";
import type { DaemonRequesterClient } from "../live/daemonLiveAdapter";
import { WorkspaceDaemonRequester } from "../live/daemonLiveAdapter";
import type { WorkspaceHandle } from "./generated/WorkspaceHandle";
import type { JsonValue } from "./generated/serde_json/JsonValue";

export const OWNER_YDOC_OUTBOX_METHOD = {
  append: "ydoc.ownerOutbox.append",
  readPending: "ydoc.ownerOutbox.readPending",
  acknowledge: "ydoc.ownerOutbox.acknowledge",
  quarantine: "ydoc.ownerOutbox.quarantine",
} as const;

export interface LiveObjectBinding {
  readonly workspaceId: string;
  readonly mainVersionId: string;
  readonly objectId: string;
  readonly lineageClaimId: string;
  readonly currentPath: string;
  readonly selectorPaths: readonly string[];
  readonly restoreFenceGeneration: number;
}

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

export interface OwnerYDocDeliveryReceipt {
  readonly deliveryId: string;
  readonly updateDigest: string;
  readonly journalCursor: number;
  readonly acceptingHostEpoch: string;
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

function normalizeBinding(binding: LiveObjectBinding): LiveObjectBinding {
  for (const [name, value] of [
    ["workspaceId", binding.workspaceId],
    ["mainVersionId", binding.mainVersionId],
    ["objectId", binding.objectId],
    ["lineageClaimId", binding.lineageClaimId],
  ] as const) {
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError(`${name} must be a non-empty string.`);
    }
  }
  if (
    !Number.isSafeInteger(binding.restoreFenceGeneration) ||
    binding.restoreFenceGeneration < 0
  ) {
    throw new TypeError(
      "restoreFenceGeneration must be a non-negative safe integer.",
    );
  }
  const current = validateUserWritePath(binding.currentPath);
  if (!current.ok) {
    throw new TypeError(`currentPath is invalid (${current.reason}).`);
  }
  const selectorPaths = [...new Set(binding.selectorPaths.map((path) => {
    const candidate = validateUserWritePath(path);
    if (!candidate.ok) {
      throw new TypeError(`selectorPaths contains an invalid path (${candidate.reason}).`);
    }
    return candidate.normalized;
  }))].sort();
  if (selectorPaths.length === 0) {
    throw new TypeError("selectorPaths must contain at least one path.");
  }
  return {
    ...binding,
    currentPath: current.normalized,
    selectorPaths,
  };
}

function decodeBinding(value: unknown): LiveObjectBinding {
  const raw = record(value, "binding");
  const selectorPaths = raw.selectorPaths;
  if (!Array.isArray(selectorPaths) || !selectorPaths.every((path) => typeof path === "string")) {
    throw new TypeError("selectorPaths must be an array of strings.");
  }
  return normalizeBinding({
    workspaceId: stringField(raw, "workspaceId"),
    mainVersionId: stringField(raw, "mainVersionId"),
    objectId: stringField(raw, "objectId"),
    lineageClaimId: stringField(raw, "lineageClaimId"),
    currentPath: stringField(raw, "currentPath"),
    selectorPaths,
    restoreFenceGeneration: wireInteger(raw, "restoreFenceGeneration"),
  });
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
    const binding = normalizeBinding(input.binding);
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
    const raw = record(
      await this.requester.request(
        OWNER_YDOC_OUTBOX_METHOD.readPending,
        { outboxId },
        { workspace: this.workspace },
      ),
      "owner outbox pending result",
    );
    if (!Array.isArray(raw.entries)) {
      throw new TypeError("entries must be an array.");
    }
    const observed = raw.observedBinding;
    return {
      outboxId: stringField(raw, "outboxId"),
      binding: decodeBinding(raw.binding),
      baseUpdateDigest: stringField(raw, "baseUpdateDigest"),
      baseUpdate: base64ToBytes(raw.baseUpdateBase64, "baseUpdateBase64"),
      state: state(raw.state),
      pendingBytes: wireInteger(raw, "pendingBytes"),
      oldestEntryAtMs:
        raw.oldestEntryAtMs === null
          ? null
          : wireInteger(raw, "oldestEntryAtMs"),
      entries: raw.entries.map((value) => {
        const entry = record(value, "owner outbox entry");
        return {
          sequence: wireInteger(entry, "sequence", 1),
          appendKey: stringField(entry, "appendKey"),
          deliveryId: stringField(entry, "deliveryId"),
          updateDigest: stringField(entry, "updateDigest"),
          update: base64ToBytes(entry.updateBase64, "updateBase64"),
          byteLength: wireInteger(entry, "byteLength", 1),
          createdAtMs: wireInteger(entry, "createdAtMs"),
        };
      }),
      quarantineReason: nullableString(raw.quarantineReason, "quarantineReason"),
      observedBinding: observed === null ? null : decodeBinding(observed),
    };
  }

  async acknowledge(
    outboxId: string,
    receipts: readonly OwnerYDocDeliveryReceipt[],
  ): Promise<{ acknowledged: number; pendingBytes: number; oldestEntryAtMs: number | null }> {
    this.assertLive();
    if (receipts.length === 0) throw new TypeError("receipts must not be empty.");
    const raw = record(
      await this.requester.request(
        OWNER_YDOC_OUTBOX_METHOD.acknowledge,
        { outboxId, receipts } as unknown as JsonValue,
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
          : { observedBinding: normalizeBinding(input.observedBinding) }),
      } as unknown as JsonValue,
      { workspace: this.workspace },
    );
  }
}
