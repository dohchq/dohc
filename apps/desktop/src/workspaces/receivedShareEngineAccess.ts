import type { SyncRelayConnection } from "@dohc/workspace-contracts/relay";
import type {
  EngineWorkspace,
  EngineWorkspaceSessions,
} from "@dohc/workspace-engine-client/daemon";
import type {
  EngineRelayClient,
  EngineRelayWorkspaceClient,
} from "./engineRelayClient";
import type { createCaptureLiveStores } from "./workspaceEngineCaptureLiveStore";

interface ReceivedShareEngineLocation {
  engineWorkspaceId: string;
  rootPath: string;
}

interface ReceivedShareRelayLocation extends ReceivedShareEngineLocation {
  relay: Pick<SyncRelayConnection, "baseUrl" | "token">;
}

type CaptureStores = ReturnType<typeof createCaptureLiveStores>;

export function createReceivedShareEngineAccess(dependencies: {
  sessions(): EngineWorkspaceSessions;
  relayClient(): Pick<EngineRelayClient, "bind">;
  createStores: typeof createCaptureLiveStores;
}): {
  workspaceFor(location: ReceivedShareEngineLocation): EngineWorkspace;
  storeFor(location: ReceivedShareEngineLocation): CaptureStores["store"];
  relayFor(location: ReceivedShareRelayLocation): EngineRelayWorkspaceClient;
} {
  const workspaceFor = (
    location: ReceivedShareEngineLocation,
  ): EngineWorkspace => ({
    workspaceId: location.engineWorkspaceId,
    rootPath: location.rootPath,
    shareMount: true,
  });
  return {
    workspaceFor,
    storeFor: (location) =>
      dependencies.createStores(
        workspaceFor(location),
        dependencies.sessions(),
      ).store,
    relayFor: (location) =>
      dependencies.relayClient().bind({
        ...workspaceFor(location),
        relay: location.relay,
      }),
  };
}
