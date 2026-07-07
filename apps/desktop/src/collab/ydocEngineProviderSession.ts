// WS-G2-C-2 — the ENGINE Y.Doc provider session (main-process core).
//
// This is the object that replaces the HocuspocusProvider in the editor's
// collab binding. The legacy provider synced a renderer Y.Doc to a websocket
// server; the engine provider instead binds the editor to a Y.Doc whose
// canonical state lives in the process-local engine driver session — no relay,
// no token, no network. Solo editing runs entirely on the engine; co-editing
// rides the SAME session because a remote `ydoc.update` applied by the store
// converges into `session.doc` (liveYDocRegistry routing, G2-C-1) and this
// provider forwards it to the editor.
//
// Because the engine driver is node-only (node:sqlite + the store write lane),
// the live `session.doc` lives in MAIN. The renderer's Tiptap editor binds to a
// mirror Y.Doc and the two are kept convergent over IPC: the renderer applies
// local editor updates here (applyLocalUpdate), and this core forwards remote
// CRDT deltas back (onRemoteUpdate). This module is the transport-agnostic core
// the IPC layer wraps; it is a pure node module so it unit-tests against a real
// store + real Yjs with no Electron.
//
// THE THREE G2-C-1 CONTRACTS THIS CORE HONORS (violating them re-forks the CRDT
// lineage or echo-storms every peer):
//   (a) The driver is constructed with `replicated: true` and NEVER re-seeded —
//       openSession resumes an existing lineage internally. This core only
//       BINDS to `session.doc` and lets `recordUpdate` journal LOCAL edits.
//   (b) The update observer IGNORES any update whose transaction origin ===
//       REMOTE_YDOC_APPLY_ORIGIN. Those are remote deltas the store already
//       persisted + journaled + acked; re-journaling them under a local origin
//       would push them back to every peer (an echo storm). They are forwarded
//       to the editor but never re-recorded.
//   (c) External/agent markdown edits into a live replicated doc are NOT yet
//       supported (`applyExternalMarkdownEdit` throws for replicated). This core
//       swallows that specific rejection (returns { supported: false }) so a
//       restore/agent write never crashes the live session — G2-C-3/later wires
//       external-edit-as-deltas.

import * as Y from "yjs";
import {
  REMOTE_YDOC_APPLY_ORIGIN,
  YDocEngineDriverError,
  createYDocEngineDriver,
  type VersionedTextStore,
  type YDocContentKind,
  type YDocSession,
  type YDocSettleResult,
} from "@dohc/workspace-engine";

// Reserved transaction origin for a LOCAL editor edit bridged in from the
// renderer. `applyLocalUpdate` stamps every renderer update with this origin so
// the observer can tell a real editor edit (journal it) apart from a remote
// delta the store already owns (REMOTE_YDOC_APPLY_ORIGIN — skip it).
export const LOCAL_EDITOR_ORIGIN: unique symbol = Symbol(
  "dohc.localEditorOrigin",
);

const DEFAULT_SETTLE_DEBOUNCE_MS = 800;

export interface EngineYDocProviderSessionOptions {
  store: VersionedTextStore;
  rootDir: string;
  workspaceId: string;
  versionId: string;
  path: string;
  contentKind?: YDocContentKind;
  // Forward a remote CRDT delta (origin === REMOTE_YDOC_APPLY_ORIGIN) to the
  // renderer editor doc so a co-editor's change appears live. Never called for
  // the client's own local edits (the renderer already holds those).
  onRemoteUpdate: (update: Uint8Array) => void;
  // Fired after each debounced settle with the projected markdown, so the IPC
  // layer can also write the on-disk .md (the engine.db store is a disk MIRROR
  // in the desktop; disk is where the file the user/agent sees actually lives).
  onSettled?: (result: YDocSettleResult) => void | Promise<void>;
  // Debounce a settle this long after the last update. Matches the local
  // autosave cadence (FileInspector scheduleSave, 800ms) so the editor feel is
  // unchanged.
  settleDebounceMs?: number;
  nowMs?: () => number;
  // TEST-ONLY: a swappable timer seam so a unit test can drive the debounce
  // deterministically instead of waiting real wall-clock ms.
  scheduleSettle?: (fn: () => void, ms: number) => () => void;
}

export interface EngineExternalEditResult {
  // false => the live replicated doc cannot fold this external markdown yet
  // (contract c). The caller must NOT crash — it leaves the file/CRDT as-is.
  supported: boolean;
}

export interface EngineYDocProviderSession {
  // The live engine Y.Doc (canonical while the session is open). The IPC
  // transport does not touch it directly — it bridges via initialUpdate /
  // applyLocalUpdate / onRemoteUpdate — but MU-C1 presence will bind awareness
  // to this doc, and it is the doc a remote ydoc.update converges into.
  readonly doc: Y.Doc;
  // The initial full-state update the renderer applies to its mirror doc (with
  // a non-local origin) to reach the current engine state before binding.
  readonly initialUpdate: Uint8Array;
  readonly contentKind: YDocContentKind;
  readonly path: string;
  // Bridge a renderer editor update into the live engine doc. Applied under
  // LOCAL_EDITOR_ORIGIN so the observer journals it (contract a).
  applyLocalUpdate(update: Uint8Array): void;
  // Force a settle now (e.g. on blur/close), flushing pending journaled edits
  // to the projection.
  settleNow(opts?: { summary?: string }): Promise<YDocSettleResult>;
  // Fold an external markdown edit (agent write / restore) into the live doc.
  // Returns { supported: false } gracefully for a replicated doc (contract c).
  applyExternalMarkdownEdit(markdown: string): Promise<EngineExternalEditResult>;
  // Settle (unless already quiesced) and tear down: releases the single-
  // canonical reservation so the same object can be reopened (version switch).
  close(opts?: { settle?: boolean; summary?: string }): Promise<void>;
}

// Open an engine-backed Y.Doc provider session for one rich/markdown file.
// Throws YDocEngineDriverError("invalid-input") for a secret-classified path
// (the driver refuses to open one) and "not-found" for a missing file; callers
// catch and fall back to the plain local editor.
export async function openEngineYDocProviderSession(
  options: EngineYDocProviderSessionOptions,
): Promise<EngineYDocProviderSession> {
  const {
    store,
    rootDir,
    workspaceId,
    versionId,
    path,
    contentKind,
    onRemoteUpdate,
    onSettled,
  } = options;
  const settleDebounceMs = options.settleDebounceMs ?? DEFAULT_SETTLE_DEBOUNCE_MS;
  const scheduleSettle =
    options.scheduleSettle ??
    ((fn, ms) => {
      const handle = setTimeout(fn, ms);
      return () => clearTimeout(handle);
    });

  // Construct with replicated:true (contract a): a replicated doc ALWAYS resumes
  // its existing lineage in openSession — this core never re-seeds.
  const driver = createYDocEngineDriver({ store, rootDir, replicated: true });

  let session: YDocSession;
  try {
    session = await driver.openSession({
      workspaceId,
      versionId,
      path,
      ...(contentKind ? { contentKind } : {}),
    });
  } catch (error) {
    // Release the driver's read handle before surfacing (secret-path reject,
    // missing file, already-live). Never leak a sqlite handle on a failed open.
    await driver.close().catch(() => undefined);
    throw error;
  }

  const doc = session.doc;
  let closed = false;
  // Teardown is complete ONLY after session.close (reservation release) AND
  // driver.close both succeed. A throw before then leaves this false so a retry
  // re-attempts the release instead of no-opping and stranding the reservation
  // (gate fix 5).
  let closeComplete = false;

  // Serialize journaling so ydoc_updates seq stays in emission order even under
  // rapid keystrokes (Yjs updates are commutative, but an ordered log replays
  // cleanest and keeps the resume path deterministic).
  let journalChain: Promise<void> = Promise.resolve();
  function journal(update: Uint8Array): void {
    journalChain = journalChain
      .then(() => session.recordUpdate(update))
      .then(() => undefined)
      .catch((error) => {
        // An oversized/malformed single update is rejected by recordUpdate
        // (fix 4). Swallow so one bad delta never tears down the live session;
        // the editor keeps working and the next settle re-projects clean state.
        void error;
      });
  }

  // Debounced settle: coalesce a burst of edits into one projection write, then
  // hand the markdown to the IPC layer so it can also land the on-disk .md.
  let cancelSettle: (() => void) | null = null;
  function requestSettle(): void {
    cancelSettle?.();
    cancelSettle = scheduleSettle(() => {
      cancelSettle = null;
      void runSettle();
    }, settleDebounceMs);
  }
  let settleChain: Promise<void> = Promise.resolve();
  async function runSettle(summary?: string): Promise<YDocSettleResult> {
    // Wait for pending journaling so the projection reflects every recorded
    // edit, then settle. Chained so two settles never overlap the write lane.
    await journalChain.catch(() => undefined);
    let result!: YDocSettleResult;
    settleChain = settleChain
      .then(async () => {
        result = await session.settle(summary !== undefined ? { summary } : undefined);
        await onSettled?.(result);
      })
      .catch((error) => {
        void error;
      });
    await settleChain;
    return result;
  }

  // THE OBSERVER (contract a + b). Every update the live doc emits is either a
  // local editor edit (journal it) or a remote delta the store already owns
  // (forward, never re-journal). Seeding happened inside openSession BEFORE this
  // observer attached, so no spurious seed update fires here.
  const onUpdate = (update: Uint8Array, origin: unknown): void => {
    if (closed) return;
    if (origin === REMOTE_YDOC_APPLY_ORIGIN) {
      // Contract (b): a remote ydoc.update the store persisted + journaled +
      // acked in applyReplicationOp. Re-journaling it under the local origin
      // would echo it back to every peer. Forward to the editor; never record.
      onRemoteUpdate(update);
      requestSettle();
      return;
    }
    if (origin === LOCAL_EDITOR_ORIGIN) {
      // A real editor edit bridged from the renderer. Journal it (recordUpdate
      // persists the CRDT delta AND the replicated ydoc.update op) — contract a.
      journal(update);
      requestSettle();
      return;
    }
    // Any other origin (internal, unexpected) is ignored: we only journal edits
    // that originated in the editor.
  };
  doc.on("update", onUpdate);

  const initialUpdate = Y.encodeStateAsUpdate(doc);

  return {
    doc,
    initialUpdate,
    contentKind: session.contentKind,
    path: session.path,

    applyLocalUpdate(update) {
      if (closed) return;
      // Stamp with LOCAL_EDITOR_ORIGIN so the observer journals it (and never
      // mistakes it for a remote delta). Yjs applies it to session.doc; the
      // observer then records + schedules the settle.
      Y.applyUpdate(doc, update, LOCAL_EDITOR_ORIGIN);
    },

    async settleNow(opts) {
      cancelSettle?.();
      cancelSettle = null;
      return runSettle(opts?.summary);
    },

    async applyExternalMarkdownEdit(markdown) {
      try {
        await session.applyExternalMarkdownEdit({ markdown });
        return { supported: true };
      } catch (error) {
        // Contract (c): a replicated doc rejects external markdown edits today
        // (the merge branch would reseed and fork the lineage). Handle it
        // GRACEFULLY — do not crash the live session. G2-C-3/later wires
        // external-edit-as-deltas.
        if (
          error instanceof YDocEngineDriverError &&
          error.code === "invalid-input"
        ) {
          return { supported: false };
        }
        throw error;
      }
    },

    async close(opts) {
      // Already fully torn down: nothing to do (idempotent). A PARTIALLY-closed
      // session (close threw) is NOT short-circuited here — it retries below.
      if (closeComplete) return;
      // Stop the observer + reject new local edits immediately, even across a
      // retry (doc.off is idempotent).
      closed = true;
      cancelSettle?.();
      cancelSettle = null;
      doc.off("update", onUpdate);
      // Drain pending journaling so close settles the fully-recorded state.
      await journalChain.catch(() => undefined);
      await settleChain.catch(() => undefined);
      // session.close releases the single-canonical reservation. A throw here
      // PROPAGATES (never swallowed): the reservation may still be held, so the
      // caller must retain a failing-close guard and retry — reaching
      // driver.close + closeComplete only once the release actually succeeds.
      await session.close(opts);
      // Release the driver's read handle only after a successful release.
      await driver.close().catch(() => undefined);
      closeComplete = true;
    },
  };
}
