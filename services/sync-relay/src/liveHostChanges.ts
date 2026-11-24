import type { LiveDocumentKey } from "@dohc/live-session-contract/live-update-admission";

/**
 * What a listener waits for. `standing` rechecks a connection's authority, so
 * it also hears relay writes. `applied` waits for the native feed of its
 * document. `object` waits for any lineage of an object (desktop readiness).
 */
export type NamedFrameChangeScope =
  | { readonly kind: "standing" | "applied"; readonly document: LiveDocumentKey }
  | { readonly kind: "object"; readonly workspaceId: string; readonly objectId: string };
export interface NamedFrameChanges {
  subscribe(changed: () => void, scope: NamedFrameChangeScope): () => void;
}
const documentKey = (document: LiveDocumentKey) =>
  JSON.stringify([
    document.workspaceId,
    document.mainVersionId,
    document.objectId,
    document.lineageClaimId,
  ]);
const objectKey = (workspaceId: string, objectId: string) =>
  JSON.stringify([workspaceId, objectId]);

/**
 * One shared wake per microtask; notifications contain no bytes or event queue.
 * A change reaches only the listeners on its document, so a wake costs the
 * document's connections, not the relay's.
 */
export function createNamedFrameChanges(maxListeners: number) {
  if (!Number.isSafeInteger(maxListeners) || maxListeners < 1)
    throw new TypeError("Invalid frame listener bound.");
  type Row = {
    changed: () => void;
    kind: NamedFrameChangeScope["kind"];
    key: string;
    workspace: string;
  };
  const byKey = new Map<string, Set<Row>>(),
    byWorkspace = new Map<string, Set<Row>>(),
    standing = new Set<Row>(),
    dirty = new Set<Row>();
  // Desktop admission/readiness subscriptions have their own listener pool.
  let frameListeners = 0,
    objectListeners = 0,
    queued = false;
  const add = (index: Map<string, Set<Row>>, key: string, row: Row) => {
    const rows = index.get(key) ?? new Set<Row>();
    rows.add(row);
    index.set(key, rows);
  };
  const remove = (index: Map<string, Set<Row>>, key: string, row: Row) => {
    const rows = index.get(key);
    if (rows?.delete(row) && !rows.size) index.delete(key);
  };
  const mark = (rows: Iterable<Row> | undefined, kinds?: ReadonlySet<Row["kind"]>) => {
    for (const row of rows ?? []) if (!kinds || kinds.has(row.kind)) dirty.add(row);
  };
  const wake = () => {
    if (queued || !dirty.size) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      const rows = [...dirty];
      dirty.clear();
      for (const row of rows) {
        try {
          row.changed();
        } catch {
          /* Other captures still receive this wake. */
        }
      }
    });
  };
  const standingOnly = new Set<Row["kind"]>(["standing"]);
  return {
    maxListeners,
    subscribe(changed: () => void, scope: NamedFrameChangeScope) {
      const object = scope.kind === "object";
      if ((object ? objectListeners : frameListeners) >= maxListeners)
        throw new Error("Frame listener capacity exhausted.");
      const row: Row = object
        ? {
            changed,
            kind: scope.kind,
            key: objectKey(scope.workspaceId, scope.objectId),
            workspace: scope.workspaceId,
          }
        : {
            changed,
            kind: scope.kind,
            key: documentKey(scope.document),
            workspace: scope.document.workspaceId,
          };
      add(byKey, row.key, row);
      add(byWorkspace, row.workspace, row);
      if (row.kind === "standing") standing.add(row);
      if (object) objectListeners++;
      else frameListeners++;
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        remove(byKey, row.key, row);
        remove(byWorkspace, row.workspace, row);
        standing.delete(row);
        dirty.delete(row);
        if (object) objectListeners--;
        else frameListeners--;
      };
    },
    /** The native feed of `document` changed. */
    notify(document: LiveDocumentKey) {
      mark(byKey.get(documentKey(document)));
      mark(byKey.get(objectKey(document.workspaceId, document.objectId)));
      wake();
    },
    /** A relay write may have changed standing on `documents`, or on any document when it names none. */
    notifyWrite(documents?: readonly LiveDocumentKey[]) {
      if (!documents) mark(standing);
      else for (const document of documents) mark(byKey.get(documentKey(document)), standingOnly);
      wake();
    },
    notifyHost(workspaceIds: readonly string[]) {
      for (const workspaceId of new Set(workspaceIds)) mark(byWorkspace.get(workspaceId));
      wake();
    },
    listenerCount: () => frameListeners + objectListeners,
  };
}
