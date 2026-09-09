import { isDeepStrictEqual } from "node:util";
import type { LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import type { NamedFrameNativeHost } from "./namedLiveFrameHost.js";
import type { NamedLiveTicketOptions } from "./liveTickets.js";
import type { SyncRelayStorage } from "./storage.js";

export function createNamedLiveHostReports(options: {
  storage: SyncRelayStorage;
  captureNative(binding: LiveObjectBinding, signal: AbortSignal): Promise<NamedFrameNativeHost>;
}): NamedLiveTicketOptions["hostReports"] {
  return {
    async currentBinding(scope, objectId, signal) {
      const check = options.storage.captureStanding();
      const current = options.storage.resolveNamedLiveObjectBinding(scope, objectId);
      if (current.kind !== "current") return null;
      const native = await options.captureNative(current.binding, signal ?? options.storage.unavailable);
      check();
      const next = options.storage.resolveNamedLiveObjectBinding(scope, objectId);
      if (native.invalidated.aborted || !isDeepStrictEqual(current, next) || !isDeepStrictEqual(current.host, native.coordinate)) return null;
      for (const field of ["workspaceId", "mainVersionId", "objectId", "lineageClaimId", "currentPath", "restoreFenceGeneration"] as const) {
        if (current.binding[field] !== native.binding[field]) return null;
      }
      return { binding: current.binding, connection: native.coordinate };
    },
  };
}
