import {
  EngineDaemonLifecycle,
  type AttachedEngineWorkspace,
  type EngineWorkspaceSessions,
} from "@dohc/workspace-engine-client/daemon";
import { resolveEngineBinary } from "../../src/testing/engineBinary";
import { createRealDaemonWorkspaceSessions } from "../../src/testing/realDaemonWorkspaceSessions";
import {
  EngineRelayClient,
  RelayConfiguredDaemonClientSource,
  RelayTransportRouteGuard,
} from "../../src/workspaces/engineRelayClient";
import {
  createLiveLinkedChatStore,
  type DesktopLinkedChatStore,
} from "../../src/workspaces/liveLinkedChatStore";
import {
  createCaptureLiveStores,
  type CaptureVersionedTextStore,
} from "../../src/workspaces/workspaceEngineCaptureLiveStore";

// Post-cutover the daemon refuses stores created by the retired TS engine,
// so e2e seeding must happen the way the product writes: over RPC to the
// REAL engine daemon (the same debug binary the app under test spawns).
// Seed BEFORE launching the app — the daemon is stopped afterwards so the
// app's own daemon owns the store exclusively.
//
// Binary discovery lives in src/testing/engineBinary so the src/** daemon
// suites and these e2e helpers agree on where the daemon is.

export interface DaemonSeedStores {
  chats: DesktopLinkedChatStore;
  files: CaptureVersionedTextStore;
}

export interface LiveDaemonWorkspace {
  workspace: AttachedEngineWorkspace;
  chats: DesktopLinkedChatStore;
  relay: EngineRelayClient;
  sessions: EngineWorkspaceSessions;
  close(): Promise<void>;
}

function attachWorkspace(workspace: {
  workspaceId: string;
  rootPath: string;
}): AttachedEngineWorkspace {
  return {
    ...workspace,
    attachmentId: Symbol(
      `test-workspace-attachment:${workspace.workspaceId}`,
    ),
  };
}

export async function openLiveDaemonWorkspace(
  workspace: { workspaceId: string; rootPath: string },
  options: { maxRestarts?: number } = {},
): Promise<LiveDaemonWorkspace> {
  const lifecycle = new EngineDaemonLifecycle({
    command: resolveEngineBinary(),
    ...(options.maxRestarts !== undefined ? { maxRestarts: options.maxRestarts } : {}),
  });
  await lifecycle.start();
  const routes = new RelayTransportRouteGuard();
  const source = new RelayConfiguredDaemonClientSource(lifecycle, routes);
  const sessions = createRealDaemonWorkspaceSessions(source);
  const attachedWorkspace = attachWorkspace(workspace);
  const relay = new EngineRelayClient({
    sessions,
    routes,
    allowInsecureLoopbackForTests: true,
  });
  let closed = false;
  return {
    workspace: attachedWorkspace,
    chats: createLiveLinkedChatStore(attachedWorkspace, sessions),
    relay,
    sessions,
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await relay.closeAll();
        await sessions.closeAll();
      } finally {
        await lifecycle.stop();
      }
    },
  };
}

export async function seedThroughDaemon<T>(
  workspace: { workspaceId: string; rootPath: string },
  seed: (stores: DaemonSeedStores) => Promise<T>,
): Promise<T> {
  const lifecycle = new EngineDaemonLifecycle({ command: resolveEngineBinary() });
  let sessions: EngineWorkspaceSessions | null = null;
  try {
    await lifecycle.start();
    sessions = createRealDaemonWorkspaceSessions(lifecycle);
    const attachedWorkspace = attachWorkspace(workspace);
    return await seed({
      chats: createLiveLinkedChatStore(attachedWorkspace, sessions),
      files: createCaptureLiveStores(attachedWorkspace, sessions).store,
    });
  } finally {
    await sessions?.closeAll();
    await lifecycle.stop();
  }
}
