import { Worker } from "node:worker_threads";
import {
  isWorkspaceDatabaseWorkerResponse,
  type WorkspaceDatabaseWorkerRequest,
  type WorkspaceDatabaseWorkerResponse,
  type WorkspaceDatabaseWorkerResult,
} from "./workspaceDatabaseProtocol.ts";
import type {
  DatabaseEdit,
  DatabaseEditResult,
  DatabaseOperationInput,
  DatabasePageView,
  DatabaseSnapshotView,
} from "./workspaceDatabaseTypes.ts";

interface WorkerAdapter {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: unknown) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  unref(): void;
  terminate(): Promise<number>;
}

export interface WorkspaceDatabaseWorkerOwner {
  readPath(input: {
    absolutePath: string;
    path: string;
    signal?: AbortSignal;
  }): Promise<DatabaseSnapshotView>;
  readBytes(input: {
    bytes: Uint8Array;
    path: string;
    signal?: AbortSignal;
  }): Promise<DatabaseSnapshotView>;
  readPagePath(input: {
    absolutePath: string;
    path: string;
    table: string;
    offset: number;
    signal?: AbortSignal;
  }): Promise<DatabasePageView>;
  readPageBytes(input: {
    bytes: Uint8Array;
    path: string;
    table: string;
    offset: number;
    signal?: AbortSignal;
  }): Promise<DatabasePageView>;
  editPath(input: {
    absolutePath: string;
    path: string;
    logPath: string;
    statePath: string;
    edit: DatabaseEdit;
    operation: DatabaseOperationInput;
    pageOffset?: number;
    signal?: AbortSignal;
  }): Promise<DatabaseEditResult>;
  dispose(): Promise<void>;
}

export interface WorkspaceDatabaseWorkerOwnerOptions {
  workerUrl?: URL;
  workerFactory?: (url: URL) => WorkerAdapter;
  onRequestStarted?: (
    request: Pick<WorkspaceDatabaseWorkerRequest, "id" | "kind">,
  ) => void;
  unref?: boolean;
}

type RequestWithoutId = WorkspaceDatabaseWorkerRequest extends infer Request
  ? Request extends WorkspaceDatabaseWorkerRequest
    ? Omit<Request, "id">
    : never
  : never;

interface QueuedRequest<Result extends WorkspaceDatabaseWorkerResult> {
  request: RequestWithoutId;
  signal?: AbortSignal;
  cancelMessage: string;
  resolve(result: Result): void;
  reject(error: unknown): void;
  abortListener?: () => void;
  dispatched: boolean;
  aborted: boolean;
  settled: boolean;
  id?: number;
}

function cancellationMessage(kind: RequestWithoutId["kind"]): string {
  return kind === "edit-path"
    ? "Database edit was cancelled."
    : "Database read was cancelled.";
}

function requestError(response: Extract<
  WorkspaceDatabaseWorkerResponse,
  { kind: "error" }
>): Error {
  const error = new Error(response.error.message);
  error.name = response.error.name;
  if (response.error.stack) error.stack = response.error.stack;
  if (response.error.code) {
    (error as NodeJS.ErrnoException).code = response.error.code;
  }
  return error;
}

export function createWorkspaceDatabaseWorkerOwner(
  options: WorkspaceDatabaseWorkerOwnerOptions = {},
): WorkspaceDatabaseWorkerOwner {
  const defaultWorkerFile = import.meta.url.endsWith(".ts")
    ? "workspaceDatabaseThread.ts"
    : "workspace-database-worker.js";
  const workerUrl =
    options.workerUrl ?? new URL(defaultWorkerFile, import.meta.url);
  const workerFactory =
    options.workerFactory ?? ((url: URL) => new Worker(url) as WorkerAdapter);
  const queue: Array<QueuedRequest<WorkspaceDatabaseWorkerResult>> = [];
  let worker: WorkerAdapter | null = null;
  let active: QueuedRequest<WorkspaceDatabaseWorkerResult> | null = null;
  let nextId = 1;
  let disposed = false;
  let disposePromise: Promise<void> | null = null;
  let resolveDrained: (() => void) | null = null;

  function removeAbortListener(
    entry: QueuedRequest<WorkspaceDatabaseWorkerResult>,
  ): void {
    if (entry.abortListener) {
      entry.signal?.removeEventListener("abort", entry.abortListener);
      entry.abortListener = undefined;
    }
  }

  function settle(
    entry: QueuedRequest<WorkspaceDatabaseWorkerResult>,
    outcome: { result: WorkspaceDatabaseWorkerResult } | { error: unknown },
  ): void {
    if (entry.settled) return;
    entry.settled = true;
    removeAbortListener(entry);
    if ("error" in outcome) entry.reject(outcome.error);
    else entry.resolve(outcome.result);
  }

  function drained(): void {
    if (active || queue.length > 0) return;
    resolveDrained?.();
    resolveDrained = null;
  }

  function cleanCrashError(detail: string): Error {
    return new Error(
      `Workspace database worker stopped unexpectedly while handling a request (${detail}).`,
    );
  }

  function workerFailed(failed: WorkerAdapter, error: Error): void {
    if (worker !== failed) return;
    worker = null;
    const failedActive = active;
    active = null;
    if (failedActive) settle(failedActive, { error });
    void failed.terminate().catch(() => undefined);
    pump();
  }

  function ensureWorker(): WorkerAdapter {
    if (worker) return worker;
    const created = workerFactory(workerUrl);
    worker = created;
    if (options.unref !== false) created.unref();
    created.on("message", (message) => {
      if (worker !== created || !active || !isWorkspaceDatabaseWorkerResponse(message)) {
        if (worker === created && active) {
          workerFailed(created, cleanCrashError("invalid response"));
        }
        return;
      }
      if (message.id !== active.id) {
        workerFailed(created, cleanCrashError("response id mismatch"));
        return;
      }
      if (message.kind === "started") {
        options.onRequestStarted?.({ id: message.id, kind: active.request.kind });
        return;
      }
      const completed = active;
      active = null;
      if (message.kind === "error") {
        settle(completed, { error: requestError(message) });
      } else if (completed.aborted) {
        settle(completed, { error: new Error(completed.cancelMessage) });
      } else {
        settle(completed, { result: message.result });
      }
      pump();
    });
    created.on("error", (error) => {
      workerFailed(created, cleanCrashError(error.message || "worker error"));
    });
    created.on("exit", (code) => {
      if (worker !== created) return;
      workerFailed(
        created,
        cleanCrashError(code === 0 ? "exited without a response" : `exit code ${code}`),
      );
    });
    return created;
  }

  function pump(): void {
    if (active) return;
    while (queue.length > 0) {
      const entry = queue.shift()!;
      if (entry.settled) continue;
      if (disposed || entry.signal?.aborted) {
        settle(entry, { error: new Error(entry.cancelMessage) });
        continue;
      }
      entry.dispatched = true;
      entry.id = nextId;
      nextId += 1;
      active = entry;
      try {
        ensureWorker().postMessage({ ...entry.request, id: entry.id });
      } catch (error) {
        active = null;
        settle(entry, { error });
        const failed = worker;
        worker = null;
        if (failed) void failed.terminate().catch(() => undefined);
        continue;
      }
      return;
    }
    drained();
  }

  function enqueue<Result extends WorkspaceDatabaseWorkerResult>(
    request: RequestWithoutId,
    signal: AbortSignal | undefined,
  ): Promise<Result> {
    if (disposed) {
      return Promise.reject(new Error("Workspace database worker is disposed."));
    }
    if (signal?.aborted) {
      return Promise.reject(new Error(cancellationMessage(request.kind)));
    }
    return new Promise<Result>((resolve, reject) => {
      const entry: QueuedRequest<Result> = {
        request,
        signal,
        cancelMessage: cancellationMessage(request.kind),
        resolve,
        reject,
        dispatched: false,
        aborted: false,
        settled: false,
      };
      if (signal) {
        entry.abortListener = () => {
          entry.aborted = true;
          if (entry.dispatched) return;
          const index = queue.indexOf(
            entry as QueuedRequest<WorkspaceDatabaseWorkerResult>,
          );
          if (index >= 0) queue.splice(index, 1);
          settle(entry as QueuedRequest<WorkspaceDatabaseWorkerResult>, {
            error: new Error(entry.cancelMessage),
          });
          drained();
        };
        signal.addEventListener("abort", entry.abortListener, { once: true });
        if (signal.aborted) entry.abortListener();
      }
      if (!entry.settled) {
        queue.push(entry as QueuedRequest<WorkspaceDatabaseWorkerResult>);
        pump();
      }
    });
  }

  return {
    readPath(input) {
      return enqueue<DatabaseSnapshotView>(
        {
          kind: "read-path",
          absolutePath: input.absolutePath,
          resultPath: input.path,
        },
        input.signal,
      );
    },
    readBytes(input) {
      return enqueue<DatabaseSnapshotView>(
        { kind: "read-bytes", bytes: input.bytes, resultPath: input.path },
        input.signal,
      );
    },
    readPagePath(input) {
      return enqueue<DatabasePageView>(
        {
          kind: "read-page-path",
          absolutePath: input.absolutePath,
          resultPath: input.path,
          table: input.table,
          offset: input.offset,
        },
        input.signal,
      );
    },
    readPageBytes(input) {
      return enqueue<DatabasePageView>(
        {
          kind: "read-page-bytes",
          bytes: input.bytes,
          resultPath: input.path,
          table: input.table,
          offset: input.offset,
        },
        input.signal,
      );
    },
    editPath(input) {
      return enqueue<DatabaseEditResult>(
        {
          kind: "edit-path",
          absolutePath: input.absolutePath,
          resultPath: input.path,
          logPath: input.logPath,
          statePath: input.statePath,
          edit: input.edit,
          operation: input.operation,
          pageOffset: input.pageOffset ?? 0,
        },
        input.signal,
      );
    },
    dispose() {
      if (disposePromise) return disposePromise;
      disposed = true;
      for (const entry of queue.splice(0)) {
        settle(entry, { error: new Error("Workspace database worker is disposed.") });
      }
      disposePromise = (async () => {
        if (active) {
          await new Promise<void>((resolve) => {
            resolveDrained = resolve;
          });
        }
        const current = worker;
        worker = null;
        if (current) await current.terminate();
      })();
      return disposePromise;
    },
  };
}
