import type {
  LiveObjectBinding,
  OwnerYDocOutbox,
  OwnerYDocOutboxEntry,
  OwnerYDocOutboxLimits,
} from "@dohc/workspace-engine-client";
import { OwnerYDocOutboxReadChangedError } from "@dohc/workspace-engine-client";
import type { HostEpoch } from "@dohc/live-session-contract/host-control";
import type { LiveUpdateReceipt } from "@dohc/live-session-contract/live-update-admission";

export interface FreshOwnerAuthority {
  /** Opaque, attempt-scoped authority. The outbox never persists it. */
  readonly value: unknown;
  readonly hostEpoch: HostEpoch;
}

export type OwnerAuthorityResult =
  | { readonly kind: "authority"; readonly authority: FreshOwnerAuthority }
  | { readonly kind: "retry" }
  | {
      readonly kind: "quarantine";
      readonly reason: string;
      readonly observedBinding?: LiveObjectBinding;
    };

export interface OwnerYDocDeliveryEnvelope {
  readonly outboxId: string;
  readonly binding: LiveObjectBinding;
  readonly baseUpdate: Uint8Array;
  readonly baseUpdateDigest: string;
  readonly sequence: number;
  readonly appendKey: string;
  readonly deliveryId: string;
  readonly update: Uint8Array;
  readonly updateDigest: string;
}

export type OwnerYDocDeliveryResult =
  | { readonly kind: "receipt"; readonly receipt: LiveUpdateReceipt }
  | { readonly kind: "retry" }
  | {
      readonly kind: "quarantine";
      readonly reason: string;
      readonly observedBinding?: LiveObjectBinding;
    };

export interface OwnerYDocDelivery {
  /** Rechecks deployment mode and owner standing for this exact attempt. */
  freshOwnerAuthority(
    binding: LiveObjectBinding,
  ): Promise<OwnerAuthorityResult>;
  deliver(
    authority: FreshOwnerAuthority,
    envelope: OwnerYDocDeliveryEnvelope,
  ): Promise<OwnerYDocDeliveryResult>;
}

export type OwnerYDocDrainResult =
  | "acknowledged"
  | "empty"
  | "frozen"
  | "retry";

function assertLimits(limits: OwnerYDocOutboxLimits): void {
  if (
    !Number.isSafeInteger(limits.maxPendingBytes) ||
    limits.maxPendingBytes <= 0 ||
    !Number.isSafeInteger(limits.maxPendingAgeMs) ||
    limits.maxPendingAgeMs <= 0
  ) {
    throw new TypeError("Owner outbox limits must be positive safe integers.");
  }
}

function envelopeFor(
  pending: Awaited<ReturnType<OwnerYDocOutbox["readPending"]>>,
  entry: OwnerYDocOutboxEntry,
): OwnerYDocDeliveryEnvelope {
  return {
    outboxId: pending.outboxId,
    binding: pending.binding,
    baseUpdate: pending.baseUpdate,
    baseUpdateDigest: pending.baseUpdateDigest,
    sequence: entry.sequence,
    appendKey: entry.appendKey,
    deliveryId: entry.deliveryId,
    update: entry.update,
    updateDigest: entry.updateDigest,
  };
}

/**
 * Delivers at most one durable owner update. The caller owns scheduling and
 * retries; restarting this object changes no durable identity.
 */
export class OwnerYDocOutboxDrainer {
  private disposed = false;

  constructor(
    private readonly outbox: OwnerYDocOutbox,
    private readonly outboxId: string,
    private readonly limits: OwnerYDocOutboxLimits,
    private readonly delivery: OwnerYDocDelivery,
    private readonly now: () => number = Date.now,
  ) {
    assertLimits(limits);
  }

  dispose(): void {
    this.disposed = true;
  }

  async drainOnce(): Promise<OwnerYDocDrainResult> {
    if (this.disposed) return "retry";
    let pending: Awaited<ReturnType<OwnerYDocOutbox["readPending"]>>;
    try {
      pending = await this.outbox.readPending(this.outboxId);
    } catch (error) {
      if (error instanceof OwnerYDocOutboxReadChangedError) return "retry";
      throw error;
    }
    if (this.disposed) return "retry";
    if (pending.state !== "active") return "frozen";
    const entry = pending.entries[0];
    if (entry === undefined) return "empty";

    const ageMs = Math.max(0, this.now() - entry.createdAtMs);
    if (
      pending.pendingBytes >= this.limits.maxPendingBytes ||
      ageMs >= this.limits.maxPendingAgeMs
    ) {
      return "frozen";
    }

    const authority = await this.delivery.freshOwnerAuthority(pending.binding);
    if (this.disposed) return "retry";
    if (authority.kind === "retry") return "retry";
    if (authority.kind === "quarantine") {
      await this.outbox.quarantine({
        outboxId: pending.outboxId,
        reason: authority.reason,
        ...(authority.observedBinding === undefined
          ? {}
          : { observedBinding: authority.observedBinding }),
      });
      return "frozen";
    }

    const result = await this.delivery.deliver(
      authority.authority,
      envelopeFor(pending, entry),
    );
    if (this.disposed) return "retry";
    if (result.kind === "retry") return "retry";
    if (result.kind === "quarantine") {
      await this.outbox.quarantine({
        outboxId: pending.outboxId,
        reason: result.reason,
        ...(result.observedBinding === undefined
          ? {}
          : { observedBinding: result.observedBinding }),
      });
      return "frozen";
    }
    await this.outbox.acknowledge(pending.outboxId, [result.receipt]);
    return "acknowledged";
  }
}
