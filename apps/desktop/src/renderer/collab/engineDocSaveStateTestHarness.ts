import { act } from "@testing-library/react";
import * as Y from "yjs";
import {
  declareSceneRoots,
  insertElementRevision,
  putSceneAsset,
} from "@dohc/excalidraw-scene";
import type { EngineYDocSaveStateEvent } from "../../ipc/bridgeContract";
import { ENGINE_YDOC_UPDATE_MAX_BYTES } from "../../ipc/channels";
import { EngineYDocUpdateTooLargeError } from "./engineYDocProvider";

export const IMAGE_DESCRIPTOR = {
  id: "recovery-image",
  mimeType: "image/png",
  created: 1,
  ref: "assets/recovery-image.png",
  sha256: "a".repeat(64),
  lastRetrieved: 2,
  version: 3,
};

type SaveStateListener = (event: EngineYDocSaveStateEvent) => void;
type LineageReplacementListener = (event: {
  sessionId: string;
  update: Uint8Array;
  recoveredPaths: string[];
  artifactAssets: readonly typeof IMAGE_DESCRIPTOR[];
  lineageGeneration: number;
}) => void;

export function harnessBridge(kind: "richdoc" | "scene" = "richdoc") {
  const saveStateListeners = new Set<SaveStateListener>();
  const remoteUpdateListeners = new Set<
    (event: { sessionId: string; update: Uint8Array }) => void
  >();
  const lineageReplacementListeners = new Set<LineageReplacementListener>();
  const applied: Array<{ sessionId: string; seq: number }> = [];
  const applyAttempts: Array<{ sessionId: string; seq: number }> = [];
  const closed: string[] = [];
  let rejectedApplyAttempts = 0;
  let deferredApplyFailure: Promise<never> | null = null;
  const acknowledgedGenerations: number[] = [];
  let openedSessionId: string | null = null;
  let openCount = 0;
  const doc = new Y.Doc();
  if (kind === "scene") {
    declareSceneRoots(doc);
    insertElementRevision(doc, {
      id: "recovered-shape",
      type: "rectangle",
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      index: "a0",
    });
  } else {
    doc.getMap("meta").set("contentKind", "plain-text");
    doc.getText("plainText").insert(0, "seed");
  }
  let removalInProgress: {
    operation: "delete" | "move";
    message: string;
  } | null = null;
  let emitDeletedDuringOpen = false;
  let artifactAssets: readonly typeof IMAGE_DESCRIPTOR[] = [];
  let artifactAssetsInvalid = false;
  let lineageReplacementFailure: Error | null = null;
  let lineageReplacementRefusal:
    | "session-unavailable"
    | "lineage-transition"
    | null = null;
  let permanentApplyFailure = false;
  let readArtifactAsset: (descriptor: typeof IMAGE_DESCRIPTOR) => Promise<{
    descriptor: typeof IMAGE_DESCRIPTOR;
    bytes: Uint8Array;
  }> = async () => {
    throw new Error("missing asset");
  };

  const api = {
    platform: "linux" as const,
    async openEngineYDocSession(payload: { sessionId: string }) {
      openCount += 1;
      openedSessionId = payload.sessionId;
      if (emitDeletedDuringOpen) {
        for (const listener of [...saveStateListeners]) {
          listener({ sessionId: payload.sessionId, state: "deleted", seq: 0 });
        }
      }
      if (removalInProgress) {
        return { available: false, removalInProgress };
      }
      if (artifactAssetsInvalid) {
        return { available: false, artifactAssetsInvalid: true };
      }
      return {
        available: true,
        initialUpdate: Y.encodeStateAsUpdate(doc),
        artifactAssets,
        lineageGeneration: 1,
      };
    },
    async applyEngineYDocUpdate(payload: {
      sessionId: string;
      update: Uint8Array;
      seq: number;
    }) {
      applyAttempts.push({ sessionId: payload.sessionId, seq: payload.seq });
      if (permanentApplyFailure) {
        permanentApplyFailure = false;
        throw new EngineYDocUpdateTooLargeError(
          ENGINE_YDOC_UPDATE_MAX_BYTES + 1,
        );
      }
      if (deferredApplyFailure) {
        const failure = deferredApplyFailure;
        deferredApplyFailure = null;
        await failure;
      }
      if (rejectedApplyAttempts > 0) {
        rejectedApplyAttempts -= 1;
        throw new Error("IPC request rejected");
      }
      Y.applyUpdate(doc, payload.update);
      applied.push({ sessionId: payload.sessionId, seq: payload.seq });
      return { accepted: true as const };
    },
    readEngineYDocArtifactAsset(payload: { descriptor: typeof IMAGE_DESCRIPTOR }) {
      return readArtifactAsset(payload.descriptor);
    },
    onEngineYDocRemoteUpdate: (
      listener: (event: { sessionId: string; update: Uint8Array }) => void,
    ) => {
      remoteUpdateListeners.add(listener);
      return () => remoteUpdateListeners.delete(listener);
    },
    onEngineYDocOwnerHandoff: () => () => undefined,
    prepareEngineYDocOwnerHandoff: async () => undefined,
    onEngineYDocLineageReplacement: (listener: LineageReplacementListener) => {
      lineageReplacementListeners.add(listener);
      return () => lineageReplacementListeners.delete(listener);
    },
    async acknowledgeEngineYDocLineageReplacement(payload: {
      lineageGeneration: number;
    }) {
      acknowledgedGenerations.push(payload.lineageGeneration);
      if (lineageReplacementFailure) throw lineageReplacementFailure;
      if (lineageReplacementRefusal) {
        return {
          accepted: false as const,
          reason: lineageReplacementRefusal,
        };
      }
      return { accepted: true as const, updates: [] };
    },
    onEngineYDocSaveState: (listener: SaveStateListener) => {
      saveStateListeners.add(listener);
      return () => saveStateListeners.delete(listener);
    },
    async closeEngineYDocSession(payload: { sessionId: string }) {
      closed.push(payload.sessionId);
      return undefined;
    },
  };

  // Mutates the SOURCE doc and delivers the resulting incremental update as
  // a forwarded remote delta — a co-editor's edit, arriving on the same
  // channel a local one settles through. Not gated by `writesRefused`: a
  // remote update still applies to a deleted-while-editing doc (only LOCAL
  // writes are refused), so a deletion's captured text must be frozen
  // against exactly this.
  function emitRemoteEdit(suffix: string): void {
    if (openedSessionId === null) throw new Error("session not open yet");
    const before = Y.encodeStateVector(doc);
    doc.getText("plainText").insert(doc.getText("plainText").length, suffix);
    const update = Y.encodeStateAsUpdate(doc, before);
    const event = { sessionId: openedSessionId, update };
    act(() => {
      for (const listener of [...remoteUpdateListeners]) listener(event);
    });
  }

  function emitLineageReplacement(
    text: string,
    replacementAssets: readonly typeof IMAGE_DESCRIPTOR[] = [],
    lineageGeneration = 2,
  ): void {
    if (openedSessionId === null) throw new Error("session not open yet");
    const replacement = new Y.Doc();
    if (kind === "scene") {
      declareSceneRoots(replacement);
      insertElementRevision(replacement, {
        id: "winning-shape",
        type: "rectangle",
        version: 1,
        versionNonce: 1,
        isDeleted: false,
        index: "a0",
      });
      for (const descriptor of replacementAssets) {
        putSceneAsset(replacement, descriptor);
        insertElementRevision(replacement, {
          id: `image-${descriptor.id}`,
          type: "image",
          fileId: descriptor.id,
          version: 1,
          versionNonce: 1,
          isDeleted: false,
          index: "a1",
        });
      }
    } else {
      replacement.getMap("meta").set("contentKind", "plain-text");
      replacement.getText("plainText").insert(0, text);
    }
    const event = {
      sessionId: openedSessionId,
      update: Y.encodeStateAsUpdate(replacement),
      recoveredPaths: [],
      artifactAssets: replacementAssets,
      lineageGeneration,
    };
    act(() => {
      for (const listener of [...lineageReplacementListeners]) listener(event);
    });
  }

  function emit(
    state:
      | "settling"
      | "saved"
      | "error"
      | "file-locked"
      | "read-only"
      | "deleted",
    seq: number,
    sessionId?: string,
    authorCapacity?: boolean,
  ): void {
    const target = sessionId ?? openedSessionId;
    if (target === null) throw new Error("session not open yet");
    const event = { sessionId: target, state, seq, authorCapacity };
    act(() => {
      for (const listener of [...saveStateListeners]) listener(event);
    });
  }

  function emitNow(
    state:
      | "saved-to-host"
      | "pending-share"
      | "settling"
      | "saved"
      | "error"
      | "file-locked"
      | "read-only"
      | "deleted"
      | "object-changed",
    seq: number,
  ): void {
    if (openedSessionId === null) throw new Error("session not open yet");
    for (const listener of [...saveStateListeners]) {
      listener({ sessionId: openedSessionId, state, seq });
    }
  }

  return {
    api,
    emit,
    emitNow,
    emitRemoteEdit,
    emitLineageReplacement,
    applied,
    applyAttempts,
    closed,
    sourceDoc: doc,
    mainText: () => doc.getText("plainText").toString(),
    acknowledgedGenerations,
    sessionId: () => openedSessionId,
    openCount: () => openCount,
    rejectNextApplyAttempts(count: number) {
      rejectedApplyAttempts = count;
    },
    setRemovalInProgress(value: typeof removalInProgress) {
      removalInProgress = value;
    },
    setEmitDeletedDuringOpen(value: boolean) {
      emitDeletedDuringOpen = value;
    },
    setArtifactReader(
      descriptors: readonly typeof IMAGE_DESCRIPTOR[],
      reader: typeof readArtifactAsset,
    ) {
      artifactAssets = descriptors;
      readArtifactAsset = reader;
    },
    setArtifactAssetsInvalid(value: boolean) {
      artifactAssetsInvalid = value;
    },
    setLineageReplacementFailure(value: Error | null) {
      lineageReplacementFailure = value;
    },
    setLineageReplacementRefusal(value: typeof lineageReplacementRefusal) {
      lineageReplacementRefusal = value;
    },
    deferNextApplyFailure() {
      let rejectFailure!: (error: Error) => void;
      deferredApplyFailure = new Promise<never>((_resolve, reject) => {
        rejectFailure = reject;
      });
      return () => rejectFailure(new Error("renderer update delivery failed"));
    },
    rejectNextApplyAsTooLarge() {
      permanentApplyFailure = true;
    },
  };
}
