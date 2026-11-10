import type { HeldChange, VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import type { RegistryEntry } from "./registryStore";
import { shareViewIsPresent } from "./shareViewMarker";

// A save the engine holds because writing it would rewrite Markdown dohc can't
// show. The person's band and the agent's CLI and MCP read reach the engine
// through this one read. A share view holds no saves of its own.
export function createWorkspaceHeldChanges(
  withAdapter: <T>(workspace: RegistryEntry, run: (adapter: VersionedLiveAdapter) => Promise<T>) => Promise<T | null>,
) {
  async function read<T>(workspace: RegistryEntry, run: (adapter: VersionedLiveAdapter) => Promise<T>): Promise<T> {
    const answer = await withAdapter(workspace, async adapter => ({ value: await run(adapter) }));
    if (!answer) throw new Error("Workspace engine is unavailable.");
    return answer.value;
  }
  return {
    async change(workspace: RegistryEntry, path: string): Promise<HeldChange | null> {
      if (shareViewIsPresent(workspace.shareView)) return null;
      return await read(workspace, adapter => adapter.heldChange(path));
    },
  };
}
export type WorkspaceHeldChanges = ReturnType<typeof createWorkspaceHeldChanges>;
