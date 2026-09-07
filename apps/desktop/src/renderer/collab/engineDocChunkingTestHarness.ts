import * as Y from "yjs";
import type { EngineYDocSaveStateEvent } from "../../ipc/bridgeContract";

type SaveStateListener = (event: EngineYDocSaveStateEvent) => void;

export function harnessBridge(initialUpdate?: Uint8Array) {
  const saveStateListeners = new Set<SaveStateListener>();
  const applied: Array<{ sessionId: string; seq: number }> = [];
  let rejectUpdates = false;
  let openedSessionId: string | null = null;
  const doc = new Y.Doc();
  doc.getMap("meta").set("contentKind", "plain-text");
  doc.getText("plainText").insert(0, "seed");
  const seedUpdate = initialUpdate ?? Y.encodeStateAsUpdate(doc);

  const api = {
    async openEngineYDocSession(payload: { sessionId: string }) {
      openedSessionId = payload.sessionId;
      return {
        available: true,
        initialUpdate: seedUpdate,
        lineageGeneration: 1,
      };
    },
    async applyEngineYDocUpdate(payload: { sessionId: string; seq: number }) {
      applied.push({ sessionId: payload.sessionId, seq: payload.seq });
      if (rejectUpdates) throw new Error("update delivery failed");
      return { accepted: true as const };
    },
    onEngineYDocRemoteUpdate: () => () => undefined,
    onEngineYDocLineageReplacement: () => () => undefined,
    onEngineYDocSaveState: (listener: SaveStateListener) => {
      saveStateListeners.add(listener);
      return () => saveStateListeners.delete(listener);
    },
    async closeEngineYDocSession() {
      return undefined;
    },
  };

  function emitNow(
    state: "settling" | "saved" | "error" | "file-locked" | "deleted",
    seq: number,
  ): void {
    if (openedSessionId === null) throw new Error("session not open yet");
    for (const listener of [...saveStateListeners]) {
      listener({ sessionId: openedSessionId, state, seq });
    }
  }

  return {
    api,
    applied,
    emitNow,
    sessionId: () => openedSessionId,
    rejectUpdates() {
      rejectUpdates = true;
    },
  };
}
