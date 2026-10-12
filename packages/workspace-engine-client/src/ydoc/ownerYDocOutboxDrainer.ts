import type {
  LiveObjectBinding,
  OwnerYDocOutbox,
  OwnerYDocOutboxEntry,
} from "./ownerYDocOutbox";
import { OwnerYDocOutboxReadChangedError } from "./ownerYDocOutbox";
import type { AutomationDeclaration } from "@dohc/live-session-contract/live-authorship";
import type { HostEpoch } from "@dohc/live-session-contract/host-control";
import type { AgentDeclaration, LiveUpdateReceipt } from "@dohc/live-session-contract/live-update-admission";

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
  /** Present when the engine recorded the queued edit as a person's. */
  readonly personEdit?: true;
  /** The agent the queued edit declared; absent when it declared none. */
  readonly agentDeclaration?: AgentDeclaration;
  readonly automationDeclaration?: AutomationDeclaration;
}

export type OwnerYDocDeliveryResult =
  | { readonly kind: "receipt"; readonly receipt: LiveUpdateReceipt }
  /** Delivery durably refused the entry. It must never acknowledge it as accepted. */
  | { readonly kind: "not-accepted" }
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
  | "not-accepted"
  | "retry";

function envelopeFor(
  pending: Awaited<ReturnType<OwnerYDocOutbox["readHead"]>>,
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
    ...(entry.personEdit ? {personEdit: entry.personEdit} : {}),
    ...(entry.agentDeclaration ? { agentDeclaration: entry.agentDeclaration } : {}),
    ...(entry.automationDeclaration ? { automationDeclaration: entry.automationDeclaration } : {}),
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
    private readonly delivery: OwnerYDocDelivery,
  ) {}

  dispose(): void {
    this.disposed = true;
  }

  async drainOnce(): Promise<OwnerYDocDrainResult> {
    if (this.disposed) return "retry";
    let pending: Awaited<ReturnType<OwnerYDocOutbox["readHead"]>>;
    try {
      pending = await this.outbox.readHead(this.outboxId);
    } catch (error) {
      if (error instanceof OwnerYDocOutboxReadChangedError) return "retry";
      throw error;
    }
    if (this.disposed) return "retry";
    if (pending.state === "quarantined") return "frozen";
    const entry = pending.entry;
    if (entry === null) return "empty";

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
    if (result.kind === "not-accepted") return "not-accepted";
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
