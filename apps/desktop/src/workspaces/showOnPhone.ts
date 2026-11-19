import { z } from "zod";
import { RelayUnauthorizedError, type SyncRelayConnection } from "@dohc/workspace-contracts/relay";
import { relayRequest } from "./relayRequest";

/** The signed-in account's session on its server, from one credential snapshot. */
export interface ShowOnPhoneSession {
  /** Changes whenever the account's session does. */
  generation: number;
  relay: SyncRelayConnection;
  unauthorized(): Promise<void>;
}

/** The longest a read of the account's workspaces is trusted. */
export const SHOW_ON_PHONE_REFRESH_MS = 3 * 60_000;

// GET /sync/account/workspaces, which the phone reads too.
const AccountWorkspaces = z.object({
  workspaces: z.array(z.object({ workspaceId: z.string(), showOnPhone: z.boolean() })),
});

/** Whether the owner's server confirms a workspace shows on the phone, from one cached read. */
export function createShowOnPhone(options: {
  session(): Promise<ShowOnPhoneSession | null>;
  onError(message: string, error: unknown): void;
  refreshMs?: number;
}): { shows(workspaceId: string): Promise<boolean> } {
  const refreshMs = options.refreshMs ?? SHOW_ON_PHONE_REFRESH_MS;
  let last: { generation: number; at: number; shown: Promise<ReadonlySet<string>> } | undefined;

  async function read(session: ShowOnPhoneSession): Promise<ReadonlySet<string>> {
    try {
      const response = await relayRequest({
        relay: session.relay,
        path: "/sync/account/workspaces",
        label: "Show on phone",
      });
      const { workspaces } = AccountWorkspaces.parse(await response.json());
      return new Set(workspaces.filter((row) => row.showOnPhone).map((row) => row.workspaceId));
    } catch (error) {
      // A failed read confirms nothing until the next one.
      if (error instanceof RelayUnauthorizedError) await session.unauthorized();
      else options.onError("[desktop] reading Show on phone failed:", error);
      return new Set();
    }
  }

  return {
    async shows(workspaceId) {
      const session = await options.session();
      if (!session) return false;
      if (!last || last.generation !== session.generation || Date.now() - last.at >= refreshMs)
        last = { generation: session.generation, at: Date.now(), shown: read(session) };
      return (await last.shown).has(workspaceId);
    },
  };
}
