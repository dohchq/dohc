import { LinksEdgesInput, LinksEdgesResult, LinksInInput, LinksResolveInput, LinksInResult, LinksResolveResult } from "@dohc/workspace-contracts/links";
import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import type { RegistryEntry } from "./registryStore";
import type { ShareViewFiles } from "./shareViewFiles";
import { resolveOwnedWorkspaceSharePath } from "./ownedWorkspaceFileReader";
import { shareViewIsPresent } from "./shareViewMarker";
export function createWorkspaceLinksReader(
  withAdapter: <T>(workspace: RegistryEntry, run: (adapter: VersionedLiveAdapter) => Promise<T>) => Promise<T | null>,
  files: () => ShareViewFiles,
) {
  return {
    async edges(workspace: RegistryEntry, input: LinksEdgesInput): Promise<LinksEdgesResult> {
      const page = shareViewIsPresent(workspace.shareView)
        ? await files().linksEdges({ kind: "standalone", workspaceId: workspace.workspaceId }, input)
        : await withAdapter(workspace, adapter => adapter.linkEdges(input));
      if (!page) throw new Error("Workspace engine is unavailable.");
      return workspace.shareMounts?.length ? { ...page, mountsCovered: false } : page;
    },
    async incoming(workspace: RegistryEntry, input: LinksInInput): Promise<LinksInResult> {
      const page = shareViewIsPresent(workspace.shareView)
        ? await files().linksIn({ kind: "standalone", workspaceId: workspace.workspaceId }, input)
        : await withAdapter(workspace, async adapter => ({ page: await adapter.incomingLinks(input) }))
          .then(answer => {
            if (!answer) throw new Error("Workspace engine is unavailable.");
            return answer.page;
          });
      return page && workspace.shareMounts?.length ? { ...page, mountsCovered: false } : page;
    },
    async resolve(workspace: RegistryEntry, input: LinksResolveInput): Promise<LinksResolveResult> {
      const share = await resolveOwnedWorkspaceSharePath(workspace, input.source);
      if (share?.target.kind === "mount") {
        const result = await files().linksResolve(share.target, { ...input, source: share.path });
        const shareId = share.target.shareId;
        const mount = workspace.shareMounts?.find(mount => mount.shareId === shareId);
        if (!mount) throw new Error("Shared folder is unavailable.");
        const prefix = `shared-with-me/${mount.label}/`;
        return { ...result, mountsCovered: false, results: result.results.map(row => row === null ? null : row.path === null
          ? { ...row, create: prefix + row.create }
          : { ...row, path: prefix + row.path }) };
      }
      const result = shareViewIsPresent(workspace.shareView)
        ? await files().linksResolve({ kind: "standalone", workspaceId: workspace.workspaceId }, input)
        : await withAdapter(workspace, adapter => adapter.resolveLinks(input));
      if (!result) throw new Error("Workspace engine is unavailable.");
      return workspace.shareMounts?.length ? { ...result, mountsCovered: false } : result;
    },
  };
}
