import type {
  RelayWorkspaceIdentity,
  SyncRelayConnection,
} from "@dohc/workspace-contracts/relay";
import { z } from "zod";
import { relayRequest } from "./relayRequest";
import { probeRelayWorkspace } from "./relayWorkspaceProbe";

// Under the relay's 30 s cap and under the idle timeouts of common proxies.
export const RELAY_LOG_HOLD_MS = 25_000;

const HeldLogRead = z.object({ ok: z.literal(true), hasMore: z.boolean(), watched: z.boolean().default(false),
  known: z.number().int().nonnegative().optional() });

// `known`: the count of rows the relay took as the reader's own. A relay that
// does not count them leaves it out.
export interface RelayLogChange { hasMore: boolean; watched: boolean; known?: number }

// Waits on the relay until the workspace log holds an op past `since`, and
// resolves whether it does. With `known`, it waits for more than that many. The relay holds the read for at most `holdMs` and
// answers it without serving an op. It answers early when it cannot park the
// read, and a relay that answers early with no change rejects here, so the
// caller backs off instead of asking again at once.
export function createRelayLogWait(input: {
  workspaceId: string;
  relay: SyncRelayConnection;
  holdMs?: number;
  nowMs?: () => number;
}): (since: number, signal: AbortSignal, known?: number) => Promise<RelayLogChange> {
  const holdMs = input.holdMs ?? RELAY_LOG_HOLD_MS;
  const nowMs = input.nowMs ?? (() => Date.now());
  // The relay's current coordinate. A held read names it the way a pull does;
  // the relay refuses a stale one, and the next read asks for it again.
  let identity: RelayWorkspaceIdentity | null | undefined;
  let watched = false;
  const read = async (since: number, abort: AbortSignal, known: number | undefined): Promise<RelayLogChange> => {
    // One deadline bounds the coordinate read and the held read together.
    const signal = AbortSignal.any([abort, AbortSignal.timeout(holdMs + 15_000)]);
    if (identity === undefined) {
      identity = (await probeRelayWorkspace({
        workspaceId: input.workspaceId,
        relay: input.relay,
        signal,
      })).identity;
      signal.throwIfAborted();
    }
    const query = new URLSearchParams({ since: String(since), hold: String(holdMs) });
    if (watched) query.set("watched", "1");
    if (known !== undefined) query.set("known", String(known));
    if (identity !== null) {
      query.set("replicationEpoch", identity.replicationEpoch);
      query.set("streamIdentity", identity.streamIdentity);
    }
    const startedAtMs = nowMs();
    const response = await relayRequest({
      relay: input.relay,
      path: `/sync/${encodeURIComponent(input.workspaceId)}/log?${query.toString()}`,
      init: { signal },
      errors: {
        409: () => {
          identity = undefined;
          return new Error("The relay refused this workspace coordinate for a held read.");
        },
      },
      label: "Held relay log read",
    });
    const result = HeldLogRead.parse(await response.json());
    if (!result.hasMore && result.watched === watched && nowMs() - startedAtMs < holdMs / 2) {
      throw new Error("The relay answered a held read early without a change.");
    }
    watched = result.watched;
    return {hasMore: result.hasMore, watched, ...(result.known === undefined ? {} : {known: result.known})};
  };
  return async (since, signal, known) => {
    try { return await read(since, signal, known); }
    catch (error) { if (!signal.aborted) watched = false; throw error; }
  };
}
