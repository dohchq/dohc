import { randomUUID } from "node:crypto";
import type {
  LiveObjectBinding,
  OwnerYDocOutbox,
  OwnerYDocOutboxDeliveryHead,
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

/** A terminal refusal delivery received for an outbox head. */
export interface OwnerKnownRefusal {
  readonly deliveryId: string;
  readonly reason: string;
  readonly observedBinding?: LiveObjectBinding;
  /** Sent with every write of this refusal, so writing it again changes nothing. */
  readonly key: string;
}

/**
 * Refusals delivery received but has not yet recorded, per outbox, and the
 * attempt that holds each outbox. The delivery coordinator keeps one across
 * passes and reconnects, so a later pass records a known refusal instead of
 * submitting its head again. A failed write, timer or wake never permits
 * another admission.
 *
 * Crash bound: a crash that loses a refusal before its quarantine commits may
 * cost one fresh admission of the outstanding head on recovery, under its
 * original delivery. Its result completes here; another fresh admission needs
 * another lost outcome. Retryable admission failures may still resend, and a
 * lost result frame adds the same uncertainty.
 */
export class OwnerKnownRefusals {
  readonly #refusals = new Map<string, OwnerKnownRefusal>();
  readonly #held = new Set<string>();

  /** Holds the outbox for one attempt. False while another attempt holds it. */
  hold(outbox: string): boolean {
    if (this.#held.has(outbox)) return false;
    this.#held.add(outbox);
    return true;
  }

  release(outbox: string): void {
    this.#held.delete(outbox);
  }

  get(outbox: string): OwnerKnownRefusal | undefined {
    return this.#refusals.get(outbox);
  }

  receive(outbox: string, refusal: Omit<OwnerKnownRefusal, "key">): OwnerKnownRefusal {
    const known = { ...refusal, key: randomUUID() };
    this.#refusals.set(outbox, known);
    return known;
  }

  /** Forgets a refusal whose quarantine committed, or whose head moved on. */
  recorded(outbox: string, refusal: OwnerKnownRefusal): void {
    if (this.#refusals.get(outbox) === refusal) this.#refusals.delete(outbox);
  }
}

/** Whether a known refusal's quarantine may still need writing at this head. */
export function refusalOutstanding(
  head: Pick<OwnerYDocOutboxDeliveryHead, "state" | "retryDeliveryId" | "entry">,
  refusal: OwnerKnownRefusal,
): boolean {
  return head.entry?.deliveryId === refusal.deliveryId &&
    (head.state !== "quarantined" || head.retryDeliveryId === refusal.deliveryId);
}

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
    /** Outlives this drainer: the coordinator's refusals for this engine. */
    private readonly refusals: OwnerKnownRefusals,
  ) {}

  dispose(): void {
    this.disposed = true;
  }

  async drainOnce(): Promise<OwnerYDocDrainResult> {
    if (this.disposed || !this.refusals.hold(this.outboxId)) return "retry";
    try {
      return await this.drainHeld();
    } finally {
      this.refusals.release(this.outboxId);
    }
  }

  private async drainHeld(): Promise<OwnerYDocDrainResult> {
    let pending: Awaited<ReturnType<OwnerYDocOutbox["readHead"]>>;
    try {
      pending = await this.outbox.readHead(this.outboxId);
    } catch (error) {
      if (error instanceof OwnerYDocOutboxReadChangedError) return "retry";
      throw error;
    }
    if (this.disposed) return "retry";
    const known = this.refusals.get(this.outboxId);
    if (known) {
      // A refusal already received completes; it never reaches admission again.
      if (refusalOutstanding(pending, known)) {
        await this.record(known);
        return "retry";
      }
      this.refusals.recorded(this.outboxId, known);
    }
    const entry = pending.entry;
    // A quarantined queue delivers only the head its owner asked to try again.
    if (pending.state === "quarantined" && (entry === null || entry.deliveryId !== pending.retryDeliveryId)) return "frozen";
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
    if (result.kind === "quarantine") {
      const known = this.refusals.receive(this.outboxId, {
        deliveryId: entry.deliveryId,
        reason: result.reason,
        ...(result.observedBinding === undefined
          ? {}
          : { observedBinding: result.observedBinding }),
      });
      if (this.disposed) return "retry";
      await this.record(known);
      return "frozen";
    }
    if (this.disposed) return "retry";
    if (result.kind === "not-accepted") return "not-accepted";
    if (result.kind === "retry") return "retry";
    await this.outbox.acknowledge(pending.outboxId, [result.receipt]);
    return "acknowledged";
  }

  private async record(known: OwnerKnownRefusal): Promise<void> {
    await this.outbox.quarantine({
      outboxId: this.outboxId,
      reason: known.reason,
      ...(known.observedBinding === undefined
        ? {}
        : { observedBinding: known.observedBinding }),
      refusal: { deliveryId: known.deliveryId, key: known.key },
    });
    this.refusals.recorded(this.outboxId, known);
  }
}
