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

    const isMarkdown = /\.(md|markdown)$/i.test(file.path);
    if (isMarkdown) {
      hasMarkdownPath = true;
      if (file.kind === "file") {
        const pathNoExt = file.path.replace(/\.(md|markdown)$/i, "");
        markdownWikilinkFiles.push({
          path: file.path,
          title: pathNoExt.split("/").pop() ?? file.path,
          fileId: null,
        });
      }
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
