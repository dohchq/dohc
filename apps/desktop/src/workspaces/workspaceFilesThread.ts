import { parentPort } from "node:worker_threads";
import { listFiles, getWorkspaceListingMetadata, type WorkspaceFileListingEntry } from "./workspaceFiles";
import type { FilesRequest, FilesResult } from "./workspaceFilesWorker";

const port = parentPort;
if (!port) throw new Error("Workspace file reader requires a parent port.");
port.on("message", async ({ id, request }: { id: number; request: FilesRequest }) => {
  try {
    let result: FilesResult;
    if (request.kind === "list") result = await listFiles(request.rootPath, { ...request.scope, includeContentIdentity: true });
    else {
      const files: WorkspaceFileListingEntry[] = [];
      for (const path of request.paths) {
        const metadata = await getWorkspaceListingMetadata(request.rootPath, path);
        files.push({ path, kind: "file", ...(metadata?.icon ? { icon: metadata.icon } : {}) });
      }
      result = { files, folders: [] };
    }
    port.postMessage({ id, result });
  } catch (error) { port.postMessage({ id, error: error instanceof Error ? error.message : String(error) }); }
});
