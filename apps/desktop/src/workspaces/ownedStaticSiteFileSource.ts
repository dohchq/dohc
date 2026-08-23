import type { StaticDirectoryFileSource } from "../security/staticDirectoryPreview";
import type { ShareViewFilesTarget } from "./shareViewFiles";

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
