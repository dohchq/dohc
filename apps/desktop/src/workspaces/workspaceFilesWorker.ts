import { Worker } from "node:worker_threads";
import type { WorkspaceFileListingScope } from "./workspaceFileListingScope";
import type { WorkspaceFileListingEntry } from "./workspaceFiles";

export type FilesRequest =
  | { kind: "list"; rootPath: string; scope?: WorkspaceFileListingScope }
  | { kind: "metadata"; rootPath: string; paths: readonly string[] };
export type FilesResult = { files: WorkspaceFileListingEntry[]; folders: string[] };

export function createWorkspaceFilesWorker() {
  let worker: Worker | undefined;
  let serial = Promise.resolve();
  let nextId = 0;
  let disposed = false;
  function send(request: FilesRequest): Promise<FilesResult> {
    if (disposed) return Promise.reject(new Error("Workspace file reader is closed."));
    worker ??= new Worker(new URL(import.meta.url.endsWith(".ts")
      ? "workspaceFilesThread.ts" : "workspace-files-worker.js", import.meta.url));
    const current = worker;
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const cleanup = () => { current.off("message", message); current.off("error", failed); current.off("exit", exited); current.unref(); };
      const failed = (error: Error) => {
        cleanup();
        if (worker === current) worker = undefined;
        void current.terminate();
        reject(error);
      };
      const exited = (code: number) => failed(new Error(`Workspace file reader exited (${code}).`));
      const message = (answer: { id: number; result?: FilesResult; error?: string }) => {
        if (answer.id !== id) return;
        cleanup();
        if (answer.result) resolve(answer.result);
        else reject(new Error(answer.error ?? "Workspace file read failed."));
      };
      current.ref();
      current.on("message", message); current.on("error", failed); current.on("exit", exited);
      current.postMessage({ id, request });
    });
  }
  function run(request: FilesRequest): Promise<FilesResult> {
    const result = serial.then(() => send(request));
    serial = result.then(() => undefined, () => undefined);
    return result;
  }
  return {
    list: (rootPath: string, scope?: WorkspaceFileListingScope) => run({ kind: "list", rootPath, scope }),
    metadata: (rootPath: string, paths: readonly string[]) => run({ kind: "metadata", rootPath, paths }),
    async dispose() {
      disposed = true;
      await serial;
      const current = worker; worker = undefined;
      if (current) await current.terminate();
    },
  };
}
