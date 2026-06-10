import { mergeMarkdown } from "@dohc/workspace-history";

// Canonical-state model for live co-editing (plan Phase 10, decision D-07).
//
// Local-first invariant: the FILE on disk is canonical while a shared document
// is CLOSED. The moment a shared doc has a live collab session, the Yjs CRDT
// becomes canonical — we hold edits in the Y.Text and only project ("settle")
// them back to the file at a materialization point. This module is pure logic:
// no Yjs, no filesystem, no provider. It decides WHEN to materialize, HOW to
// recognise a write the desktop itself made (so the watcher doesn't loop it
// back into the doc), and WHAT to do when the file changed on disk outside Yjs
// while a session is live. The Y.Doc-level convergence test lives in the test
// file (it exercises real Yjs, which is the canonical proof of that property).
//
// "Preserves both versions" is the floor. Silent loss is never acceptable.

// A SHA of the exact text last materialized to disk, recorded per
// materialization so a later watcher/sync event can be recognised as our own
// write and suppressed (no materialize -> watch -> materialize loop).
export type MaterializationRecord = {
  // Hex sha256 of the text we wrote.
  sha: string;
  // When it was written (ms). Useful for ordering; the sha is the identity.
  atMs: number;
};

export type CollabSessionState = {
  // True while a HocuspocusProvider is connected for this doc (the CRDT is
  // canonical). False once the session is torn down (file is canonical again).
  active: boolean;
  // The last text we projected from the CRDT to the file, and its sha. null
  // before the first materialization.
  lastMaterialized: MaterializationRecord | null;
};

export function createCollabSessionState(): CollabSessionState {
  return { active: false, lastMaterialized: null };
}

// CASE 1 (active-while-open): the CRDT is canonical WHILE a shared doc has a
// live session. We only project to the file at a settle point — never on every
// keystroke (that would thrash the disk and race the watcher). A settle point
// is: the doc has unsynced-to-disk content AND a trigger fired (debounce
// elapsed, the session is closing, or an explicit save). This mirrors Phase 8's
// isDatabaseMaterializationPoint predicate.
export type MaterializeTrigger = "settle-debounce" | "session-close" | "explicit-save";

export function shouldMaterialize(input: {
  state: CollabSessionState;
  // The current CRDT text and the text currently on disk (last known).
  docText: string;
  onDiskText: string;
  trigger: MaterializeTrigger;
}): boolean {
  const { state, docText, onDiskText, trigger } = input;
  // No session => the file is already canonical; the normal local editor owns
  // writes, not this model.
  if (!state.active && trigger !== "session-close") return false;
  // Nothing to write if the doc already equals disk.
  if (docText === onDiskText) return false;
  // And nothing to write if we already materialized exactly this text (the
  // disk just hasn't been re-read yet) — avoids a redundant self-write.
  if (state.lastMaterialized && sha256Hex(docText) === state.lastMaterialized.sha) {
    return false;
  }
  // Any of the three triggers, with real pending content, is a settle point.
  return (
    trigger === "settle-debounce" ||
    trigger === "session-close" ||
    trigger === "explicit-save"
  );
}

// Records that we materialized `text` to disk (CASE 2: base-hash per
// materialization). The returned state carries the sha so a subsequent watcher
// event for that exact content is recognised as self-produced.
export function recordMaterialization(
  state: CollabSessionState,
  text: string,
  atMs: number,
): CollabSessionState {
  return { ...state, lastMaterialized: { sha: sha256Hex(text), atMs } };
}

// CASE 3 (watcher suppression of self-materialized writes): when the watcher
// observes a file change with sha `observedSha`, and that equals the sha we
// just materialized, the change is our own projection bouncing back — the sync
// engine / doc-reconciler MUST suppress it. Otherwise: materialize -> watch ->
// treat as external -> re-apply to doc -> materialize -> ... forever.
export function isSelfMaterializedWrite(
  observedSha: string,
  lastMaterialized: MaterializationRecord | null,
): boolean {
  return lastMaterialized !== null && observedSha === lastMaterialized.sha;
}

// CASE 4 (external-edit-during-session): the file changed on disk OUTSIDE Yjs
// while the doc is open (e.g. a local agent edited it, or a cloud sync pull
// wrote it). We must fold that change into the live doc WITHOUT losing either
// the external edit or the in-flight CRDT edits, and WITHOUT emitting git
// conflict markers. Three-way merge against the text we last materialized:
//   base   = lastMaterializedText (the common ancestor both sides diverged from)
//   local  = docText (what the CRDT holds now)
//   remote = onDiskText (the external edit)
// A clean merge -> apply the merged text into the doc. An overlapping change ->
// conflict: preserve BOTH verbatim, surface a conflict, never silently pick one.
export type ExternalEditResolution =
  | { kind: "no-op" }
  | { kind: "merge-into-doc"; mergedText: string }
  | { kind: "conflict"; docText: string; onDiskText: string };

export function reconcileExternalEdit(input: {
  onDiskText: string;
  lastMaterializedText: string | null;
  docText: string;
  // The sha of the on-disk text (so a self-materialized bounce is a no-op).
  observedSha?: string;
  lastMaterialized?: MaterializationRecord | null;
}): ExternalEditResolution {
  const { onDiskText, lastMaterializedText, docText } = input;

  // A write we produced ourselves is not an external edit — suppress it.
  if (
    input.observedSha !== undefined &&
    isSelfMaterializedWrite(input.observedSha, input.lastMaterialized ?? null)
  ) {
    return { kind: "no-op" };
  }
  // Disk already matches the doc: nothing to fold in.
  if (onDiskText === docText) return { kind: "no-op" };

  // No common ancestor yet (never materialized): we can't safely 3-way merge,
  // so if the doc has its own divergent content we must preserve both. If the
  // doc is still empty/untouched, adopt the on-disk text as the starting point.
  if (lastMaterializedText === null) {
    if (docText.length === 0) return { kind: "merge-into-doc", mergedText: onDiskText };
    return { kind: "conflict", docText, onDiskText };
  }

  const merged = mergeMarkdown({
    base: lastMaterializedText,
    local: docText,
    remote: onDiskText,
  });
  if (merged.kind === "merged") {
    if (merged.content === docText) return { kind: "no-op" };
    return { kind: "merge-into-doc", mergedText: merged.content };
  }
  return { kind: "conflict", docText, onDiskText };
}

// CASE 6 (rename/delete with a live doc): a file with an active session is
// renamed or deleted on disk. Safe behavior: close the session and, if the doc
// holds content the file no longer reflects, materialize-last-good to a
// rescue file rather than dropping it. We never write into a path that no
// longer exists under its old name, and we never silently lose the doc text.
export type FileLifecycleEvent =
  | { kind: "renamed"; from: string; to: string }
  | { kind: "deleted"; path: string };

export type LifecycleResolution =
  | { kind: "follow-rename"; newPath: string }
  | { kind: "rescue"; rescuePath: string; text: string }
  | { kind: "close-clean" };

export function resolveFileLifecycle(input: {
  event: FileLifecycleEvent;
  docText: string;
  lastMaterializedText: string | null;
}): LifecycleResolution {
  const { event, docText, lastMaterializedText } = input;
  const docMatchesDisk = lastMaterializedText !== null && docText === lastMaterializedText;

  if (event.kind === "renamed") {
    // The session follows the file to its new path (the atom id is stable on
    // the server; locally we just retarget). No data is at risk.
    return { kind: "follow-rename", newPath: event.to };
  }
  // Deleted: if the doc still holds unmaterialized content, rescue it to an
  // explicit sibling file so the work is preserved and obviously visible.
  if (!docMatchesDisk && docText.length > 0) {
    return { kind: "rescue", rescuePath: rescuePathFor(event.path), text: docText };
  }
  // The doc held nothing the disk didn't already have — closing loses nothing.
  return { kind: "close-clean" };
}

// A rescue file sits next to the deleted one with an unmistakable suffix, so it
// reads as "your recovered work", never as normal content (mirrors the
// .conflict naming rule from the sync engine).
export function rescuePathFor(deletedPath: string): string {
  const dot = deletedPath.lastIndexOf(".");
  if (dot <= deletedPath.lastIndexOf("/")) return `${deletedPath}.recovered`;
  return `${deletedPath.slice(0, dot)}.recovered${deletedPath.slice(dot)}`;
}

// Synchronous FNV-1a-seeded-then-SHA-shaped hash is overkill; we want the SAME
// sha256 the watcher/workspace-fs uses so shas compare equal across layers.
// workspace-fs exposes sha256 over node:crypto; here in the renderer we keep a
// tiny, dependency-free, deterministic hex digest. The model only requires
// that equal text -> equal sha and that the watcher compares against shas this
// function produced (the desktop wiring records via this same function). The
// production wiring substitutes the real workspace-fs sha256 through
// configureSha so cross-layer comparisons hold; tests use the default.
let shaImpl: (text: string) => string = fallbackSha;
export function configureSha(fn: (text: string) => string): void {
  shaImpl = fn;
}
export function sha256Hex(text: string): string {
  return shaImpl(text);
}

// Deterministic content hash used when no real sha256 is injected (unit tests
// and renderer-only paths). Not cryptographic — only needs collision-resistance
// good enough to distinguish document revisions; the security-relevant compare
// (self-write suppression) is reinforced by the injected real sha256 in
// production.
function fallbackSha(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}
