import { randomUUID, type BinaryLike } from "node:crypto";
import { parseLiveTicketAudience, parseLiveTicketToken, type RedeemedLiveTicket } from "@dohc/live-session-contract/live-ticket";
import { parseLiveUpdateIdentifier } from "@dohc/live-session-contract/live-update-admission";
import type { NamedLiveBrowserContext } from "./namedLiveBrowserAuth.js";
import type { SyncRelayStorage, TicketHostReport } from "./storage.js";
import { ticketRecord, snapshotNamedTicketScope, snapshotTicketHostReport } from "./liveTicketInputs.js";
import { hashLiveTicketToken, mintLiveTicketToken } from "./liveTicketSecurity.js";

export interface NamedLiveTicketOptions {
  readonly storage: Pick<SyncRelayStorage, "mintNamedLiveTicket" | "readNamedLiveTicketTarget" | "redeemNamedLiveTicket">;
  readonly audience: string;
  readonly key: BinaryLike;
  readonly hostReports: {
    currentBinding(scope: NamedLiveBrowserContext, objectId: string, signal?: AbortSignal): Promise<TicketHostReport | null>;
  };
  readonly entropy?: (byteLength: number) => Uint8Array;
  readonly newTicketId?: () => string;
}

export function createNamedLiveTickets(options: NamedLiveTicketOptions) {
  const { storage, entropy, hostReports } = options;
  const audience = parseLiveTicketAudience(options.audience);
  const suppliedKey = options.key;
  const key = typeof suppliedKey === "string" ? suppliedKey :
    Buffer.from(new Uint8Array(suppliedKey.buffer, suppliedKey.byteOffset, suppliedKey.byteLength));
  const newTicketId = options.newTicketId ?? randomUUID;
  const currentBinding = hostReports.currentBinding.bind(hostReports);

  async function readReport(scope: NamedLiveBrowserContext, objectId: string, signal?: AbortSignal): Promise<TicketHostReport | null> {
    signal?.throwIfAborted();
    const candidate = await currentBinding({ ...scope }, objectId, signal);
    signal?.throwIfAborted();
    if (candidate === null) return null;
    try { return snapshotTicketHostReport(candidate); }
    catch { return null; }
  }

  return {
    async mint(input: unknown, context: NamedLiveBrowserContext, signal?: AbortSignal): Promise<{ token: string; expiresAtMs: number } | null> {
      let scope: NamedLiveBrowserContext;
      let objectId: string;
      try {
        scope = snapshotNamedTicketScope(context);
        objectId = parseLiveUpdateIdentifier(ticketRecord(input, ["objectId"]).objectId, "object ID");
      } catch { return null; }
      try {
        const report = await readReport(scope, objectId, signal);
        if (report === null) return null;
        const token = mintLiveTicketToken(entropy);
        const tokenHash = hashLiveTicketToken(token, key);
        const minted = storage.mintNamedLiveTicket({ objectId, scope, report, audience, ticketId: newTicketId(), tokenHash });
        return minted === null ? null : { token, expiresAtMs: minted.expiresAtMs };
      } catch { throw new Error("Live-ticket operation failed."); }
    },
    async redeem(token: unknown, context: NamedLiveBrowserContext, signal?: AbortSignal): Promise<RedeemedLiveTicket | null> {
      let scope: NamedLiveBrowserContext;
      try { parseLiveTicketToken(token); scope = snapshotNamedTicketScope(context); }
      catch { return null; }
      try {
        const tokenHash = hashLiveTicketToken(token as string, key);
        const target = storage.readNamedLiveTicketTarget({ tokenHash, scope, audience });
        if (target === null) return null;
        const report = await readReport(scope, target.objectId, signal);
        return report === null ? null : storage.redeemNamedLiveTicket({ tokenHash, scope, audience, report });
      } catch { throw new Error("Live-ticket operation failed."); }
    },
  };
}
