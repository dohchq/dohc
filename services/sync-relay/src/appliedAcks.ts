import {
  parseLiveUpdateHostApplicationAck,
  type LiveUpdateHostApplicationAck,
} from "@dohc/live-session-contract/live-update-admission";

type Identity = { readonly deliveryId: string; readonly updateDigest: string };

/**
 * The engine's own "applied" answers to applications, so a submission whose row a drain just applied takes its ACK
 * without asking the engine again. One that finds none asks the engine. The oldest answers go past the limit.
 */
export function createAppliedAcks(limit = 1024) {
  const acks = new Map<string, LiveUpdateHostApplicationAck>();
  const key = (identity: Identity) => `${identity.deliveryId}\0${identity.updateDigest}`;
  return {
    /** Keeps the ACK of an engine response whose status is applied. Anything else is left to its caller. */
    record(result: unknown) {
      if (!result || typeof result !== "object") return;
      const { status, ack } = result as { status?: unknown; ack?: unknown };
      if (status !== "applied") return;
      let parsed: LiveUpdateHostApplicationAck;
      try {
        parsed = parseLiveUpdateHostApplicationAck(ack);
      } catch {
        return;
      }
      const k = key(parsed);
      acks.delete(k);
      acks.set(k, parsed);
      if (acks.size > limit) acks.delete(acks.keys().next().value!);
    },
    /** Removes and returns the engine's applied ACK for this delivery, if one is kept. */
    take(identity: Identity): LiveUpdateHostApplicationAck | undefined {
      const k = key(identity),
        ack = acks.get(k);
      acks.delete(k);
      return ack;
    },
  };
}
