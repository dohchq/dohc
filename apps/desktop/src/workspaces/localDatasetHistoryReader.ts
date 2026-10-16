import { Worker } from "node:worker_threads";
import { DatasetHostError } from "@dohc/app-backend-runtime/dataset-host";
import type { LocalDatasetHistoryInput, readLocalDatasetHistory } from "./localDatasetHistory";

type Result = ReturnType<typeof readLocalDatasetHistory>;
type Answer = { result: Result; error?: never } | { result?: never; error: { message: string; code?: DatasetHostError["code"] } };

/** One read-only connection per workspace, opened on the first History request. */
export function createLocalDatasetHistoryReader(path: string, workspaceId: string) {
  let worker: Worker | undefined;
  let failure: Error | undefined;
  let closed = false;
  let serial: Promise<unknown> = Promise.resolve();
  let closing: Promise<void> | undefined;

  function send(input: LocalDatasetHistoryInput): Promise<Result> {
    if (closed) return Promise.reject(new Error("This Collection session ended. Reopen the workspace."));
    if (failure) return Promise.reject(failure);
    if (!worker) {
      worker = new Worker(new URL(import.meta.url.endsWith(".ts")
        ? "localDatasetHistoryThread.ts" : "collection-history-worker.js", import.meta.url), { workerData: { path, workspaceId } });
      worker.on("error", error => { failure = error; });
      worker.on("exit", () => { failure ??= new Error("Collection history is unavailable."); });
    }
    const current = worker;
    return new Promise((resolve, reject) => {
      const cleanup = () => { current.off("message", message); current.off("error", failed); current.off("exit", exited); current.unref(); };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const exited = () => failed(failure ?? new Error("Collection history is unavailable."));
      const message = (answer: Answer) => {
        cleanup();
        if (answer.error) reject(answer.error.code ? new DatasetHostError(answer.error.code, answer.error.message) : new Error(answer.error.message));
        else resolve(answer.result);
      };
      current.ref();
      current.once("message", message); current.once("error", failed); current.once("exit", exited);
      try { current.postMessage(input); } catch (error) { cleanup(); reject(error); }
    });
  }
  return {
    read(input: LocalDatasetHistoryInput): Promise<Result> {
      // Capture inputs before a caller can change a queued page's positions.
      const captured = structuredClone(input);
      const result = serial.then(() => send(captured));
      serial = result.catch(() => undefined);
      return result;
    },
    close(): Promise<void> {
      return closing ??= (async () => {
        closed = true;
        await serial;
        if (worker) await worker.terminate();
      })();
    },
  };
}
