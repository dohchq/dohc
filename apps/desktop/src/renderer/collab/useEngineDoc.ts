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
// available:false => the doc is NOT engine-backed (unflagged workspace, secret
// path, missing file, or already live) — the caller stays on the plain local
// autosave editor showing the real on-disk content. Undo/redo is intact: the
// Collaboration extension bundles the Yjs UndoManager binding (COLLAB_STARTER_KIT
// disables the plain history), so Mod-z/Mod-y drive the CRDT undo stack.
//
// Renderer async-state invariant (product invariant): every open response is
// guarded by the per-open request token (a monotonic id + the effect's cancelled
// flag). A slow open for workspace/path A can never bind or repaint after the
// user has switched to B — the stale response is dropped and its session closed.

// "error" = a settle FAILED, so the file on disk is behind what the editor
// shows. "read-only" = the workspace is a read-only shared view and the edit
// was discarded outright; retrying cannot help, so it gets its own copy.
// "changed-on-disk" = the file was edited outside dohc while this document was
// open, and dohc kept that edit instead of overwriting it (#338).
// None is ever inferred — main pushes all of them from real outcomes.
export type EngineDocSaveState =
  | "saved"
  | "saving"
  | "error"
  | "read-only"
  | "changed-on-disk";

export type UseEngineDoc = {
  // True once the engine session is open and the mirror doc is bound. false =>
  // fall back to the local autosave editor.
  available: boolean;
  // The mirror Y.Doc Tiptap binds to; null until bound / when unavailable.
  doc: Y.Doc | null;
  // The document's REAL save state. "saving" the moment an edit is made,
  // "saved" ONLY when main reports a settle that covered that edit actually
  // committed and wrote the .md, "error" when a settle failed. This used to be
  // a 1s timer that flipped to "saved" regardless of what the engine did —
  // three dogfood journeys watched a doc read "Saved" over a zero-byte file.
  saveState: EngineDocSaveState;
};

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
      };
    },
    applyLocalUpdate(update) {
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
  const [doc, setDoc] = useState<Y.Doc | null>(null);
  const [available, setAvailable] = useState(false);
  const [saveState, setSaveState] = useState<EngineDocSaveState>("saved");
  // Monotonic per-open token: only the newest open may set state (the async-
  // state invariant — a stale workspace/path response never repaints).
  const openTokenRef = useRef(0);

  useEffect(() => {
    if (!input.enabled) {
      setAvailable(false);
      setDoc(null);
      setSaveState("saved");
      return;
    }
    const { workspaceId, path } = input;
    const token = ++openTokenRef.current;
    let cancelled = false;
    let binding: EngineYDocBinding | null = null;
    let detachSaveObserver: (() => void) | null = null;
    let unsubscribeSaveState: (() => void) | null = null;

    setAvailable(false);
    setDoc(null);
    setSaveState("saved");

    const sessionId = nextSessionId();
    const localSeq = { current: 0 };
    const transport = makeTransport(workspaceId, path, sessionId, localSeq);

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
          setAvailable(false);
          setDoc(null);
          return;
        }
        // An edit is unsaved the instant it happens. Only main's settle report
        // may clear it — nothing here guesses "saved". The seed apply happened
        // before this observer attached, so it never shows a spurious "saving".
        const onUpdate = () => {
          if (cancelled) return;
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
          if (event.seq >= localSeq.current) setSaveState("saved");
        });
        setDoc(bound.doc);
        setAvailable(true);
      })
      .catch(() => {
        if (cancelled || token !== openTokenRef.current) return;
        setAvailable(false);
        setDoc(null);
      });

    return () => {
      cancelled = true;
      unsubscribeSaveState?.();
      detachSaveObserver?.();
      // Settle + close the engine session in main (releases the single-canonical
      // reservation so a version/file switch can reopen the same object), then
      // drop the mirror doc.
      void binding?.destroy();
    };
    // input is destructured; re-open only when the workspace, path, gate, or the
    // active-version token changes — never on unrelated re-renders. reopenKey
    // re-binds the editor to the new version's lineage on a version switch
    // (server-side switchVersion already settled+closed the old session and
    // materialized the new version to disk; this effect's cleanup settles+closes
    // the renderer's mirror session and the re-run opens a fresh one, guarded by
    // the per-open token so a stale response never repaints).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.workspaceId, input.path, input.enabled, input.reopenKey]);

  return { available, doc, saveState };
}
