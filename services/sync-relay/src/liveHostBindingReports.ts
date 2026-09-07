import type { HostControlSnapshot } from "@dohc/live-session-contract/host-control";
import type { LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import { parseLiveUpdateIdentifier } from "@dohc/live-session-contract/live-update-admission";
import type { NamedLiveBrowserContext } from "./namedLiveBrowserAuth.js";
import type { NamedLiveTicketOptions } from "./liveTickets.js";
import type { LiveHostConnectionCoordinate, SyncRelayStorage, TicketHostReport } from "./storage.js";
import { snapshotHostCoordinate, snapshotNamedTicketScope, snapshotTicketHostReport } from "./liveTicketInputs.js";

export interface HeldLiveHostConnection {
  // The authenticated runtime assigns a fresh server-derived connectionId per incarnation.
  // It must not recycle that ID while an old report can reach a ticket decision.
  readonly coordinate: LiveHostConnectionCoordinate;
  // Runtime aborts permanently before replacement and cancels underlying requests.
  readonly invalidated: AbortSignal;
  requestBinding(scope: NamedLiveBrowserContext, objectId: string): Promise<LiveObjectBinding | null>;
}

export interface LiveHostConnections {
  // Returns the same handle object throughout one authenticated incarnation.
  current(): HeldLiveHostConnection | null;
}

export interface LiveHostBindingReportOptions {
  readonly storage: Pick<SyncRelayStorage, "getLiveHostControl">;
  readonly connections: LiveHostConnections;
}

function eligible(snapshot: HostControlSnapshot | null, connection: LiveHostConnectionCoordinate): boolean {
  return snapshot !== null && snapshot.admissionState === "open" && snapshot.transition === null &&
    snapshot.registeredInstanceId !== null && snapshot.registeredConnectionId !== null &&
    snapshot.configuredMode === connection.mode && snapshot.configuredHostId === connection.hostId &&
    snapshot.hostEpoch === connection.hostEpoch && snapshot.registeredInstanceId === connection.instanceId &&
    snapshot.registeredConnectionId === connection.connectionId;
}

async function requestWhileLive(
  signal: AbortSignal,
  request: () => Promise<LiveObjectBinding | null>,
): Promise<LiveObjectBinding | null> {
  let invalidate!: () => void;
  const closed = new Promise<null>(resolve => { invalidate = () => resolve(null); });
  signal.addEventListener("abort", invalidate, { once: true });
  try {
    if (signal.aborted) return null;
    return await Promise.race([request(), closed]);
  } finally {
    signal.removeEventListener("abort", invalidate);
  }
}

export function createLiveHostBindingReports(options: LiveHostBindingReportOptions): NamedLiveTicketOptions["hostReports"] {
  const current = options.connections.current.bind(options.connections);
  const readControl = options.storage.getLiveHostControl.bind(options.storage);
  return {
    async currentBinding(context, requestedObjectId) {
      let scope: NamedLiveBrowserContext;
      let objectId: string;
      try {
        scope = snapshotNamedTicketScope(context);
        objectId = parseLiveUpdateIdentifier(requestedObjectId, "object ID");
      } catch { return null; }
      try {
        const handle = current();
        if (handle === null) return null;
        const signal = handle.invalidated;
        if (signal.aborted) return null;
        const connection = snapshotHostCoordinate(handle.coordinate);
        const request = handle.requestBinding.bind(handle);
        if (!eligible(readControl(), connection) || signal.aborted || current() !== handle) return null;
        const binding = await requestWhileLive(signal, () => request({ ...scope }, objectId));
        if (signal.aborted || current() !== handle || binding === null) return null;
        let report: TicketHostReport;
        try { report = snapshotTicketHostReport({ connection, binding }); }
        catch { return null; }
        if (report.binding.workspaceId !== scope.workspaceId || report.binding.objectId !== objectId ||
          report.binding.restoreFenceGeneration === 0) return null;
        if (!eligible(readControl(), connection) || signal.aborted || current() !== handle) return null;
        return report;
      } catch { throw new Error("Live host binding report failed."); }
    },
  };
}
