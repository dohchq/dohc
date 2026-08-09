// WS-G2-C-2 — the ENGINE Y.Doc provider (renderer half of the bridge).
//
// The live engine Y.Doc lives in MAIN (the engine driver is node-only). The
// renderer's Tiptap editor binds to a MIRROR Y.Doc that this provider keeps
// convergent with the main session over a transport (IPC in production, a mock
// in tests). It exposes a Y.Doc that the Collaboration extension binds to via
// its "body" XmlFragment. Solo editing runs purely on the
// engine, and co-editing rides the same channel because main forwards remote
// ydoc.update deltas through onRemoteUpdate.
//
// The echo guard mirrors the main core's origin contract. Every engine-sourced
// update (the initial state + every forwarded remote delta) is applied to the
// mirror doc under ENGINE_SOURCED_ORIGIN; the update observer that ships local
// edits to main SKIPS that origin, so an engine-applied update is never bounced
// back to main (which would double-journal / echo-storm). A real editor edit
// carries Tiptap's own (non-ENGINE) origin and IS shipped.

import * as Y from "yjs";

// Applied to the mirror doc for every update that ORIGINATED in the engine
// (initial state, forwarded remote deltas). The local-edit observer ignores it.
const ENGINE_SOURCED_ORIGIN: unique symbol = Symbol("dohc.engineSourcedUpdate");

// One name for one concept, shared by the transport's open answer and the
// binding it produces (and re-exported from useEngineDoc.ts) — three inline
// copies of the same shape could drift silently if a third operation joins
// delete/move.
export type EngineRemovalInProgress = {
  operation: "delete" | "move";
  message: string;
};

export interface EngineYDocTransport {
  // Open the engine session in main. available:false => not an engine-backed
  // doc (unflagged workspace, secret path, or already live) — the caller falls
  // back to the plain local editor. notInVersion:true is the ONE available:false
  // that must not fall back that way: the path is not in the version this
  // workspace is on, and the plain editor's autosave would write it back as a
  // phantom file (#534).
  open(): Promise<{
    available: boolean;
    initialUpdate?: Uint8Array;
    notInVersion?: boolean;
    // A session for this document may still be the engine's (#564, #657) —
    // the other available:false that must not fall back to the plain editor.
    engineMayHoldDocument?: boolean;
    // A destructive operation owns this path for an interval. Falling back to
    // the plain editor would let its autosave race that operation.
    removalInProgress?: EngineRemovalInProgress;
  }>;
  // Ship a local editor update to main, where it is journaled via recordUpdate.
  applyLocalUpdate(update: Uint8Array): void;
  // Subscribe to remote CRDT deltas main forwards (a co-editor's edit routed
  // through the engine). Returns an unsubscribe function.
  onRemoteUpdate(listener: (update: Uint8Array) => void): () => void;
  // Settle + close the engine session in main (releases the reservation).
  close(): Promise<void>;
}

export interface EngineYDocBinding {
  // The mirror Y.Doc Tiptap binds to, or null when the doc is not engine-backed
  // (available:false) — the caller stays on the local autosave editor.
  readonly doc: Y.Doc | null;
  readonly available: boolean;
  // The path is not in the version this workspace is on. The caller must stop
  // editing the document, not downgrade it to the writable plain editor.
  readonly notInVersion: boolean;
  // A session for this document may still be the engine's (#564, #657). The
  // caller keeps the document read-only with the reason stated and a retry
  // offered — the same no-downgrade rule as notInVersion.
  readonly engineMayHoldDocument: boolean;
  // A delete or move owns the path for an interval. The caller keeps the
  // document read-only and offers a fresh open after the interval ends.
  readonly removalInProgress: EngineRemovalInProgress | null;
  // Tear down: stop shipping edits, unsubscribe, close the engine session, and
  // destroy the mirror doc. Idempotent.
  destroy(): Promise<void>;
}

// Bind a mirror Y.Doc to an engine session over `transport`. On success the
// returned binding's `doc` is ready for the Collaboration extension.
export async function bindEngineYDoc(
  transport: EngineYDocTransport,
): Promise<EngineYDocBinding> {
  const opened = await transport.open();
  if (!opened.available || !opened.initialUpdate) {
    return {
      doc: null,
      available: false,
      notInVersion: opened.notInVersion === true,
      engineMayHoldDocument: opened.engineMayHoldDocument === true,
      removalInProgress: opened.removalInProgress ?? null,
      async destroy() {
        // Best-effort close even on the unavailable path: main may have taken a
        // reservation before deciding not to serve (it should not, but never
        // leak one).
        await transport.close().catch(() => undefined);
      },
    };
  }

  const doc = new Y.Doc();
  // Seed the mirror to the engine's current state BEFORE binding, under the
  // engine origin so the observer we attach next does not ship it back.
  Y.applyUpdate(doc, opened.initialUpdate, ENGINE_SOURCED_ORIGIN);

  let destroyed = false;

  // Ship every LOCAL editor edit to main. A Tiptap edit carries a non-ENGINE
  // origin; an engine-sourced apply carries ENGINE_SOURCED_ORIGIN and is
  // skipped (no echo back to main).
  const onUpdate = (update: Uint8Array, origin: unknown): void => {
    if (destroyed) return;
    if (origin === ENGINE_SOURCED_ORIGIN) return;
    transport.applyLocalUpdate(update);
  };
  doc.on("update", onUpdate);

  // Apply forwarded remote deltas under the engine origin so they render live
  // in the editor but are never shipped back to main.
  const unsubscribe = transport.onRemoteUpdate((update) => {
    if (destroyed) return;
    Y.applyUpdate(doc, update, ENGINE_SOURCED_ORIGIN);
  });

  return {
    doc,
    available: true,
    notInVersion: false,
    engineMayHoldDocument: false,
    removalInProgress: null,
    async destroy() {
      if (destroyed) return;
      destroyed = true;
      doc.off("update", onUpdate);
      unsubscribe();
      // Close the engine session first (it settles the converged state), then
      // drop the mirror doc.
      await transport.close().catch(() => undefined);
      doc.destroy();
    },
  };
}
