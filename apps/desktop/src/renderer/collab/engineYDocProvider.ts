// WS-G2-C-2 — the ENGINE Y.Doc provider (renderer half of the bridge).
//
// The live engine Y.Doc lives in MAIN (the engine driver is node-only). The
// renderer's format editor binds to a MIRROR Y.Doc that this provider keeps
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
import type { ArtifactAssetDescriptor } from "@dohc/workspace-engine-client";
import { ENGINE_YDOC_UPDATE_MAX_BYTES } from "../../ipc/channels";

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
  // Declare format-owned top-level roots before the initial engine update is
  // applied. This prevents Yjs from inferring an incompatible shared type.
  initializeDoc?(doc: Y.Doc): void;
  // Open the engine session in main. available:false => not an engine-backed
  // doc (unflagged workspace, secret path, or already live) — the caller falls
  // back to the plain local editor. notInVersion:true is the ONE available:false
  // that must not fall back that way: the path is not in the version this
  // workspace is on, and the plain editor's autosave would write it back as a
  // phantom file (#534).
  open(): Promise<{
    available: boolean;
    initialUpdate?: Uint8Array;
    objectId?: string;
    versionId?: string;
    artifactAssets?: readonly ArtifactAssetDescriptor[];
    lineageGeneration?: number;
    notInVersion?: boolean;
    // A session for this document may still be the engine's (#564, #657) —
    // the other available:false that must not fall back to the plain editor.
    engineMayHoldDocument?: boolean;
    // The canonical drawing has image records that conflict with storage.
    // This terminal state stays read-only and must not offer a retry.
    artifactAssetsInvalid?: boolean;
    // A destructive operation owns this path for an interval. Falling back to
    // the plain editor would let its autosave race that operation.
    removalInProgress?: EngineRemovalInProgress;
  }>;
  readArtifactAsset?(descriptor: ArtifactAssetDescriptor): Promise<{
    descriptor: ArtifactAssetDescriptor;
    bytes: Uint8Array;
  }>;
  // Reserve the save sequence synchronously when a local edit occurs. The
  // provider can delay transport without letting an older settle report the
  // pending edit as saved. null refuses the write before it enters a batch.
  stageLocalUpdate(): number | null;
  // Ship a local editor batch to main, where it is journaled via recordUpdate.
  // sequence is the newest staged edit covered by the merged update.
  applyLocalUpdate(
    update: Uint8Array,
    sequence: number,
    lineageGeneration: number,
  ): void | Promise<void>;
  // Subscribe to remote CRDT deltas main forwards (a co-editor's edit routed
  // through the engine). Returns an unsubscribe function.
  onRemoteUpdate(
    listener: (update: Uint8Array, lineageGeneration: number) => void,
  ): () => void;
  // A divergent relay base replaced this session's lineage. The payload is a
  // full state, not a delta: merging it into the old Y.Doc would preserve the
  // losing root and corrupt the winner.
  onLineageReplacement(
    listener: (input: {
      update: Uint8Array;
      recoveredPaths: string[];
      artifactAssets: readonly ArtifactAssetDescriptor[];
      lineageGeneration: number;
    }) => void | Promise<void>,
  ): () => void;
  acknowledgeLineageReplacement(lineageGeneration: number): Promise<Uint8Array[]>;
  // Settle + close the engine session in main (releases the reservation).
  close(): Promise<void>;
}

export interface EngineYDocBatchScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export class EngineYDocUpdateTooLargeError extends Error {
  readonly code = "engine-ydoc-update-too-large";
  readonly constraint = "ENGINE_YDOC_UPDATE_MAX_BYTES";

  constructor(
    readonly observedBytes: number,
    readonly limitBytes: number = ENGINE_YDOC_UPDATE_MAX_BYTES,
  ) {
    super(
      "dohc could not save this edit. ENGINE_YDOC_UPDATE_MAX_BYTES is " +
        `${limitBytes} bytes; the update is ${observedBytes} bytes. ` +
        "Copy the set-aside edit below.",
    );
    this.name = "EngineYDocUpdateTooLargeError";
  }
}

function isEngineYDocUpdateTooLargeError(
  error: unknown,
): error is EngineYDocUpdateTooLargeError {
  return error instanceof EngineYDocUpdateTooLargeError;
}

export interface EngineYDocBindOptions {
  onPermanentLocalUpdateFailure?: (
    error: EngineYDocUpdateTooLargeError,
    doc: Y.Doc,
  ) => void;
  // Runs after the losing mirror stops shipping updates and before main
  // accepts the winner generation. The desktop uses this boundary to persist
  // state that existed only in the losing renderer mirror.
  onDocumentReplacing?: (
    retired: Y.Doc,
    recoveredPaths: string[],
  ) => void | Promise<void>;
  onLineageReplacementFailure?: (error: unknown, retired: Y.Doc) => void;
}

const LOCAL_UPDATE_BATCH_MS = 32;
// Local IPC normally answers in one turn. A quarter-second retry avoids a hot
// loop during an outage while recovering a brief renderer/main handoff quickly.
const LOCAL_UPDATE_RETRY_MS = 250;
const timeoutBatchScheduler: EngineYDocBatchScheduler = {
  schedule(callback, delayMs) {
    return globalThis.setTimeout(callback, delayMs);
  },
  cancel(handle) {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export function mergeYDocUpdatesForTransport(
  stagedUpdates: ReadonlyArray<{
    update: Uint8Array;
    sequence: number;
  }>,
  maxBytes: number = ENGINE_YDOC_UPDATE_MAX_BYTES,
): Array<{ update: Uint8Array; sequence: number }> {
  if (stagedUpdates.length === 0) return [];

  const mergeRange = (
    start: number,
    end: number,
  ): Array<{ update: Uint8Array; sequence: number }> => {
    const range = stagedUpdates.slice(start, end);
    const merged =
      range.length === 1
        ? range[0]!.update
        : Y.mergeUpdates(range.map(({ update }) => update));
    const sequence = range.at(-1)!.sequence;
    if (merged.byteLength <= maxBytes || range.length === 1) {
      // Keep a single oversized update intact. This provider must not invent a
      // new rejection; the existing transport boundary owns that refusal.
      return [{ update: merged, sequence }];
    }

    const middle = start + Math.ceil(range.length / 2);
    return [...mergeRange(start, middle), ...mergeRange(middle, end)];
  };

  // The normal path parses any number of pending updates once. If a throttled
  // background timer accumulated enough work to cross the existing transport
  // boundary, balanced splitting avoids repeatedly merging a growing prefix.
  return mergeRange(0, stagedUpdates.length);
}

export interface EngineYDocBinding {
  // The mirror Y.Doc Tiptap binds to, or null when the doc is not engine-backed
  // (available:false) — the caller stays on the local autosave editor.
  readonly doc: Y.Doc | null;
  readonly available: boolean;
  readonly objectId: string | null;
  readonly versionId: string | null;
  // The path is not in the version this workspace is on. The caller must stop
  // editing the document, not downgrade it to the writable plain editor.
  readonly notInVersion: boolean;
  // A session for this document may still be the engine's (#564, #657). The
  // caller keeps the document read-only with the reason stated and a retry
  // offered — the same no-downgrade rule as notInVersion.
  readonly engineMayHoldDocument: boolean;
  readonly artifactAssetsInvalid: boolean;
  // A delete or move owns the path for an interval. The caller keeps the
  // document read-only and offers a fresh open after the interval ends.
  readonly removalInProgress: EngineRemovalInProgress | null;
  readonly artifactAssets: readonly ArtifactAssetDescriptor[];
  readArtifactAsset(descriptor: ArtifactAssetDescriptor): Promise<{
    descriptor: ArtifactAssetDescriptor;
    bytes: Uint8Array;
  }>;
  onDocumentReplaced(
    listener: (doc: Y.Doc, recoveredPaths: string[]) => void,
  ): () => void;
  // Tear down: stop shipping edits, unsubscribe, close the engine session, and
  // destroy the mirror doc. Idempotent. If main has not acknowledged an edit,
  // teardown waits and keeps the session open. It completes after recovery.
  destroy(): Promise<void>;
}

// Bind a mirror Y.Doc to an engine session over `transport`. On success the
// returned binding's `doc` is ready for the Collaboration extension.
export async function bindEngineYDoc(
  transport: EngineYDocTransport,
  batchScheduler: EngineYDocBatchScheduler = timeoutBatchScheduler,
  options: EngineYDocBindOptions = {},
): Promise<EngineYDocBinding> {
  type LineageReplacement = {
    update: Uint8Array;
    recoveredPaths: string[];
    artifactAssets: readonly ArtifactAssetDescriptor[];
    lineageGeneration: number;
  };
  const replacementsBeforeOpen: LineageReplacement[] = [];
  let acceptReplacement: ((input: LineageReplacement) => Promise<void>) | null =
    null;
  // Main can announce a winner after it creates the session but before the
  // open invoke resolves in the renderer. Subscribe first so that event is
  // held until the initial mirror and generation are installed.
  const unsubscribeReplacement = transport.onLineageReplacement((input) => {
    if (acceptReplacement === null) {
      replacementsBeforeOpen.push(input);
      return;
    }
    return acceptReplacement(input);
  });
  let opened: Awaited<ReturnType<EngineYDocTransport["open"]>>;
  try {
    opened = await transport.open();
  } catch (error) {
    unsubscribeReplacement();
    throw error;
  }
  if (!opened.available || !opened.initialUpdate) {
    unsubscribeReplacement();
    return {
      doc: null,
      available: false,
      objectId: null,
      versionId: null,
      notInVersion: opened.notInVersion === true,
      engineMayHoldDocument: opened.engineMayHoldDocument === true,
      artifactAssetsInvalid: opened.artifactAssetsInvalid === true,
      removalInProgress: opened.removalInProgress ?? null,
      artifactAssets: [],
      readArtifactAsset(descriptor) {
        return Promise.reject(
          new Error(
            `Artifact asset ${descriptor.id} cannot load without a live document session.`,
          ),
        );
      },
      onDocumentReplaced() {
        return () => undefined;
      },
      async destroy() {
        // Best-effort close even on the unavailable path: main may have taken a
        // reservation before deciding not to serve (it should not, but never
        // leak one).
        await transport.close().catch(() => undefined);
      },
    };
  }

  if (
    typeof opened.lineageGeneration !== "number" ||
    !Number.isSafeInteger(opened.lineageGeneration) ||
    opened.lineageGeneration < 1
  ) {
    unsubscribeReplacement();
    throw new Error("The engine Y.Doc open result has no valid lineage generation.");
  }
  let lineageGeneration = opened.lineageGeneration;
  let doc = new Y.Doc();
  transport.initializeDoc?.(doc);
  // Seed the mirror to the engine's current state BEFORE binding, under the
  // engine origin so the observer we attach next does not ship it back.
  Y.applyUpdate(doc, opened.initialUpdate, ENGINE_SOURCED_ORIGIN);

  let destroyed = false;
  let destroyPromise: Promise<void> | null = null;
  let scheduledFlush: unknown | null = null;
  let pendingLocalUpdates: Array<{
    update: Uint8Array;
    sequence: number;
  }> = [];
  let sendChain = Promise.resolve();
  let localUpdatesRefused = false;
  let replacementInProgress = false;

  const refuseLocalUpdates = (error: EngineYDocUpdateTooLargeError): void => {
    if (localUpdatesRefused) return;
    localUpdatesRefused = true;
    pendingLocalUpdates = [];
    try {
      options.onPermanentLocalUpdateFailure?.(error, doc);
    } catch {
      // Observer boundary: recovery reporting must not wedge teardown.
    }
  };

  const applyLocalUpdateUntilAcknowledged = async (batch: {
    update: Uint8Array;
    sequence: number;
  }, batchGeneration: number): Promise<void> => {
    if (localUpdatesRefused) return;
    if (batch.update.byteLength > ENGINE_YDOC_UPDATE_MAX_BYTES) {
      refuseLocalUpdates(
        new EngineYDocUpdateTooLargeError(batch.update.byteLength),
      );
      return;
    }
    for (;;) {
      if (replacementInProgress || batchGeneration !== lineageGeneration) return;
      try {
        await transport.applyLocalUpdate(
          batch.update,
          batch.sequence,
          batchGeneration,
        );
        return;
      } catch (error) {
        if (isEngineYDocUpdateTooLargeError(error)) {
          refuseLocalUpdates(error);
          return;
        }
        // Yjs increments a client's clock across updates. A later delta can
        // therefore depend on structs in this one, so the head of the queue
        // must stay put until main acknowledges it. Retrying the same update
        // is safe because Yjs updates are idempotent.
        await new Promise<void>((resolve) => {
          batchScheduler.schedule(resolve, LOCAL_UPDATE_RETRY_MS);
        });
      }
    }
  };

  const flushPendingLocalUpdates = (): Promise<void> => {
    if (scheduledFlush !== null) {
      batchScheduler.cancel(scheduledFlush);
      scheduledFlush = null;
    }
    if (pendingLocalUpdates.length === 0) {
      return sendChain;
    }
    const updates = pendingLocalUpdates;
    pendingLocalUpdates = [];
    const batchGeneration = lineageGeneration;
    // Preserve batch order even when the transport is asynchronous. A failed
    // head stays ahead of every later batch until main acknowledges it. The
    // chain remains pending during retries, so teardown cannot settle and
    // close a session that still has renderer-only edits.
    for (const batch of mergeYDocUpdatesForTransport(updates)) {
      sendChain = sendChain.then(() =>
        applyLocalUpdateUntilAcknowledged(batch, batchGeneration),
      );
    }
    return sendChain;
  };

  const scheduleLocalUpdateFlush = (): void => {
    if (scheduledFlush !== null) return;
    scheduledFlush = batchScheduler.schedule(() => {
      scheduledFlush = null;
      void flushPendingLocalUpdates();
    }, LOCAL_UPDATE_BATCH_MS);
  };

  // Coalesce consecutive LOCAL editor edits before shipping them to main. A
  // Tiptap edit carries a non-ENGINE origin; an engine-sourced apply carries
  // ENGINE_SOURCED_ORIGIN and is skipped (no echo back to main).
  const onUpdate = (update: Uint8Array, origin: unknown): void => {
    if (destroyed) return;
    if (origin === ENGINE_SOURCED_ORIGIN) return;
    if (localUpdatesRefused) return;
    const sequence = transport.stageLocalUpdate();
    if (sequence === null) return;
    pendingLocalUpdates.push({ update, sequence });
    scheduleLocalUpdateFlush();
  };
  doc.on("update", onUpdate);

  // Apply forwarded remote deltas under the engine origin so they render live
  // in the editor but are never shipped back to main.
  const unsubscribe = transport.onRemoteUpdate((update, updateGeneration) => {
    if (destroyed) return;
    if (updateGeneration !== lineageGeneration) return;
    Y.applyUpdate(doc, update, ENGINE_SOURCED_ORIGIN);
  });

  const replacementListeners = new Set<
    (replacement: Y.Doc, recoveredPaths: string[]) => void
  >();
  const retiredDocs = new Set<Y.Doc>();
  let replacementHandoff: Promise<void> | null = null;
  let artifactAssets = opened.artifactAssets ?? [];
  const queueReplacement = (input: LineageReplacement): Promise<void> => {
    const replace = async (): Promise<void> => {
      if (destroyed || input.lineageGeneration <= lineageGeneration) return;
      const replacement = new Y.Doc();
      transport.initializeDoc?.(replacement);
      Y.applyUpdate(replacement, input.update, ENGINE_SOURCED_ORIGIN);
      const retired = doc;
      // First close the only path that can ship a losing transaction to main.
      // It stays closed for the whole acknowledgement handoff.
      retired.off("update", onUpdate);
      replacementInProgress = true;
      if (scheduledFlush !== null) {
        batchScheduler.cancel(scheduledFlush);
        scheduledFlush = null;
      }
      pendingLocalUpdates = [];
      let bufferedUpdates: Uint8Array[];
      try {
        if (options.onDocumentReplacing) {
          await options.onDocumentReplacing(retired, input.recoveredPaths);
        }
        bufferedUpdates = await transport.acknowledgeLineageReplacement(
          input.lineageGeneration,
        );
      } catch (error) {
        options.onLineageReplacementFailure?.(error, retired);
        throw error;
      }
      if (destroyed) {
        replacement.destroy();
        return;
      }
      for (const update of bufferedUpdates) {
        Y.applyUpdate(replacement, update, ENGINE_SOURCED_ORIGIN);
      }
      replacement.on("update", onUpdate);
      retiredDocs.add(retired);
      doc = replacement;
      lineageGeneration = input.lineageGeneration;
      artifactAssets = input.artifactAssets;
      localUpdatesRefused = false;
      replacementInProgress = false;
      for (const listener of replacementListeners) {
        listener(replacement, input.recoveredPaths);
      }
    };
    const handoff = replacementHandoff
      ? replacementHandoff.then(replace)
      : replace();
    replacementHandoff = handoff;
    void handoff.catch((error: unknown) => {
      // Stay frozen on a failed handoff. Reattaching the losing observer would
      // make the editor look writable while main correctly refuses its
      // generation, recreating the silent-loss window this protocol closes.
      console.error("[desktop] engine Y.Doc lineage handoff failed:", error);
    });
    const clearHandoff = (): void => {
      if (replacementHandoff === handoff) replacementHandoff = null;
    };
    void handoff.then(clearHandoff, clearHandoff);
    return handoff;
  };
  acceptReplacement = queueReplacement;
  for (const replacement of replacementsBeforeOpen.splice(0)) {
    void queueReplacement(replacement);
  }

  return {
    get doc() {
      return doc;
    },
    available: true,
    objectId: opened.objectId ?? null,
    versionId: opened.versionId ?? null,
    notInVersion: false,
    engineMayHoldDocument: false,
    artifactAssetsInvalid: false,
    removalInProgress: null,
    get artifactAssets() {
      return artifactAssets;
    },
    readArtifactAsset(descriptor) {
      if (!transport.readArtifactAsset) {
        return Promise.reject(
          new Error("This document transport cannot load artifact assets."),
        );
      }
      return transport.readArtifactAsset(descriptor);
    },
    onDocumentReplaced(listener) {
      replacementListeners.add(listener);
      return () => replacementListeners.delete(listener);
    },
    destroy() {
      if (destroyPromise !== null) return destroyPromise;
      destroyed = true;
      doc.off("update", onUpdate);
      unsubscribe();
      // A close settles the engine state. Flush and await every accepted local
      // edit before close so teardown cannot settle behind the mirror. If the
      // transport stays unavailable, this promise stays pending by design.
      // Main's sender-destroyed cleanup owns a renderer-process exit.
      destroyPromise = (async () => {
        await flushPendingLocalUpdates();
        await transport.close().catch(() => undefined);
        unsubscribeReplacement();
        doc.destroy();
        for (const retired of retiredDocs) retired.destroy();
        retiredDocs.clear();
      })();
      return destroyPromise;
    },
  };
}
