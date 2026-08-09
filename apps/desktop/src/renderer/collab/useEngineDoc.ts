import { useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import { bridge } from "../bridge";
import {
  bindEngineYDoc,
  type EngineYDocBinding,
  type EngineYDocTransport,
} from "./engineYDocProvider";

// The engine Y.Doc editor hook for rich-text files. Given a workspace + rich
// file, it opens a
// live engine Y.Doc session in MAIN over IPC and binds a mirror Y.Doc the Tiptap
// Collaboration extension drives via its "body" XmlFragment — no websocket, no
// token, no cloud. Solo editing runs entirely on the engine; a co-editor's edit
// arrives as a forwarded remote delta on the same channel.
//
// available:false AND opening:false => the doc is NOT engine-backed (unflagged
// workspace, secret path, or already live) — the caller stays on the plain
// local autosave editor showing the real on-disk content. While opening:true
// the answer is not known yet and the caller must stay read-only. The other
// exception is `notInVersion`, where the answer IS known and the caller must
// stop editing rather than fall back (#534). Undo/redo is intact: the
// Collaboration extension bundles the Yjs UndoManager binding (COLLAB_STARTER_KIT
// disables the plain history), so Mod-z/Mod-y drive the CRDT undo stack.
//
// Renderer async-state invariant (product invariant): every open response is
// guarded by the per-open request token (a monotonic id + the effect's cancelled
// flag). A slow open for workspace/path A can never bind or repaint after the
// user has switched to B — the stale response is dropped and its session closed.

// "error" = a settle FAILED, so the file on disk is behind what the editor
// shows. "file-locked" = the same stale disk, but transient by contract:
// another program holds the file's handle and the engine retries until it
// releases (#554), so the copy names the blocker instead of advising an edit.
// "read-only" = the workspace is a read-only shared view and the edit
// was discarded outright; retrying cannot help, so it gets its own copy.
// "changed-on-disk" = the file was edited outside dohc while this document was
// open, and dohc kept that edit instead of overwriting it (#338).
// None is ever inferred — main pushes all of them from real outcomes.
export type EngineDocSaveState =
  | "saved"
  | "saving"
  | "error"
  | "file-locked"
  | "read-only"
  | "changed-on-disk"
  | "deleted";

export type EngineRemovalInProgress = {
  operation: "delete" | "move";
  message: string;
};

export type UseEngineDoc = {
  // True once the engine session is open and the mirror doc is bound. false =>
  // fall back to the local autosave editor, but ONLY once `opening` is false.
  available: boolean;
  // No open has answered for the CURRENT request yet (#533). "Opening" and
  // "not engine-backed" used to be the same `available: false`, so the caller
  // showed its writable plain editor — whose autosave writes straight to disk
  // — for the whole wait. On a workspace whose capture chain is busy (startup
  // reconciliation, a version switch) that wait is seconds, and every keystroke
  // in it took a path the about-to-bind session never sees: the session then
  // seeds from a head without them. True on the first render of an open AND on
  // the first render after the request changes under a bound document (a
  // version switch), because both are the same unanswered question.
  // The caller must offer no writable surface while this is true.
  opening: boolean;
  // The mirror Y.Doc Tiptap binds to; null until bound / when unavailable.
  doc: Y.Doc | null;
  // The document's REAL save state. "saving" the moment an edit is made,
  // "saved" ONLY when main reports a settle that covered that edit actually
  // committed and wrote the .md, "error" when a settle failed. This used to be
  // a 1s timer that flipped to "saved" regardless of what the engine did —
  // three dogfood journeys watched a doc read "Saved" over a zero-byte file.
  saveState: EngineDocSaveState;
  // The path is not in the version this workspace is on: a version switch
  // removed it while this open was queued behind that switch (#534). Unlike
  // every other available:false the caller must NOT fall back to the writable
  // plain editor, whose autosave would write the file back into the version the
  // user just entered.
  notInVersion: boolean;
  // The open did not land and a session for this document may still be the
  // engine's (#564, #657). Same no-downgrade rule as notInVersion: the caller
  // stays read-only, states the reason, and offers a retry (bump retryKey),
  // which is also what discharges what the failure left behind.
  engineMayHoldDocument: boolean;
  // Main confirmed that it removed this file while the live session was
  // bound. The current document is retained for recovery only.
  deletedWhileEditing: boolean;
  // An open lost to a delete or move interval. This is not a terminal outcome:
  // the operation can still fail, so the caller stays read-only and retries.
  removalInProgress: EngineRemovalInProgress | null;
};

// What ONE open answers: a workspace, a path, the gate, and the active-version
// token. Everything this hook returns belongs to exactly one of these. JSON
// quotes each part, so two different requests cannot produce one key.
function engineDocRequestKey(input: {
  workspaceId: string;
  path: string;
  enabled: boolean;
  reopenKey?: number;
  retryKey?: number;
}): string {
  return JSON.stringify([
    input.enabled,
    input.workspaceId,
    input.path,
    input.reopenKey ?? null,
    input.retryKey ?? null,
  ]);
}

// The settled result of one open, stamped with the request it answers.
type EngineDocOpenOutcome =
  | { key: string; kind: "bound"; doc: Y.Doc }
  | { key: string; kind: "unavailable" }
  // Their OWN kinds, not flags on "unavailable": every other unavailable
  // answer means "fall back to the plain editor", and these two mean the
  // opposite (#534, #564). Collapsing them would put the branches back
  // behind one flag.
  | { key: string; kind: "not-in-version" }
  | { key: string; kind: "engine-may-hold-document" }
  | { key: string; kind: "removal-in-progress"; removal: EngineRemovalInProgress };

let engineDocSessionCounter = 0;
function nextSessionId(): string {
  engineDocSessionCounter += 1;
  // Bounded (< 64 chars) + unique per open, like the search searchId.
  return `eyd-${Date.now().toString(36)}-${engineDocSessionCounter.toString(36)}`;
}

function makeTransport(
  workspaceId: string,
  path: string,
  sessionId: string,
  // Monotonic local-edit counter, shared with the save-state listener: main
  // echoes back the seq each settle STARTED at, and only a settle that covers
  // the newest edit may be reported as "Saved".
  localSeq: { current: number },
  writesRefused: { current: boolean },
): EngineYDocTransport {
  return {
    async open() {
      const result = await bridge().openEngineYDocSession({
        workspaceId,
        path,
        sessionId,
      });
      return {
        available: result.available,
        ...(result.initialUpdate ? { initialUpdate: result.initialUpdate } : {}),
        ...(result.notInVersion ? { notInVersion: true } : {}),
        ...(result.engineMayHoldDocument ? { engineMayHoldDocument: true } : {}),
        ...(result.removalInProgress
          ? { removalInProgress: result.removalInProgress }
          : {}),
      };
    },
    applyLocalUpdate(update) {
      if (writesRefused.current) return;
      // Fire-and-forget: main journals + settles. A transient IPC error never
      // tears the editor down; the mirror doc keeps the edit and the next update
      // (or close) re-converges. The seq is NOT rolled back on that failure —
      // the edit is genuinely unsaved until a later settle covers it, and the
      // indicator must keep saying so.
      localSeq.current += 1;
      const seq = localSeq.current;
      void bridge()
        .applyEngineYDocUpdate({ sessionId, update, seq })
        .catch(() => undefined);
    },
    onRemoteUpdate(listener) {
      return bridge().onEngineYDocRemoteUpdate((event) => {
        if (event.sessionId !== sessionId) return;
        listener(event.update);
      });
    },
    async close() {
      await bridge().closeEngineYDocSession({ sessionId }).catch(() => undefined);
    },
  };
}

export function useEngineDoc(input: {
  workspaceId: string;
  path: string;
  // The caller gates: only a rich (markdown) file that is not truncated / read-
  // only opens an engine session. Everything else keeps the local editor.
  enabled: boolean;
  // Bump to retry after `engineMayHoldDocument` (#564): part of the request
  // key, so a retry is a fresh open with the same stale-response guard as any
  // other.
  retryKey?: number;
  // G2-C-3 version-switch re-bind: a monotonic token that changes whenever the
  // ACTIVE VERSION of this workspace changes while the SAME file stays open
  // (the shell's versionEpoch). The session keys on it so switching version
  // flushes+closes the current engine session and reopens it against the
  // now-active version's Y.Doc lineage — resume-never-reseed for a replicated
  // doc (the durable lineage), reseed-from-the-new-file for a local-only doc
  // (switchVersion already materialized the new version onto disk before this
  // reopens). Undefined/stable => no reopen; ordinary history growth in the
  // SAME version must NOT bump this (that would churn the live session).
  reopenKey?: number;
}): UseEngineDoc {
  const requestKey = engineDocRequestKey(input);
  const [outcome, setOutcome] = useState<EngineDocOpenOutcome | null>(null);
  const [saveState, setSaveState] = useState<EngineDocSaveState>("saved");
  const [deletedRequestKey, setDeletedRequestKey] = useState<string | null>(null);
  // Monotonic per-open token: only the newest open may set state (the async-
  // state invariant — a stale workspace/path response never repaints).
  const openTokenRef = useRef(0);

  // DERIVED DURING RENDER, never set by an effect. An effect runs after the
  // render that scheduled it, so an effect-set flag is one frame late — and
  // that frame is the whole defect. When the version switches under an open
  // document (`reopenKey`), the render that carries the new token would
  // otherwise still report the PREVIOUS version's `available`/`doc`: one
  // committed frame of an editable, already-closed session, whose keystrokes
  // go to an obsolete session. A result only counts for the request it
  // answers, so switching request answers "opening" the instant it happens.
  const settled = outcome !== null && outcome.key === requestKey ? outcome : null;
  const available = settled?.kind === "bound";
  const doc = settled?.kind === "bound" ? settled.doc : null;
  const opening = input.enabled && settled === null;
  // Derived from the same settled result, so it is subject to the same
  // request-identity rule: a refusal for the version the user just LEFT never
  // repaints the document they just entered.
  const notInVersion = settled?.kind === "not-in-version";
  const engineMayHoldDocument = settled?.kind === "engine-may-hold-document";
  const removalInProgress =
    settled?.kind === "removal-in-progress" ? settled.removal : null;
  const deletedWhileEditing =
    settled?.kind === "bound" && deletedRequestKey === requestKey;
  const writesRefused = useRef(false);
  const writesRefusedKey = useRef(requestKey);
  if (writesRefusedKey.current !== requestKey) {
    writesRefusedKey.current = requestKey;
    writesRefused.current = false;
  }
  if (deletedWhileEditing || removalInProgress !== null) {
    writesRefused.current = true;
  }

  useEffect(() => {
    setSaveState("saved");
    if (!input.enabled) return;
    const { workspaceId, path } = input;
    // The key of the render that scheduled this effect — the request this open
    // answers. Stamped onto the result so a render can tell whether the result
    // it holds is still the one it asked for.
    const key = requestKey;
    const token = ++openTokenRef.current;
    let cancelled = false;
    let binding: EngineYDocBinding | null = null;
    let detachSaveObserver: (() => void) | null = null;
    let unsubscribeSaveState: (() => void) | null = null;

    const sessionId = nextSessionId();
    const localSeq = { current: 0 };
    const transport = makeTransport(
      workspaceId,
      path,
      sessionId,
      localSeq,
      writesRefused,
    );

    void bindEngineYDoc(transport)
      .then((bound) => {
        // A newer open (workspace/path switch) superseded this one, or the effect
        // already cleaned up: never bind the stale doc — close it and bail.
        if (cancelled || token !== openTokenRef.current) {
          void bound.destroy();
          return;
        }
        binding = bound;
        if (!bound.available || !bound.doc) {
          // Resolved: NOT engine-backed. The caller may offer the plain local
          // editor again — that is what `opening` was holding back. EXCEPT
          // when the path is not in this version, where offering it would
          // write the phantom the engine just refused (#534), and when the
          // engine may still hold the document, where a plain autosave would
          // race the session it still binds (#564, #657).
          if (bound.notInVersion) {
            setOutcome({ key, kind: "not-in-version" });
          } else if (bound.engineMayHoldDocument) {
            setOutcome({ key, kind: "engine-may-hold-document" });
          } else if (bound.removalInProgress) {
            setOutcome({
              key,
              kind: "removal-in-progress",
              removal: bound.removalInProgress,
            });
          } else {
            setOutcome({ key, kind: "unavailable" });
          }
          return;
        }
        // An edit is unsaved the instant it happens. Only main's settle report
        // may clear it — nothing here guesses "saved". The seed apply happened
        // before this observer attached, so it never shows a spurious "saving".
        const onUpdate = () => {
          if (cancelled) return;
          if (writesRefused.current) return;
          setSaveState("saving");
        };
        bound.doc.on("update", onUpdate);
        detachSaveObserver = () => bound.doc?.off("update", onUpdate);
        // Subscribe only once the session is CONFIRMED live. Nothing can be
        // missed by waiting: a settle needs an edit, and an edit needs this
        // bound doc. Doing it here also keeps every bridge call inside the
        // caught region — a synchronous call in the effect body turned a
        // bridge without this method (an older preload, a test double) from
        // graceful "not engine-backed" into a blanked editor.
        // Guarded by the per-open token AND the per-open sessionId (the
        // async-state invariant): another document's settle never repaints.
        unsubscribeSaveState = bridge().onEngineYDocSaveState((event) => {
          if (cancelled || token !== openTokenRef.current) return;
          if (event.sessionId !== sessionId) return;
          // Deletion is terminal for this session. A settle/update already in
          // flight can report after main's deletion notice, but it no longer
          // describes a path that exists and must not repaint this state.
          if (writesRefused.current && event.state !== "deleted") return;
          if (event.state === "deleted") {
            // Refuse transport writes synchronously. React can take a render
            // to make Tiptap read-only, but no keystroke in that gap may reach
            // main and recreate the path.
            writesRefused.current = true;
            setDeletedRequestKey(key);
            setSaveState("deleted");
            return;
          }
          // `file-locked` is the one refusal that makes a DURABILITY claim:
          // its copy tells the user dohc has their edits and is retrying. So
          // it may only stand for a settle that carries the newest edit. A
          // keystroke still in flight means this refusal is about older text,
          // and showing it would promise safety for a sequence the settle
          // never covered. Same guard "saved" uses, for the same reason —
          // keep "Saving…" until an event covers the newest edit.
          if (event.state === "file-locked") {
            if (event.seq >= localSeq.current) setSaveState(event.state);
            return;
          }
          // These claim nothing about what is held — "error" says the opposite
          // — so they stand as soon as they arrive, whatever is in flight.
          if (
            event.state === "error" ||
            event.state === "read-only" ||
            event.state === "changed-on-disk"
          ) {
            setSaveState(event.state);
            return;
          }
          if (event.state === "settling") {
            setSaveState("saving");
            return;
          }
          // "saved" vouches only for edits journaled before that settle began.
          // Anything typed since is still unsaved — keep showing "Saving…".
          if (event.seq >= localSeq.current) {
            setSaveState("saved");
          }
        });
        setOutcome({ key, kind: "bound", doc: bound.doc });
      })
      .catch(() => {
        if (cancelled || token !== openTokenRef.current) return;
        setOutcome({ key, kind: "unavailable" });
      });

    return () => {
      cancelled = true;
      unsubscribeSaveState?.();
      detachSaveObserver?.();
      // Settle + close the engine session in main (releases the single-canonical
      // reservation so a version/file switch can reopen the same object), then
      // drop the mirror doc.
      void binding?.destroy();
      // The result dies with the session it describes. Without this, a request
      // that comes BACK to a key it held before (a truncated read that reloads
      // whole, so `enabled` goes false then true) would match the old outcome
      // and hand the caller an editable doc this cleanup already destroyed.
      setOutcome(null);
    };
    // input is destructured; re-open only when the workspace, path, gate, or the
    // active-version token changes — never on unrelated re-renders. reopenKey
    // re-binds the editor to the new version's lineage on a version switch
    // (server-side switchVersion already settled+closed the old session and
    // materialized the new version to disk; this effect's cleanup settles+closes
    // the renderer's mirror session and the re-run opens a fresh one, guarded by
    // the per-open token so a stale response never repaints).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.workspaceId, input.path, input.enabled, input.reopenKey, input.retryKey]);

  return {
    available,
    opening,
    doc,
    saveState,
    notInVersion,
    engineMayHoldDocument,
    deletedWhileEditing,
    removalInProgress,
  };
}
