import { LinksInInput, LinksResolveInput, LinksInResult, LinksResolveResult } from "@dohc/workspace-contracts/links";
import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import type { RegistryEntry } from "./registryStore";
import type { ShareViewFiles } from "./shareViewFiles";
import { shareViewIsPresent } from "./shareViewMarker";
export function createWorkspaceLinksReader(
  withAdapter: <T>(workspace: RegistryEntry, run: (adapter: VersionedLiveAdapter) => Promise<T>) => Promise<T | null>,
  files: () => ShareViewFiles,
) {
  return {
    async incoming(workspace: RegistryEntry, input: LinksInInput): Promise<LinksInResult> {
      const page = shareViewIsPresent(workspace.shareView)
        ? await files().linksIn({ kind: "standalone", workspaceId: workspace.workspaceId }, input)
        : await withAdapter(workspace, adapter => adapter.incomingLinks(input));
      return page && workspace.shareMounts?.length ? { ...page, mountsCovered: false, complete: false } : page;
    },
    async resolve(workspace: RegistryEntry, input: LinksResolveInput): Promise<LinksResolveResult> {
      const result = shareViewIsPresent(workspace.shareView)
        ? await files().linksResolve({ kind: "standalone", workspaceId: workspace.workspaceId }, input)
        : await withAdapter(workspace, adapter => adapter.resolveLinks(input));
      if (!result) throw new Error("Workspace engine is unavailable.");
      return workspace.shareMounts?.length ? { ...result, mountsCovered: false } : result;
    },
  };
}
