import { z } from "zod";
import { RelayUnauthorizedError, type SyncRelayConnection } from "@dohc/workspace-contracts/relay";
import { relayRequest } from "./relayRequest";
import { RELAY_FETCH_TIMEOUT_MS } from "./sharedChannels";

export interface ShowOnPhoneSession {
  generation: number;
  relay: SyncRelayConnection;
  unauthorized(): Promise<void>;
}

export const SHOW_ON_PHONE_REFRESH_MS = 3 * 60_000;

const AccountWorkspacesResponse = z.object({
  workspaces: z.array(z.object({ workspaceId: z.string(), showOnPhone: z.boolean() })),
});

const LiveNotesResponse = z.object({
  notes: z.array(z.object({ objectId: z.string().min(1) })),
});

export function createShowOnPhone(options: {
  session(): Promise<ShowOnPhoneSession | null>;
  onError(message: string, error: unknown): void;
  refreshMs?: number;
  liveNotesTimeoutMs?: number;
}): {
  shows(workspaceId: string): Promise<boolean | null>;
  liveNotes(workspaceId: string, signal?: AbortSignal): Promise<ReadonlySet<string> | null>;
} {
  const refreshMs = options.refreshMs ?? SHOW_ON_PHONE_REFRESH_MS;
  const liveNotesTimeoutMs = options.liveNotesTimeoutMs ?? RELAY_FETCH_TIMEOUT_MS;
  let last:
    | { generation: number; at: number; shown: Promise<ReadonlySet<string> | null> }
    | undefined;

  async function fail(session: ShowOnPhoneSession, label: string, error: unknown): Promise<null> {
    if (error instanceof RelayUnauthorizedError) await session.unauthorized();
    else options.onError(`[desktop] reading ${label} failed:`, error);
    return null;
  }

  async function read(session: ShowOnPhoneSession): Promise<ReadonlySet<string> | null> {
    try {
      const response = await relayRequest({
        relay: session.relay,
        path: "/sync/account/workspaces",
        label: "Show on phone",
      });
      const { workspaces } = AccountWorkspacesResponse.parse(await response.json());
      return new Set(workspaces.filter((row) => row.showOnPhone).map((row) => row.workspaceId));
    } catch (error) {
      return fail(session, "Show on phone", error);
    }
  }

  return {
    async shows(workspaceId) {
      const session = await options.session();
      if (!session) return false;
      if (!last || last.generation !== session.generation || Date.now() - last.at >= refreshMs)
        last = { generation: session.generation, at: Date.now(), shown: read(session) };
      const current = last;
      const shown = await current.shown;
      if (shown !== null) return shown.has(workspaceId);
      if (last === current) last = undefined;
      return null;
    },
    async liveNotes(workspaceId, signal) {
      const session = await options.session();
      if (!session || signal?.aborted) return null;
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(new TypeError("timeout")), liveNotesTimeoutMs);
      timer.unref?.();
      try {
        const response = await relayRequest({
          relay: session.relay,
          path: `/sync/${encodeURIComponent(workspaceId)}/live-notes`,
          init: { signal: signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal },
          label: "Live notes",
        });
        return new Set(LiveNotesResponse.parse(await response.json()).notes.map((r) => r.objectId));
      } catch (error) {
        return signal?.aborted ? null : fail(session, "live notes", error);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
