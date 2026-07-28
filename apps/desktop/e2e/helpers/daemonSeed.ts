import { existsSync } from "node:fs";
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
//
// Resolution order mirrors how the binary actually lands on disk:
// 1. DOHC_TEST_ENGINE_BINARY — explicit override, used verbatim.
// 2. apps/desktop/target/debug — what the app under test resolves in e2e
//    (defaultEngineBinaryPath from appPath dist/main -> ../..), and where
//    staged-binary harnesses copy it.
// 3. <repo>/target/debug — where a repo-root `cargo build` places it.
function resolveEngineBinary(): string {
  const override = process.env.DOHC_TEST_ENGINE_BINARY;
  if (override) return override;
  const name = `dohc-workspace-engine${process.platform === "win32" ? ".exe" : ""}`;
  const candidates = [
    join(desktopRoot, "target", "debug", name),
    join(desktopRoot, "..", "..", "target", "debug", name),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "dohc-workspace-engine debug binary not found. Tried:\n" +
      candidates.map((candidate) => `  ${candidate}`).join("\n") +
      "\nBuild it (cargo build -p dohc-workspace-engine) or set DOHC_TEST_ENGINE_BINARY.",
  );
}

export interface DaemonSeedStores {
  chats: DesktopLinkedChatStore;
  files: CaptureVersionedTextStore;
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
