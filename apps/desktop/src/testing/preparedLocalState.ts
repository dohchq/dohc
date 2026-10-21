import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AutomationStoreFolder } from "@dohc/automation-executor/automation-run-store";
import { ownedLocalStateDir, readLocalStateFrom, type LocalStateWorkspace } from "../workspaces/workspaceLocalState";

// Stands in for the engine sessions: each workspace's current open, by id and
// root, with what it said about `.dohc/local`.
export function fakeLocalStateOpens() {
  const opens = new Map<string, { localStateReady: boolean }>();
  const key = (workspace: LocalStateWorkspace) => `${workspace.workspaceId}\0${workspace.rootPath}`;
  readLocalStateFrom({ currentBinding: (workspace) => opens.get(key(workspace)) ?? null });
  return {
    /** What an engine open that writes does: make the folder, then answer. */
    async open(workspace: LocalStateWorkspace, localStateReady = true) {
      await mkdir(join(workspace.rootPath, ".dohc", "local"), { recursive: true });
      opens.set(key(workspace), { localStateReady });
    },
    close(workspace: LocalStateWorkspace) {
      opens.delete(key(workspace));
    },
  };
}

/**
 * A workspace's run store folder as an engine open leaves it for a test that
 * is not about the open: a write finds `.dohc/local` made, and a read finds
 * it as the desktop does.
 */
export function preparedAutomationStoreFolder(rootPath: string): AutomationStoreFolder {
  return {
    async forWrite() {
      await mkdir(join(rootPath, ".dohc", "local"), { recursive: true });
      return (await ownedLocalStateDir(rootPath))!;
    },
    forRead: () => ownedLocalStateDir(rootPath),
  };
}
