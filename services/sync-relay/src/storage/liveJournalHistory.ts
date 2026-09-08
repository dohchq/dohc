import { parseLiveUpdateIdentifier } from "@dohc/live-session-contract/live-update-admission";
import type { StorageContext } from "./context";

export interface LiveJournalHistoryAuthority {
  readonly namespace: string;
  readonly reconciled: boolean;
  markUnreconciled(): void;
}

const authorities = new WeakMap<
  LiveJournalHistoryAuthority,
  { namespace: string; reconciled: boolean }
>();
const attached = new WeakMap<StorageContext, LiveJournalHistoryAuthority>();

export function liveJournalHistoryNamespace(storage: StorageContext): string {
  const current = attached.get(storage);
  if (!current) throw new Error("Relay history authority is not attached.");
  requireLiveJournalHistory(storage);
  return current.namespace;
}

/** Private provisioning; the caller owns history continuity outside the relay backup. */
export function createLiveJournalHistoryAuthority(input: {
  namespace: string;
  reconciled: boolean;
}): LiveJournalHistoryAuthority {
  const namespace = parseLiveUpdateIdentifier(
    input.namespace,
    "relay history namespace",
  );
  if (typeof input.reconciled !== "boolean")
    throw new TypeError("History reconciliation state is required.");
  const state = { namespace, reconciled: input.reconciled };
  const authority: LiveJournalHistoryAuthority = Object.freeze({
    get namespace() {
      return state.namespace;
    },
    get reconciled() {
      return state.reconciled;
    },
    markUnreconciled() {
      state.reconciled = false;
    },
  });
  authorities.set(authority, state);
  return authority;
}

export function attachLiveJournalHistory(
  storage: StorageContext,
  authority: LiveJournalHistoryAuthority,
): void {
  if (!authorities.has(authority))
    throw new TypeError("Unknown relay history authority.");
  const existing = attached.get(storage);
  if (existing && existing !== authority)
    throw new Error("Relay history authority is already attached.");
  attached.set(storage, authority);
}

export function requireLiveJournalHistory(
  storage: StorageContext,
  authority?: LiveJournalHistoryAuthority,
): void {
  const current = attached.get(storage);
  if (authority && current !== authority)
    throw new Error("Relay history registration was retired.");
  if (current && !authorities.get(current)?.reconciled)
    throw new Error("Relay history requires reconciliation.");
}
