import type { SitePreviewMode } from "../ipc/bridgeContract";
import {
  getSitePackage,
  listSitePackages,
  type SitePackageInfo,
} from "./sitePackage";
import type { OwnedWorkspaceSdkReadPort } from "./ownedWorkspaceSdkReadPort";

export interface OwnedSiteCatalog<Workspace> {
  list(workspace: Workspace): Promise<SitePackageInfo[]>;
  get(
    workspace: Workspace,
    path: string,
    effectiveMode: SitePreviewMode | null | undefined,
  ): Promise<SitePackageInfo | null>;
}

export function createOwnedSiteCatalog<Workspace extends { rootPath: string }>(
  input: {
    reads(
      workspace: Workspace,
    ): Pick<OwnedWorkspaceSdkReadPort, "prepareSearch" | "listFiles">;
  },
): OwnedSiteCatalog<Workspace> {
  const listOwnedPackages = async (workspace: Workspace) => {
    const reads = input.reads(workspace);
    const searchView = await reads.prepareSearch();
    const listed = searchView.listing ?? (await reads.listFiles());
    return listSitePackages(workspace.rootPath, { files: listed.files });
  };

  return {
    list: listOwnedPackages,
    async get(workspace, path, effectiveMode) {
      return getSitePackage(
        workspace.rootPath,
        path,
        await listOwnedPackages(workspace),
        effectiveMode,
      );
    },
  };
}
