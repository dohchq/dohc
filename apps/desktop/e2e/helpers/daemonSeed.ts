import {
  EngineDaemonLifecycle,
  EngineWorkspaceSessions,
} from "@dohc/workspace-engine-client/daemon";
import { resolveEngineBinary } from "../../src/testing/engineBinary";
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
  chats: DesktopLinkedChatStore;
  relay: EngineRelayClient;
  sessions: EngineWorkspaceSessions;
  close(): Promise<void>;
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
  const sessions = new EngineWorkspaceSessions(source);
  const relay = new EngineRelayClient({
    sessions,
    routes,
    allowInsecureLoopbackForTests: true,
  });
  let closed = false;
  return {
    chats: createLiveLinkedChatStore(workspace, sessions),
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
    sessions = new EngineWorkspaceSessions(lifecycle);
    return await seed({
      chats: createLiveLinkedChatStore(workspace, sessions),
      files: createCaptureLiveStores(workspace, sessions).store,
    });
  } finally {
    await sessions?.closeAll();
    await lifecycle.stop();
  }
}
