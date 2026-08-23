import type {
  ListWorkspaceFilesResult,
  SitePreviewMode,
} from "../ipc/bridgeContract";
import {
  getSitePackage,
  listSitePackages,
  type SitePackageInfo,
} from "./sitePackage";

export interface OwnedSiteCatalog<Workspace> {
  list(workspace: Workspace): Promise<SitePackageInfo[]>;
  get(
    workspace: Workspace,
    path: string,
    effectiveMode: SitePreviewMode | null | undefined,
  ): Promise<SitePackageInfo | null>;
}

type OwnedSiteFileListing = Omit<ListWorkspaceFilesResult, "folders"> & {
  folders?: readonly string[];
};

export function createOwnedSiteCatalog<Workspace extends { rootPath: string }>(
  input: {
    listOwnedFiles(workspace: Workspace): Promise<OwnedSiteFileListing>;
  },
): OwnedSiteCatalog<Workspace> {
  const listOwnedPackages = async (workspace: Workspace) => {
    const listed = await input.listOwnedFiles(workspace);
    return listSitePackages(workspace.rootPath, {
      ...listed,
      folders: listed.folders ? [...listed.folders] : undefined,
    });
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
