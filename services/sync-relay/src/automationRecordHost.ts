import {AutomationRunWait} from "@dohc/automation-executor/button-presser";
import type {LiveObjectBinding} from "@dohc/live-session-contract/live-object-binding";
import {accountDisplayName} from "./accountDisplayName";
import {captureOwnerLiveFrameHost, type NamedFrameNativeHost} from "./namedLiveFrameHost";
import type {AutomationServerOptions} from "./automationServer";

interface NativeRecordHost {
  captureNative(binding: LiveObjectBinding, signal: AbortSignal): Promise<NamedFrameNativeHost>;
}

/** Record writes use the deployment's current native host and authenticated owner authority. */
export function createAutomationRecordHost(options: {
  storage: AutomationServerOptions["storage"];
  namespace: string;
  serviceHost(): NativeRecordHost | undefined;
  deviceHost?: NativeRecordHost;
  lookupUserDisplayName: AutomationServerOptions["lookupUserDisplayName"];
  bounds: Parameters<typeof captureOwnerLiveFrameHost>[0]["bounds"];
  validate: Parameters<typeof captureOwnerLiveFrameHost>[0]["validate"];
}): NonNullable<AutomationServerOptions["recordDelivery"]> {
  return {
    namespace: options.namespace,
    async capture({binding, shareId, ownerUserId}, signal) {
      signal.throwIfAborted();
      const mode = options.storage.getLiveHostControl()?.configuredMode;
      const host = mode === "service" ? options.serviceHost() : mode === "device" ? options.deviceHost : undefined;
      const wait = () => new AutomationRunWait(mode === "device" ? "Waiting for the owner's device" : "Waiting for the shared file host");
      if (!host) throw wait();
      let native: NamedFrameNativeHost;
      // A write restarts the document's idle period but is not a live connection.
      // An idle unload that lands first makes the write fail visibly; no data is lost.
      try {native = await host.captureNative(binding, signal);}
      catch (error) {
        signal.throwIfAborted();
        if (error instanceof Error && ["Device delivery is unavailable.", "Service host is unavailable."].includes(error.message)) throw wait();
        throw error;
      }
      return captureOwnerLiveFrameHost({authenticatedUserId: ownerUserId, shareId, storage: options.storage, native,
        trustedAccount: {accountId: ownerUserId, name: await accountDisplayName(options.lookupUserDisplayName, ownerUserId) ?? "Unnamed"},
        bounds: options.bounds, validate: options.validate});
    },
  };
}
