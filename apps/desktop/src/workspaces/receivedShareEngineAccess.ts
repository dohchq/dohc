import type { SyncRelayConnection } from "@dohc/workspace-contracts/relay";
import type {
  EngineWorkspace,
  EngineWorkspaceSessions,
} from "@dohc/workspace-engine-client/daemon";
import type {
  EngineRelayClient,
  EngineRelayWorkspaceClient,
} from "./engineRelayClient";
import { shareViewIsPresent } from "./shareViewMarker";
import type { createCaptureLiveStores } from "./workspaceEngineCaptureLiveStore";

interface ReceivedShareEngineLocation {
  engineWorkspaceId: string;
  rootPath: string;
  attachmentId?: symbol;
}

interface ReceivedShareRelayLocation extends ReceivedShareEngineLocation {
  relay: Pick<SyncRelayConnection, "baseUrl" | "token">;
}

interface RegisteredWorkspaceEngineLocation {
  workspaceId: string;
  rootPath: string;
  attachmentId: symbol;
  shareView?: unknown;
}

interface RegisteredWorkspaceRelayLocation
  extends RegisteredWorkspaceEngineLocation {
  relay: Pick<SyncRelayConnection, "baseUrl" | "token">;
}

type CaptureStores = ReturnType<typeof createCaptureLiveStores>;

export function createReceivedShareEngineAccess(dependencies: {
  sessions(): EngineWorkspaceSessions;
  relayClient(): Pick<EngineRelayClient, "bind">;
  createStores: typeof createCaptureLiveStores;
}): {
  workspaceFor(location: ReceivedShareEngineLocation): EngineWorkspace;
  workspaceForRegistered(
    location: RegisteredWorkspaceEngineLocation,
  ): EngineWorkspace;
  storeFor(location: ReceivedShareEngineLocation): CaptureStores["store"];
  relayFor(location: ReceivedShareRelayLocation): EngineRelayWorkspaceClient;
  relayForRegistered(
    location: RegisteredWorkspaceRelayLocation,
  ): EngineRelayWorkspaceClient;
} {
  const workspaceFor = (
    location: ReceivedShareEngineLocation,
  ): EngineWorkspace => {
    const sessions = dependencies.sessions();
    // This is stronger than carrying `shareMount` on one descriptor. Sessions
    // are keyed by physical attachment when one is present, and otherwise by
    // workspace id. Remembering the mode on that exact key keeps later callers
    // for the same attachment from reopening this received share with generic
    // capture. It also happens before a store or relay can issue workspace.open.
    const workspace = {
      workspaceId: location.engineWorkspaceId,
      rootPath: location.rootPath,
      shareMount: true,
      ...(location.attachmentId ? { attachmentId: location.attachmentId } : {}),
    } as const;
    sessions.rememberShareMount(workspace);
    return workspace;
  };
  const workspaceForRegistered = (
    location: RegisteredWorkspaceEngineLocation,
  ): EngineWorkspace =>
    shareViewIsPresent(location.shareView)
      ? workspaceFor({
          engineWorkspaceId: location.workspaceId,
          rootPath: location.rootPath,
          attachmentId: location.attachmentId,
        })
      : {
          workspaceId: location.workspaceId,
          rootPath: location.rootPath,
          attachmentId: location.attachmentId,
        };
  const bind = (workspace: EngineWorkspace, relay: SyncRelayConnection) =>
    dependencies.relayClient().bind({
      ...workspace,
      relay,
    });
  return {
    workspaceFor,
    workspaceForRegistered,
    storeFor: (location) =>
      dependencies.createStores(
        workspaceFor(location),
        dependencies.sessions(),
      ).store,
    relayFor: (location) => bind(workspaceFor(location), location.relay),
    relayForRegistered: (location) =>
      bind(workspaceForRegistered(location), location.relay),
  };
}
