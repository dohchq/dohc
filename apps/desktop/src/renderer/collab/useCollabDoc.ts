import { HocuspocusProvider } from "@hocuspocus/provider";
import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { bridge } from "../bridge";
import {
  createCollabSessionState,
  recordMaterialization,
  reconcileExternalEdit,
  shouldMaterialize,
  type CollabSessionState,
} from "./collabSession";

// Live co-editing hook for the desktop markdown editor. Given a workspace +
// path, it asks main for a collab token (only minted for SHARED cloud
// workspaces with a signed-in session — see the collabToken IPC), connects a
// HocuspocusProvider, and binds the canonical "plainText" Y.Text that the
// server bootstraps and projects markdown from (NOT a desktop-only field — the
// server stores markdown atoms as a plain-text Y.Text on this path, and its
// onChange projection reads that same field back to atoms.body). The textarea
// reads/writes it. When the workspace is personal/local-only or signed out,
// main returns available:false and this hook is a clean no-op: enabled=false,
// the editor stays on the existing local autosave path, byte-identical to
// today.
//
// Data-loss safety (plan Phase 10, decision D-07; "silent loss is never
// acceptable"): the editor only enters collab mode once the provider is
// SYNCED — never on a bare socket open, whose empty pre-sync Y.Text would
// otherwise blank the file. And the CRDT is materialized back to disk only
// through the canonical-state model in collabSession.ts: every settle and
// every external on-disk change (agent edit, sync pull) is reconciled against
// the last-materialized base, so a stale/empty doc folds the on-disk text IN
// rather than clobbering it, and an overlapping external edit is rescued to a
// visible <path>.conflict instead of being lost.
//
// Anti-bloat (lead's choice): Y.Text + textarea + awareness. No Tiptap, no
// y-indexeddb — the desktop's offline copy is the FILE on disk, not IndexedDB,
// so Yjs offline convergence on reconnect is enough.

export type CollabStatus = "disabled" | "connecting" | "connected" | "disconnected";

// The shared Y.Text field. MUST match the server's plain-text bootstrap +
// projection field (services/hocuspocus/src/import-export.ts PLAIN_TEXT_FIELD).
const PLAIN_TEXT_FIELD = "plainText";

// Re-fetch the collab token a little before the 5-min server TTL so a
// long-lived editing session never has its sync/awareness messages rejected.
const TOKEN_REFRESH_MS = 4 * 60 * 1000;
// Project the converged CRDT to disk on this settle (matches the local editor's
// autosave cadence).
const MATERIALIZE_DEBOUNCE_MS = 800;

export type UseCollabDoc = {
  // True only once a live shared session is connected AND synced; the editor
  // switches to collab mode on this flag. false => use the local autosave
  // editor showing the real on-disk content (never an empty pre-sync doc).
  enabled: boolean;
  status: CollabStatus;
  // The live document text and the writer the textarea calls onChange with.
  text: string;
  setText: (next: string) => void;
  // How many OTHER editors are present (this client is excluded).
  peerCount: number;
};

function replaceText(yText: Y.Text, next: string): void {
  if (yText.toString() === next) return;
  yText.doc?.transact(() => {
    yText.delete(0, yText.length);
    yText.insert(0, next);
  });
}

export function useCollabDoc(input: {
  workspaceId: string;
  path: string;
  // The CURRENT on-disk text (the parent re-reads it on external change). The
  // canonical-state model reconciles against this so an external edit is folded
  // into the doc rather than clobbered.
  onDiskText: string;
  // The renderer only attempts collab for text/markdown files; binary/sqlite
  // never CRDT-syncs. Caller passes false to keep this a no-op for those.
  enabled: boolean;
}): UseCollabDoc {
  const [status, setStatus] = useState<CollabStatus>("disabled");
  const [synced, setSynced] = useState(false);
  const [text, setTextState] = useState("");
  const [peerCount, setPeerCount] = useState(0);
  // The live Y.Text for the connected session; null when not in collab mode.
  const yTextRef = useRef<Y.Text | null>(null);
  // Canonical-state model state + the text we last projected to disk (the 3-way
  // merge base). Held in refs so the debounced settle reads the latest.
  const sessionRef = useRef<CollabSessionState>(createCollabSessionState());
  const lastMaterializedTextRef = useRef<string | null>(null);
  const onDiskTextRef = useRef(input.onDiskText);
  onDiskTextRef.current = input.onDiskText;

  // Write the CRDT text to disk and record it as the new materialization base,
  // so the resulting watcher event is recognised as our own (no loop) and a
  // later external change 3-way merges against it.
  async function writeAndRecord(workspaceId: string, path: string, text: string): Promise<void> {
    try {
      await bridge().writeWorkspaceText({ workspaceId, relativePath: path, text });
      lastMaterializedTextRef.current = text;
      sessionRef.current = recordMaterialization(sessionRef.current, text, Date.now());
    } catch {
      // Leave it for the next settle — never lose the in-memory doc.
    }
  }

  // Fold an external on-disk change into the live doc without losing either
  // side. Runs on initial sync (base=null adopts on-disk if the doc is empty)
  // and on every later on-disk change.
  async function reconcile(workspaceId: string, path: string, onDiskText: string): Promise<void> {
    const yText = yTextRef.current;
    if (!yText) return;
    const res = reconcileExternalEdit({
      onDiskText,
      lastMaterializedText: lastMaterializedTextRef.current,
      docText: yText.toString(),
    });
    if (res.kind === "merge-into-doc") {
      replaceText(yText, res.mergedText);
      await writeAndRecord(workspaceId, path, res.mergedText);
    } else if (res.kind === "conflict") {
      // Overlapping edits: rescue the external version to a visible sibling so
      // nothing is silently lost, then let the live session keep <path>. The
      // human/AI resolves from the two files (Step 6 policy).
      await bridge()
        .writeWorkspaceText({ workspaceId, relativePath: `${path}.conflict`, text: res.onDiskText })
        .catch(() => undefined);
      await writeAndRecord(workspaceId, path, res.docText);
    }
    // no-op: disk already matches the doc.
  }

  useEffect(() => {
    if (!input.enabled) {
      setStatus("disabled");
      return;
    }
    const { workspaceId, path } = input;
    let cancelled = false;
    let provider: HocuspocusProvider | null = null;
    let doc: Y.Doc | null = null;
    let yText: Y.Text | null = null;
    let detachObservers: (() => void) | null = null;
    let refreshTimer: ReturnType<typeof setInterval> | null = null;

    setStatus("connecting");
    setSynced(false);
    setPeerCount(0);
    sessionRef.current = createCollabSessionState();
    lastMaterializedTextRef.current = null;

    void bridge()
      .collabToken({ workspaceId, relativePath: path })
      .then((result) => {
        if (cancelled) return;
        if (!result.available) {
          // Not a shared cloud workspace (or signed out) — stay local.
          setStatus("disabled");
          return;
        }

        doc = new Y.Doc();
        yText = doc.getText(PLAIN_TEXT_FIELD);
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
            const refreshed = await bridge().collabToken({ workspaceId, relativePath: path });
            return refreshed.available ? refreshed.token : result.token;
          },
          onStatus: ({ status: s }) => {
            if (cancelled) return;
            setStatus(s === "connected" ? "connected" : "disconnected");
          },
          // Sync (not bare connect) is when the doc reflects server state. Only
          // now is it safe to enter collab mode and start materializing: the
          // canonical-state session goes active and the first reconcile folds
          // any on-disk content the empty/older server doc is missing.
          onSynced: () => {
            if (cancelled) return;
            sessionRef.current = { ...sessionRef.current, active: true };
            setSynced(true);
            syncText();
            void reconcile(workspaceId, path, onDiskTextRef.current);
          },
        });

        // Refresh the short-lived collab JWT before the server TTL so a
        // long-open editor keeps accepting sync/awareness messages.
        refreshTimer = setInterval(() => {
          void provider?.sendToken().catch(() => undefined);
        }, TOKEN_REFRESH_MS);

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
      if (refreshTimer) clearInterval(refreshTimer);
      detachObservers?.();
      yTextRef.current = null;
      sessionRef.current = { ...sessionRef.current, active: false };
      setSynced(false);
      // Destroy the provider first (closes the socket + cleans awareness),
      // then the doc — clean teardown on unmount or path/workspace change so a
      // navigated-away document never keeps syncing.
      provider?.destroy();
      doc?.destroy();
      setPeerCount(0);
    };
    // input.onDiskText is intentionally NOT a dep — the external-edit effect
    // below handles on-disk changes without tearing down the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.workspaceId, input.path, input.enabled]);

  // External on-disk changes (agent edit, sync pull) while a session is live:
  // fold them into the doc once synced, never clobber.
  useEffect(() => {
    if (!synced || !yTextRef.current) return;
    void reconcile(input.workspaceId, input.path, input.onDiskText);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.onDiskText, synced]);

  // Settle: project the converged CRDT to disk after a debounce. shouldMaterialize
  // no-ops when the doc already equals disk or equals our last write.
  useEffect(() => {
    if (!synced) return;
    const timer = setTimeout(() => {
      const yText = yTextRef.current;
      if (!yText) return;
      const docText = yText.toString();
      if (
        !shouldMaterialize({
          state: sessionRef.current,
          docText,
          onDiskText: onDiskTextRef.current,
          trigger: "settle-debounce",
        })
      ) {
        return;
      }
      void writeAndRecord(input.workspaceId, input.path, docText);
    }, MATERIALIZE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, synced]);

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
    replaceText(yText, next);
  }

  return {
    // Collab mode only once SYNCED — the local editor (real on-disk content)
    // owns the surface until then, so an empty pre-sync doc can never blank it.
    enabled: synced,
    status,
    text,
    setText,
    peerCount,
  };
}
