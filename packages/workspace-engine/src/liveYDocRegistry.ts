// WS-G2-C1 — the process-global live-Y.Doc registry (fix 3: never settle a
// stale live doc over newer replicated CRDT).
//
// A replicated rich doc that is OPEN in a Y.Doc session has its canonical state
// in an in-memory Y.Doc owned by the driver session. When a REMOTE ydoc.update
// arrives via applyReplicationOp, the store persists the CRDT rows and re-
// projects the markdown — but the LIVE in-memory doc would stay stale, and on
// session close that stale doc would settle OVER the freshly pulled projection
// and (previously) prune the newer CRDT rows, silently dropping the remote edit.
//
// To keep the live doc convergent, the driver registers each live session's
// Y.Doc here under the SAME key the single-canonical reservation uses
// (`enginePath workspaceId objectId`), and the store routes an applied remote
// update straight into that live doc with Y.applyUpdate. Yjs apply is
// commutative + idempotent, so the live doc converges with the persisted rows;
// the eventual close then settles the CONVERGED state, never a stale one.
//
// This lives in its own module (not in the driver or the store) so BOTH can
// import it without a circular dependency: ydocEngineDriver imports from
// versionedTextStore (canonicalEngineDbPath), and versionedTextStore must reach
// the live doc from applyReplicationOp — routing through this leaf module keeps
// the dependency graph acyclic.

import type * as Y from "yjs";

export { REMOTE_YDOC_APPLY_ORIGIN } from "@dohc/workspace-contracts/engine";

// Keyed exactly like the driver's globalReservationKey so a store and a driver
// on one physical engine.db agree on identity. The parts are joined with a NUL
// separator (matching the driver's reservation key) so no path/id containing a
// space can collide two distinct docs into one key.
export function liveYDocKey(
  enginePath: string,
  workspaceId: string,
  objectId: string,
): string {
  return `${enginePath}\u0000${workspaceId}\u0000${objectId}`;
}

const liveYDocs = new Map<string, Y.Doc>();

// Register the live in-memory Y.Doc for an open replicated session. The single-
// canonical reservation guarantees at most one live doc per key, so a plain Map
// set is safe (a second live session for the same object is already refused).
export function registerLiveYDoc(key: string, doc: Y.Doc): void {
  liveYDocs.set(key, doc);
}

export function unregisterLiveYDoc(key: string): void {
  liveYDocs.delete(key);
}

export function getLiveYDoc(key: string): Y.Doc | undefined {
  return liveYDocs.get(key);
}
