import type {
  RelayWorkspaceIdentity,
  SyncRelayConnection,
} from "@dohc/workspace-contracts/relay";
import { z } from "zod";
import { relayRequest } from "./relayRequest";
import { probeRelayWorkspace } from "./relayWorkspaceProbe";

// Under the relay's 30 s cap and under the idle timeouts of common proxies.
export const RELAY_LOG_HOLD_MS = 25_000;

const HeldLogRead = z.object({ ok: z.literal(true), hasMore: z.boolean() });

// Waits on the relay until the workspace log holds an op past `since`, and
// resolves whether it does. The relay holds the read for at most `holdMs` and
// answers it without serving an op. It answers early when it cannot park the
// read, and a relay that answers early with no change rejects here, so the
// caller backs off instead of asking again at once.
export function createRelayLogWait(input: {
  workspaceId: string;
  relay: SyncRelayConnection;
  holdMs?: number;
  nowMs?: () => number;
}): (since: number, signal: AbortSignal) => Promise<boolean> {
  const holdMs = input.holdMs ?? RELAY_LOG_HOLD_MS;
  const nowMs = input.nowMs ?? (() => Date.now());
  // The relay's current coordinate. A held read names it the way a pull does;
  // the relay refuses a stale one, and the next read asks for it again.
  let identity: RelayWorkspaceIdentity | null | undefined;
  return async (since, signal) => {
    if (identity === undefined) {
      identity = (await probeRelayWorkspace({
        workspaceId: input.workspaceId,
        relay: input.relay,
      })).identity;
      signal.throwIfAborted();
    }
    const query = new URLSearchParams({ since: String(since), hold: String(holdMs) });
    if (identity !== null) {
      query.set("replicationEpoch", identity.replicationEpoch);
      query.set("streamIdentity", identity.streamIdentity);
    }
    const startedAtMs = nowMs();
    const response = await relayRequest({
      relay: input.relay,
      path: `/sync/${encodeURIComponent(input.workspaceId)}/log?${query.toString()}`,
      init: { signal: AbortSignal.any([signal, AbortSignal.timeout(holdMs + 15_000)]) },
      errors: {
        409: () => {
          identity = undefined;
          return new Error("The relay refused this workspace coordinate for a held read.");
        },
      },
      label: "Held relay log read",
    });
    const { hasMore } = HeldLogRead.parse(await response.json());
    if (!hasMore && nowMs() - startedAtMs < holdMs / 2) {
      throw new Error("The relay answered a held read early without a change.");
    }
    return hasMore;
  };
}
