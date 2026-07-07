import { useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import { bridge } from "../bridge";
import {
  bindEngineYDoc,
  type EngineYDocBinding,
  type EngineYDocTransport,
} from "./engineYDocProvider";

// WS-G2-C-2 — the engine Y.Doc editor hook (the sibling to useCollabDoc, and its
// replacement for rich-text files). Given a workspace + rich file, it opens a
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

export type EngineDocSaveState = "saved" | "saving";

export type UseEngineDoc = {
  // True once the engine session is open and the mirror doc is bound. false =>
  // fall back to the local autosave editor.
  available: boolean;
  // The mirror Y.Doc Tiptap binds to; null until bound / when unavailable.
  doc: Y.Doc | null;
  // Approximated settle indicator so the editing feel matches local autosave:
  // "saving" while a keystroke burst is in flight, "saved" once the main-side
  // debounced settle has projected it (the engine.db + .md are the authority —
  // this is a cosmetic cue, not the durability contract).
  saveState: EngineDocSaveState;
};

// A hair longer than the main-side settle debounce (800ms) so "Saved" only shows
// once main has had time to project + write the .md.
const SETTLE_INDICATOR_MS = 1000;

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
      // (or close) re-converges.
      void bridge().applyEngineYDocUpdate({ sessionId, update }).catch(() => undefined);
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
    let saveTimer: ReturnType<typeof setTimeout> | null = null;

    setAvailable(false);
    setDoc(null);
    setSaveState("saved");

    const sessionId = nextSessionId();
    const transport = makeTransport(workspaceId, path, sessionId);

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
        // Approximate the settle indicator from mirror-doc activity: any update
        // (a local keystroke burst) flips to "saving"; after a debounce past the
        // main-side settle, back to "saved". The seed apply happened before this
        // observer attached, so it never shows a spurious "saving".
        const onUpdate = () => {
          if (cancelled) return;
          setSaveState("saving");
          if (saveTimer) clearTimeout(saveTimer);
          saveTimer = setTimeout(() => {
            if (!cancelled) setSaveState("saved");
          }, SETTLE_INDICATOR_MS);
        };
        bound.doc.on("update", onUpdate);
        detachSaveObserver = () => bound.doc?.off("update", onUpdate);
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
      if (saveTimer) clearTimeout(saveTimer);
      detachSaveObserver?.();
      // Settle + close the engine session in main (releases the single-canonical
      // reservation so a version/file switch can reopen the same object), then
      // drop the mirror doc.
      void binding?.destroy();
    };
    // input is destructured; re-open only when the workspace, path, or gate
    // changes — never on unrelated re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.workspaceId, input.path, input.enabled]);

  return { available, doc, saveState };
}
