import { Worker } from "node:worker_threads";
import * as Y from "yjs";
import {
  documentCreateUpdate,
  documentEditUpdate,
  documentMarkdown,
  settledDocumentMarkdown,
  yDocToMarkdown,
  type DocumentEdit,
} from "@dohc/ydoc-projection";
import { isLossyDocumentState, isLossyMarkdownCached, lossyNoteRefusal } from "@dohc/ydoc-projection/lossy-markdown";

// Reading a live document as Markdown and computing an edit to it take time
// in proportion to the document: about 250 ms for 700 KB. Main runs them in a
// worker, so no window's IPC waits behind an agent's edit.

export type DocumentProjectionRequest =
  | { kind: "read"; state: Uint8Array }
  | { kind: "read-settled"; markdown: string }
  // `refuseLossy` names the note, which refuses here if it is a lossy note
  // (CONTEXT.md): this is the turn that would change it.
  | { kind: "edit"; state: Uint8Array; edit: DocumentEdit; keepBlocks: boolean; refuseLossy?: string; headSha256?: string | null }
  | { kind: "create"; state: Uint8Array; markdown: string; keepBlocks: boolean }
  // Whether a file's text is a lossy note (CONTEXT.md). The worker remembers
  // the verdict by `digest`, the SHA-256 of the text.
  | { kind: "lossy"; markdown: string; digest: string }
  | { kind: "recover"; updates: readonly Uint8Array[] };

type DocumentProjectionResult<Request extends DocumentProjectionRequest> =
  Request extends { kind: "recover" } ? string | null
    : Request extends { kind: "edit" | "create" } ? Uint8Array | null
      : Request extends { kind: "lossy" } ? boolean : string;

/** The document a recovery package's updates rebuild, or null when one still waits on what it depends on. */
export function recoveredDocumentMarkdown(updates: readonly Uint8Array[]): string | null {
  const doc = new Y.Doc();
  try {
    for (const update of updates) Y.applyUpdate(doc, update);
    // An update missing what it depends on would leave its edit out of the copy.
    if (doc.store.pendingStructs !== null || doc.store.pendingDs !== null) return null;
    return yDocToMarkdown(doc);
  } finally {
    doc.destroy();
  }
}

export interface DocumentProjection {
  run<Request extends DocumentProjectionRequest>(
    request: Request,
  ): Promise<DocumentProjectionResult<Request>>;
}

// A request's encoded state moves to the worker instead of being copied, so
// main does not clone the document. The caller must not use it afterwards.
export function transferList(value: unknown): ArrayBuffer[] {
  const bytes = value instanceof Uint8Array
    ? value
    : typeof value === "object" && value !== null && "state" in value && value.state instanceof Uint8Array
      ? value.state
      : null;
  if (!bytes || !(bytes.buffer instanceof ArrayBuffer)) return [];
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? [bytes.buffer] : [];
}

type WorkerMessage =
  | { id: number; ok: true; result: string | Uint8Array | boolean | null }
  | { id: number; ok: false; message: string };

export function runDocumentProjection(
  request: DocumentProjectionRequest,
): string | Uint8Array | boolean | null {
  switch (request.kind) {
    case "read":
      return documentMarkdown(request.state);
    case "read-settled":
      return settledDocumentMarkdown(request.markdown);
    case "edit":
      if (request.refuseLossy !== undefined && (request.headSha256 === undefined || isLossyDocumentState(request.state, request.headSha256))) {
        throw new Error(lossyNoteRefusal(request.refuseLossy));
      }
      return documentEditUpdate(request.state, request.edit, {
        keepBlocks: request.keepBlocks,
      });
    case "create":
      return documentCreateUpdate(request.state, request.markdown, {
        keepBlocks: request.keepBlocks,
      });
    case "lossy":
      return isLossyMarkdownCached(request.digest, request.markdown);
    case "recover":
      return recoveredDocumentMarkdown(request.updates);
  }
}

/** The projection on the calling thread, for tests and tools. */
export const directDocumentProjection: DocumentProjection = {
  async run(request) {
    return runDocumentProjection(request) as DocumentProjectionResult<typeof request>;
  },
};

// Generous against the measured cost of the largest live document (2 MB), and
// short of the CLI socket's 15 s request deadline, so the caller hears why.
const DOCUMENT_PROJECTION_DEADLINE_MS = 12_000;

/**
 * Runs projections one at a time in a worker thread started on first use.
 * A worker that fails or passes the deadline is stopped, and the next request
 * starts a new one.
 */
export function createDocumentProjectionWorker(
  options: { workerUrl?: URL; deadlineMs?: number } = {},
): DocumentProjection {
  const workerUrl = options.workerUrl ?? new URL(
    import.meta.url.endsWith(".ts") ? "documentProjectionThread.ts" : "document-projection-worker.js",
    import.meta.url,
  );
  const deadlineMs = options.deadlineMs ?? DOCUMENT_PROJECTION_DEADLINE_MS;
  let worker: Worker | null = null;
  let nextId = 1;
  let queue: Promise<unknown> = Promise.resolve();

  function started(): Worker {
    if (worker) return worker;
    const created = new Worker(workerUrl);
    created.unref();
    worker = created;
    return created;
  }

  function stop(stopped: Worker): void {
    if (worker === stopped) worker = null;
    void stopped.terminate().catch(() => undefined);
  }

  function send(request: DocumentProjectionRequest): Promise<string | Uint8Array | boolean | null> {
    const current = started();
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const finish = (outcome: () => void): void => {
        clearTimeout(timer);
        current.off("message", onMessage);
        current.off("error", onError);
        current.off("exit", onExit);
        outcome();
      };
      const onMessage = (message: WorkerMessage): void => {
        if (message.id !== id) return;
        finish(() => (message.ok ? resolve(message.result) : reject(new Error(message.message))));
      };
      const onError = (error: Error): void => {
        stop(current);
        finish(() => reject(new Error(`dohc could not prepare the document: ${error.message}`)));
      };
      const onExit = (code: number): void => {
        stop(current);
        finish(() => reject(new Error(`dohc could not prepare the document (its worker exited with ${code}).`)));
      };
      const timer = setTimeout(() => {
        stop(current);
        finish(() => reject(new Error(
          `dohc stopped preparing the document after ${deadlineMs / 1000} s, and nothing changed. Try a smaller edit, or try again.`,
        )));
      }, deadlineMs);
      current.on("message", onMessage);
      current.on("error", onError);
      current.on("exit", onExit);
      current.postMessage({ id, request }, transferList(request));
    });
  }

  return {
    run(request) {
      const result = queue.then(() => send(request));
      queue = result.catch(() => undefined);
      return result as Promise<DocumentProjectionResult<typeof request>>;
    },
  };
}
