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

const REPAIR_RETRY_INITIAL_MS = 250;
const REPAIR_RETRY_MAX_MS = 5_000;

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
  // Resolution acknowledges that main accepted the update. The binding joins
  // every acknowledgement before close, so teardown cannot outrun an edit.
  applyLocalUpdate(update: Uint8Array): Promise<void>;
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

type EngineYDocBindingOptions = {
  // If both ordinary delivery and the final full-state retry fail, preserve
  // the canonical mirror before close destroys it.
  onDeliveryFailure?: (
    snapshot: Uint8Array,
    error: unknown,
  ) => void | Promise<void>;
  // Main can report a later update as saved before an earlier rejected IPC
  // delivery is repaired. Keep the owner informed until every accepted local
  // update, including a full-state repair, has finished.
  onDeliveryPendingChange?: (pending: boolean) => void;
};

// Bind a mirror Y.Doc to an engine session over `transport`. On success the
// returned binding's `doc` is ready for the Collaboration extension.
export async function bindEngineYDoc(
  transport: EngineYDocTransport,
  options: EngineYDocBindingOptions = {},
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
  let destroyPromise: Promise<void> | null = null;
  const activeDeliveries = new Set<Promise<void>>();
  let deliveryPending = false;
  let repairNeeded = false;
  let repairRunning = false;
  let repairRequested = false;
  let repairRetryDelayMs = REPAIR_RETRY_INITIAL_MS;
  let repairRetryTimer: ReturnType<typeof setTimeout> | null = null;

  const setDeliveryPending = (pending: boolean): void => {
    if (deliveryPending === pending) return;
    deliveryPending = pending;
    options.onDeliveryPendingChange?.(pending);
  };

  const finishDeliveryIfSafe = (): void => {
    if (
      activeDeliveries.size === 0 &&
      !repairNeeded &&
      !repairRunning
    ) {
      setDeliveryPending(false);
    }
  };

  const trackDelivery = (delivery: Promise<void>): void => {
    let tracked!: Promise<void>;
    tracked = delivery.finally(() => {
      activeDeliveries.delete(tracked);
      finishDeliveryIfSafe();
    });
    activeDeliveries.add(tracked);
    void tracked.catch(() => undefined);
  };

  const clearRepairRetry = (): void => {
    if (repairRetryTimer === null) return;
    clearTimeout(repairRetryTimer);
    repairRetryTimer = null;
  };

  const scheduleRepairRetry = (): void => {
    if (destroyed || repairRetryTimer !== null || !repairNeeded) return;
    const delay = repairRetryDelayMs;
    repairRetryDelayMs = Math.min(delay * 2, REPAIR_RETRY_MAX_MS);
    repairRetryTimer = setTimeout(() => {
      repairRetryTimer = null;
      startRepair();
    }, delay);
  };

  function startRepair(): void {
    if (destroyed || repairRunning || !repairNeeded) return;
    clearRepairRetry();
    repairNeeded = false;
    repairRunning = true;
    repairRequested = false;
    const snapshot = Y.encodeStateAsUpdate(doc);
    const repair = (async () => {
      let repaired = false;
      try {
        await transport.applyLocalUpdate(snapshot);
        repaired = true;
      } catch {
        repairNeeded = true;
      } finally {
        repairRunning = false;
        if (repaired) repairRetryDelayMs = REPAIR_RETRY_INITIAL_MS;
        if (repairNeeded) {
          if (repaired || repairRequested) startRepair();
          else scheduleRepairRetry();
        }
      }
    })();
    trackDelivery(repair);
  }

  // Ship every LOCAL editor edit to main. A Tiptap edit carries a non-ENGINE
  // origin; an engine-sourced apply carries ENGINE_SOURCED_ORIGIN and is
  // skipped (no echo back to main).
  const onUpdate = (update: Uint8Array, origin: unknown): void => {
    if (destroyed) return;
    if (origin === ENGINE_SOURCED_ORIGIN) return;
    setDeliveryPending(true);
    if (repairRunning) repairRequested = true;
    let delivery: Promise<void>;
    try {
      // Start synchronously, as before. Main owns update ordering; the
      // acknowledgement tracking below is not a second delivery queue.
      delivery = transport.applyLocalUpdate(update);
    } catch (error: unknown) {
      delivery = Promise.reject(error);
    }
    const observed = delivery.catch((error: unknown) => {
      repairNeeded = true;
      startRepair();
      throw error;
    });
    trackDelivery(observed);
    // A new edit is a delivery opportunity, so it need not wait for a
    // scheduled repair retry.
    startRepair();
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
    destroy() {
      if (destroyPromise) return destroyPromise;
      destroyed = true;
      clearRepairRetry();
      doc.off("update", onUpdate);
      unsubscribe();
      destroyPromise = (async () => {
        let deliveryError: unknown = null;
        let recoveryError: unknown = null;
        while (activeDeliveries.size > 0) {
          await Promise.allSettled([...activeDeliveries]);
        }
        if (repairNeeded) {
          const finalSnapshot = Y.encodeStateAsUpdate(doc);
          try {
            // Full state, not the failed delta: this also covers every edit
            // made while the failed delivery was in flight.
            await transport.applyLocalUpdate(finalSnapshot);
          } catch (error: unknown) {
            deliveryError = error;
            try {
              await options.onDeliveryFailure?.(finalSnapshot, error);
            } catch (captureError: unknown) {
              recoveryError = captureError;
            }
          }
        }

        // Main settles the converged state on close. A close failure is still
        // retained and retried by main, so it stays best-effort here.
        await transport.close().catch(() => undefined);
        doc.destroy();

        if (recoveryError !== null) throw recoveryError;
        // Generic bindings without a recovery owner must not hide loss.
        if (deliveryError !== null && !options.onDeliveryFailure) {
          throw deliveryError;
        }
      })();
      return destroyPromise;
    },
  };
}
