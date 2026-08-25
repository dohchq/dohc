import type { SyncRelayConnection } from "@dohc/workspace-contracts/relay";
import type { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import type {
  EngineRelayClient,
  EngineRelayWorkspaceClient,
} from "./engineRelayClient";
import { createCaptureLiveStores } from "./workspaceEngineCaptureLiveStore";

interface ReceivedShareWorkspace {
  workspaceId: string;
  rootPath: string;
}

interface ReceivedShareRelayWorkspace extends ReceivedShareWorkspace {
  relay: Pick<SyncRelayConnection, "baseUrl" | "token">;
}

type CaptureStores = ReturnType<typeof createCaptureLiveStores>;

export function createReceivedShareEngineAccess(dependencies: {
  sessions(): EngineWorkspaceSessions;
  relayClient(): Pick<EngineRelayClient, "bind">;
  createStores?: typeof createCaptureLiveStores;
}): {
  storeFor(workspace: ReceivedShareWorkspace): CaptureStores["store"];
  relayFor(workspace: ReceivedShareRelayWorkspace): EngineRelayWorkspaceClient;
} {
  const captureDisabledWorkspace = <Workspace extends ReceivedShareWorkspace>(
    workspace: Workspace,
  ) => ({ ...workspace, shareMount: true as const });
  const createStores = dependencies.createStores ?? createCaptureLiveStores;

  return {
    storeFor: (workspace) =>
      createStores(
        captureDisabledWorkspace(workspace),
        dependencies.sessions(),
      ).store,
    relayFor: (workspace) =>
      dependencies.relayClient().bind(captureDisabledWorkspace(workspace)),
  };
}
