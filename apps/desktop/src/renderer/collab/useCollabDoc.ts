import { HocuspocusProvider } from "@hocuspocus/provider";
import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { bridge } from "../bridge";

// Live co-editing hook for the desktop markdown editor. Given a workspace +
// path, it asks main for a collab token (only minted for SHARED cloud
// workspaces with a signed-in session — see the collabToken IPC), connects a
// HocuspocusProvider to the returned websocket URL, and binds a single Y.Text
// ("content") that the textarea reads/writes. When the workspace is
// personal/local-only or signed out, main returns available:false and this hook
// is a clean no-op: enabled=false, the editor stays on the existing local
// autosave path, byte-identical to today.
//
// Anti-bloat (lead's choice): Y.Text + textarea + awareness. No Tiptap, no
// y-indexeddb — the desktop's offline copy is the FILE on disk, not IndexedDB,
// so Yjs offline convergence on reconnect is enough.

export type CollabStatus = "disabled" | "connecting" | "connected" | "disconnected";

export type UseCollabDoc = {
  // True only once a live shared session is connected; the editor switches to
  // collab mode on this flag. false => use the local autosave editor.
  enabled: boolean;
  status: CollabStatus;
  // The live document text and the writer the textarea calls onChange with.
  text: string;
  setText: (next: string) => void;
  // How many OTHER editors are present (this client is excluded).
  peerCount: number;
};

export function useCollabDoc(input: {
  workspaceId: string;
  path: string;
  // The renderer only attempts collab for text/markdown files; binary/sqlite
  // never CRDT-syncs. Caller passes false to keep this a no-op for those.
  enabled: boolean;
}): UseCollabDoc {
  const [status, setStatus] = useState<CollabStatus>("disabled");
  const [text, setTextState] = useState("");
  const [peerCount, setPeerCount] = useState(0);
  // The live Y.Text for the connected session; null when not in collab mode.
  const yTextRef = useRef<Y.Text | null>(null);

  useEffect(() => {
    if (!input.enabled) {
      setStatus("disabled");
      return;
    }
    let cancelled = false;
    let provider: HocuspocusProvider | null = null;
    let doc: Y.Doc | null = null;
    let yText: Y.Text | null = null;
    let detachObservers: (() => void) | null = null;

    setStatus("connecting");
    setPeerCount(0);

    void bridge()
      .collabToken({ workspaceId: input.workspaceId, relativePath: input.path })
      .then((result) => {
        if (cancelled) return;
        if (!result.available) {
          // Not a shared cloud workspace (or signed out) — stay local.
          setStatus("disabled");
          return;
        }

        doc = new Y.Doc();
        yText = doc.getText("content");
        yTextRef.current = yText;

        // Reflect remote/local Y.Text changes into React state so the textarea
        // shows the converged document.
        const syncText = () => {
          if (!cancelled && yText) setTextState(yText.toString());
        };
        yText.observe(syncText);

        provider = new HocuspocusProvider({
          url: result.wsUrl,
          name: result.documentName,
          document: doc,
          // The provider accepts a token factory; main always issues fresh
          // 5-min tokens, so re-fetch on demand (covers reconnect + refresh).
          token: async () => {
            const refreshed = await bridge().collabToken({
              workspaceId: input.workspaceId,
              relativePath: input.path,
            });
            return refreshed.available ? refreshed.token : result.token;
          },
          onStatus: ({ status: s }) => {
            if (cancelled) return;
            setStatus(s === "connected" ? "connected" : "disconnected");
          },
          onSynced: syncText,
        });

        // Peer presence via the provider's awareness. We count OTHER clients
        // (exclude our own clientID).
        const awareness = provider.awareness;
        const updatePeers = () => {
          if (cancelled || !awareness || !doc) return;
          let others = 0;
          for (const clientId of awareness.getStates().keys()) {
            if (clientId !== doc.clientID) others += 1;
          }
          setPeerCount(others);
        };
        awareness?.on("change", updatePeers);
        awareness?.setLocalStateField("user", {
          // Local desktop identity for presence; the server sanitizes this.
          id: "you",
          name: "You",
          color: "#6b7280",
        });
        updatePeers();
        syncText();

        detachObservers = () => {
          yText?.unobserve(syncText);
          awareness?.off("change", updatePeers);
        };
      })
      .catch(() => {
        if (!cancelled) setStatus("disabled");
      });

    return () => {
      cancelled = true;
      detachObservers?.();
      yTextRef.current = null;
      // Destroy the provider first (closes the socket + cleans awareness),
      // then the doc — clean teardown on unmount or path/workspace change so a
      // navigated-away document never keeps syncing.
      provider?.destroy();
      doc?.destroy();
      setPeerCount(0);
    };
  }, [input.workspaceId, input.path, input.enabled]);

  // Writes from the textarea: replace the whole Y.Text content in one
  // transaction. (A character-diff binding is an optimization; full-replace is
  // correct and keeps this lean — Yjs still merges concurrent remote edits at
  // the CRDT layer, and the local observer immediately reflects the result.)
  function setText(next: string): void {
    const yText = yTextRef.current;
    if (!yText) {
      setTextState(next);
      return;
    }
    const current = yText.toString();
    if (current === next) return;
    yText.doc?.transact(() => {
      yText.delete(0, yText.length);
      yText.insert(0, next);
    });
  }

  return {
    enabled: status === "connected",
    status,
    text,
    setText,
    peerCount,
  };
}
