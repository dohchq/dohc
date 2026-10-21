import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { readLocalStateFrom, type LocalStateWorkspace } from "../workspaces/workspaceLocalState";

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
