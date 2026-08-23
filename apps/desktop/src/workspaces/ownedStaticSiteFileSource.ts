import type { StaticDirectoryFileSource } from "../security/staticDirectoryPreview";
import type { ShareViewFilesTarget } from "./shareViewFiles";
import {
  staticPreviewOwnerFiles,
  staticPreviewTargetForSite,
  type SitePackageInfo,
} from "./sitePackage";

/** Bind a shared static preview to one canonical owner for its whole life. */
export function createOwnedStaticSiteFileSource(input: {
  servedPaths: Iterable<string>;
  target: ShareViewFilesTarget;
  ownerRootPath: string;
  read(
    target: ShareViewFilesTarget,
    path: string,
  ): Promise<Uint8Array>;
}): StaticDirectoryFileSource {
  const ownerPaths = new Map(
    [...input.servedPaths].map((servedPath) => [
      servedPath,
      input.ownerRootPath === "" || input.ownerRootPath === "."
        ? servedPath
        : `${input.ownerRootPath}/${servedPath}`,
    ]),
  );
  return {
    contains: (path) => ownerPaths.has(path),
    read: async (path) => {
      const ownerPath = ownerPaths.get(path);
      if (!ownerPath) throw new Error("Shared site file is unavailable.");
      return input.read(input.target, ownerPath);
    },
  };
}

export interface PreparedStaticSitePreview {
  root: string;
  entry?: string;
  fileSource?: StaticDirectoryFileSource;
}

/** Select a static artifact and bind every shared read to its one owner. */
export async function prepareOwnedStaticSitePreview(input: {
  site: SitePackageInfo;
  sharedView: boolean;
  resolveOwner(
    path: string,
  ): Promise<{ target: ShareViewFilesTarget; path: string } | null>;
  readOwner(target: ShareViewFilesTarget, path: string): Promise<Uint8Array>;
}): Promise<PreparedStaticSitePreview> {
  const target = staticPreviewTargetForSite(input.site, {
    sharedView: input.sharedView,
  });
  const entry = target.entry ?? undefined;
  const shared =
    input.sharedView || input.site.authority.kind === "share";
  if (!shared) return { root: target.root, ...(entry ? { entry } : {}) };

  if (!entry) {
    throw new Error(
      "This shared site does not include a built artifact. Ask the owner to build and share it again.",
    );
  }
  const ownerFiles = staticPreviewOwnerFiles(input.site, target);
  if (!ownerFiles.has(entry)) {
    throw new Error(
      "This shared site is missing its entry file. Ask the owner to share it again.",
    );
  }
  const ownerRoot = await input.resolveOwner(target.root);
  if (ownerRoot === null) {
    throw new Error(
      "This shared site changed before the preview started. Refresh the workspace.",
    );
  }
  return {
    root: target.root,
    entry,
    fileSource: createOwnedStaticSiteFileSource({
      servedPaths: ownerFiles,
      target: ownerRoot.target,
      ownerRootPath: ownerRoot.path,
      read: input.readOwner,
    }),
  };
}
