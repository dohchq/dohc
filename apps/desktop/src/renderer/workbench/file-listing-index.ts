import { fileKindForPath } from "@dohc/workspace-contracts/kinds";
import type { WorkspaceFileEntry } from "../../ipc/bridgeContract";
import type { WikilinkFile } from "../editor/wikilinkPlugin";

type FileListingIndex = {
  markdownWikilinkFiles: WikilinkFile[];
  conflictSummaries: string[];
  presentPaths: ReadonlySet<string>;
  hasMarkdownPath: boolean;
  graphRefreshKey: string;
};

export function indexFileListing(
  files: ReadonlyArray<WorkspaceFileEntry>,
): FileListingIndex {
  const markdownWikilinkFiles: WikilinkFile[] = [];
  const conflictSummaries: string[] = [];
  const presentPaths = new Set<string>();
  const graphPaths: string[] = [];
  let hasMarkdownPath = false;

  for (const file of files) {
    presentPaths.add(file.path);
    graphPaths.push(file.path);

    const isMarkdown = fileKindForPath(file.path).displayKind === "markdown";
    if (isMarkdown) {
      hasMarkdownPath = true;
      // The listing knows no titles; a reference falls back to the file name.
      if (file.kind === "file") markdownWikilinkFiles.push({ path: file.path, fileId: null });
    }

    if (
      conflictSummaries.length < 5 &&
      file.kind === "file" &&
      file.path.endsWith(".conflict")
    ) {
      conflictSummaries.push(
        `${file.path.replace(/\.conflict$/, "")} has a sync conflict (${file.path})`,
      );
    }
  }

  return {
    markdownWikilinkFiles,
    conflictSummaries,
    presentPaths,
    hasMarkdownPath,
    graphRefreshKey: `${files.length}\0${graphPaths.join("\0")}`,
  };
}
