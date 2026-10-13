import type {SyncRelayStorage} from "./storage.js";

type Document = {readonly workspaceId: string; readonly objectId: string};
const documentKey = (document: Document) => JSON.stringify([document.workspaceId, document.objectId]);

/** Counts the live connections to each document across every live route. A host unloads only documents with none. */
export class LiveEditors {
  readonly #connections = new Map<string, number>();
  readonly #listeners = new Set<(document: Document) => void>();

  /** Counts one connection until the returned release runs. Each change notifies listeners. */
  acquire(value: Document): () => void {
    const document = {workspaceId: value.workspaceId, objectId: value.objectId}, key = documentKey(document);
    this.#connections.set(key, (this.#connections.get(key) ?? 0) + 1);
    this.#notify(document);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = this.#connections.get(key)! - 1;
      if (remaining) this.#connections.set(key, remaining); else this.#connections.delete(key);
      this.#notify(document);
    };
  }

  connected(document: Document): boolean {return this.#connections.has(documentKey(document));}

  subscribe(listener: (document: Document) => void): () => void {
    this.#listeners.add(listener);
    return () => {this.#listeners.delete(listener);};
  }

  #notify(document: Document) {
    for (const listener of [...this.#listeners]) {
      try {listener(document);} catch (error) {
        try {console.error("Live editor listener failed.", error);} catch { /* Counting must not stop for reporting. */ }
      }
    }
  }
}

const shared = new WeakMap<SyncRelayStorage, LiveEditors>();
/** The editors of one relay's documents, shared by its live routes and service host. */
export function liveEditors(storage: SyncRelayStorage): LiveEditors {
  let editors = shared.get(storage);
  if (!editors) {editors = new LiveEditors(); shared.set(storage, editors);}
  return editors;
}
