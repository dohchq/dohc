import { isSharedWithMePath } from "@dohc/workspace-core";
import type { OwnedWorkspaceFileReader } from "./ownedWorkspaceFileReader";
import type { ShareViewFiles } from "./shareViewFiles";
import { matchesFileListingScope, type WorkspaceFileListingScope } from "./workspaceFileListingScope";
import { readFolderAppSources } from "./folderAppSources";
import { sourceForFile } from "./sitePackage";

export async function readFolderAppWorkspaceSources(rootPath: string, folder: string, input: {
  reader: Pick<OwnedWorkspaceFileReader, "resolveShare" | "readText">;
  listOwned(scope: WorkspaceFileListingScope): Promise<readonly string[]>;
  listShare: ShareViewFiles["list"];
}) {
  const routed = await input.reader.resolveShare(folder);
  const listing = routed ? await input.listShare(routed.target, { includeContentIdentity: false }) : null;
  const prefix = routed?.target.kind === "mount" ? folder.split("/").slice(0, 2).join("/") + "/" : "";
  return readFolderAppSources(folder, {
    list: async scope => listing
      ? listing.files.map(file => prefix + file.path).filter(path => matchesFileListingScope(path, scope))
      : (await input.listOwned(scope)).filter(path => !isSharedWithMePath(path)),
    source: path => sourceForFile(rootPath, path, routed ? async () => {
      const read = await input.reader.readText(path);
      return { size: read.truncated ? Infinity : Buffer.byteLength(read.text, "utf8"), read: async () => read.text };
    } : undefined),
  });
}
