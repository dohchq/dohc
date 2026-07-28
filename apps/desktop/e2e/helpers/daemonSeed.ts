import { join } from "node:path";
import { EngineDaemonLifecycle } from "../../src/workspaces/engineDaemonLifecycle";
import { EngineWorkspaceSessions } from "../../src/workspaces/engineWorkspaceSessions";
import {
  createLiveLinkedChatStore,
  type DesktopLinkedChatStore,
} from "../../src/workspaces/liveLinkedChatStore";
import {
  createCaptureLiveStores,
  type CaptureVersionedTextStore,
} from "../../src/workspaces/workspaceEngineCaptureLiveStore";
import { desktopRoot } from "./desktopApp";

// Post-cutover the daemon refuses stores created by the retired TS engine,
// so e2e seeding must happen the way the product writes: over RPC to the
// REAL engine daemon (the same debug binary the app under test spawns).
// Seed BEFORE launching the app — the daemon is stopped afterwards so the
// app's own daemon owns the store exclusively.
const engineBinary =
  process.env.DOHC_TEST_ENGINE_BINARY ??
  join(
    desktopRoot,
    "target",
    "debug",
    `dohc-workspace-engine${process.platform === "win32" ? ".exe" : ""}`,
  );

export interface DaemonSeedStores {
  chats: DesktopLinkedChatStore;
  files: CaptureVersionedTextStore;
}

export async function seedThroughDaemon<T>(
  workspace: { workspaceId: string; rootPath: string },
  seed: (stores: DaemonSeedStores) => Promise<T>,
): Promise<T> {
  const lifecycle = new EngineDaemonLifecycle({ command: engineBinary });
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
