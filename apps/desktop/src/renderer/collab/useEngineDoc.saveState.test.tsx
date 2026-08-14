// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  declareSceneRoots,
  insertElementRevision,
  putSceneAsset,
} from "@dohc/excalidraw-scene";
import {
  ENGINE_YDOC_UPDATE_MAX_BYTES,
  type EngineYDocSaveStateEvent,
} from "../../ipc/channels";
import {
  resetOrphanedDrafts,
  useOrphanedDrafts,
} from "../orphanedDrafts";
import { useEngineDoc } from "./useEngineDoc";
import { parseExcalidrawDocument } from "../excalidrawDocument";

const IMAGE_DESCRIPTOR = {
  id: "recovery-image",
  mimeType: "image/png",
  created: 1,
  ref: "assets/recovery-image.png",
  sha256: "a".repeat(64),
  lastRetrieved: 2,
  version: 3,
};

// AUDIT-SILENTSAVE. The engine editor's save indicator used to be a 1s timer
// that flipped to "saved" no matter what the engine did — three dogfood
// journeys watched a doc read "Saved" over a ZERO-BYTE .md. It is now driven
// only by main's real settle outcomes. These tests own that contract: no
// timer may resurrect "saved", a failure must show, and a settle that predates
// the newest keystroke must not claim to cover it.

afterEach(cleanup);

type SaveStateListener = (event: EngineYDocSaveStateEvent) => void;
type LineageReplacementListener = (event: {
  sessionId: string;
  update: Uint8Array;
  recoveredPaths: string[];
  artifactAssets: readonly typeof IMAGE_DESCRIPTOR[];
  lineageGeneration: number;
}) => void;

function harnessBridge(kind: "richdoc" | "scene" = "richdoc") {
  const saveStateListeners = new Set<SaveStateListener>();
  const remoteUpdateListeners = new Set<
    (event: { sessionId: string; update: Uint8Array }) => void
  >();
  const lineageReplacementListeners = new Set<LineageReplacementListener>();
  const applied: Array<{ sessionId: string; seq: number }> = [];
  const applyAttempts: Array<{ sessionId: string; seq: number }> = [];
  const closed: string[] = [];
  let rejectedApplyAttempts = 0;
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
  let readArtifactAsset: (assetId: string) => Promise<{
    descriptor: typeof IMAGE_DESCRIPTOR;
    bytes: Uint8Array;
  }> = async () => {
    throw new Error("missing asset");
  };

  const api = {
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
    async applyEngineYDocUpdate(payload: { sessionId: string; seq: number }) {
      applyAttempts.push({ sessionId: payload.sessionId, seq: payload.seq });
      if (rejectedApplyAttempts > 0) {
        rejectedApplyAttempts -= 1;
        throw new Error("IPC request rejected");
      }
      applied.push({ sessionId: payload.sessionId, seq: payload.seq });
    },
    readEngineYDocArtifactAsset(payload: { assetId: string }) {
      return readArtifactAsset(payload.assetId);
    },
    onEngineYDocRemoteUpdate: (
      listener: (event: { sessionId: string; update: Uint8Array }) => void,
    ) => {
      remoteUpdateListeners.add(listener);
      return () => remoteUpdateListeners.delete(listener);
    },
    onEngineYDocLineageReplacement: (listener: LineageReplacementListener) => {
      lineageReplacementListeners.add(listener);
      return () => lineageReplacementListeners.delete(listener);
    },
    async acknowledgeEngineYDocLineageReplacement(payload: {
      lineageGeneration: number;
    }) {
      acknowledgedGenerations.push(payload.lineageGeneration);
      return { updates: [] };
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
      lineageGeneration: 2,
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
  ): void {
    const target = sessionId ?? openedSessionId;
    if (target === null) throw new Error("session not open yet");
    const event = { sessionId: target, state, seq };
    act(() => {
      for (const listener of [...saveStateListeners]) listener(event);
    });
  }

  function emitNow(
    state:
      | "settling"
      | "saved"
      | "error"
      | "file-locked"
      | "read-only"
      | "deleted",
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
  };
}

let lastBoundDoc: Y.Doc | null = null;

function Harness(props: {
  workspaceId: string;
  path: string;
  enabled?: boolean;
  kind?: "richdoc" | "scene";
  compactDraft?: boolean;
}) {
  const sceneVersion = useRef(1);
  const [retryKey, setRetryKey] = useState(0);
  const [hydratedAssets, setHydratedAssets] = useState("none");
  const engine = useEngineDoc({
    workspaceId: props.workspaceId,
    path: props.path,
    enabled: props.enabled ?? true,
    kind: props.kind,
    retryKey,
  });
  if (engine.doc !== null) lastBoundDoc = engine.doc;
  const drafts = useOrphanedDrafts(props.workspaceId, props.path);
  return (
    <div>
      <span data-testid="state">{engine.saveState}</span>
      <span data-testid="save-error">{engine.saveError ?? "none"}</span>
      <span data-testid="available">{String(engine.available)}</span>
      <span data-testid="artifact-assets-invalid">
        {String(engine.artifactAssetsInvalid)}
      </span>
      <span data-testid="engine-may-hold-document">
        {String(engine.engineMayHoldDocument)}
      </span>
      <span data-testid="deleted">{String(engine.deletedWhileEditing)}</span>
      <span data-testid="read-only-transition">
        {String(engine.readOnlyWhileEditing)}
      </span>
      <span data-testid="permanent-failure-transition">
        {String(engine.permanentFailureWhileEditing)}
      </span>
      <span data-testid="draft">
        {props.compactDraft
          ? drafts.at(-1)
            ? "present"
            : "none"
          : drafts.at(-1)?.text ?? "none"}
      </span>
      <span data-testid="draft-size">
        {String(drafts.at(-1)?.text.length ?? 0)}
      </span>
      <span data-testid="draft-count">{drafts.length}</span>
      <span data-testid="asset-recovery">
        {engine.recoveryAssets
          ? `${engine.recoveryAssets.state}:${engine.recoveryAssets.count}`
          : "none"}
      </span>
      <span data-testid="artifact-asset-ids">
        {engine.artifactAssets.map((asset) => asset.id).join(",") || "none"}
      </span>
      <span data-testid="hydrated-assets">{hydratedAssets}</span>
      <button
        type="button"
        data-testid="hydrate-assets"
        onClick={() => {
          void Promise.all(
            engine.artifactAssets.map((asset) =>
              engine.readArtifactAsset(asset.id),
            ),
          ).then((loaded) => setHydratedAssets(loaded.map(({ descriptor }) => descriptor.id).join(",")));
        }}
      >
        hydrate assets
      </button>
      <span data-testid="removal-operation">
        {engine.removalInProgress?.operation ?? "none"}
      </span>
      <span data-testid="removal-message">
        {engine.removalInProgress?.message ?? "none"}
      </span>
      <button
        type="button"
        data-testid="type"
        onClick={() => {
          if (props.kind === "scene" && engine.doc) {
            sceneVersion.current += 1;
            insertElementRevision(engine.doc, {
              id: "recovered-shape",
              type: "rectangle",
              version: sceneVersion.current,
              versionNonce: sceneVersion.current,
              isDeleted: false,
              index: "a0",
              x: (sceneVersion.current - 1) * 10,
            });
            return;
          }
          const text = engine.doc?.getText("plainText");
          text?.insert(text.length, "!");
        }}
      >
        type
      </button>
      <button type="button" data-testid="retry" onClick={() => setRetryKey((n) => n + 1)}>
        retry
      </button>
      <button
        type="button"
        data-testid="type-oversized"
        onClick={() => {
          if (props.kind === "scene" && engine.doc) {
            insertElementRevision(engine.doc, {
              id: "oversized-shape",
              type: "rectangle",
              version: 1,
              versionNonce: 1,
              isDeleted: false,
              index: "a1",
              customData: {
                payload: "x".repeat(ENGINE_YDOC_UPDATE_MAX_BYTES + 1),
              },
            });
            return;
          }
          engine.doc
            ?.getText("plainText")
            .insert(0, "x".repeat(ENGINE_YDOC_UPDATE_MAX_BYTES + 1));
        }}
      >
        type oversized
      </button>
    </div>
  );
}

let harness: ReturnType<typeof harnessBridge>;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  harness = harnessBridge();
  vi.stubGlobal("dohcDesktop", harness.api);
  resetOrphanedDrafts();
  lastBoundDoc = null;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetOrphanedDrafts();
});

async function mountBound() {
  render(<Harness workspaceId="ws-1" path="notes/big.md" />);
  await waitFor(() => expect(screen.getByTestId("available").textContent).toBe("true"));
}

async function flushLocalBatch(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(32);
  });
}

it("never flips back to Saved on a timer — only a real settle report clears it", async () => {
  await mountBound();

  act(() => {
    screen.getByTestId("type").click();
  });
  expect(screen.getByTestId("state").textContent).toBe("saving");

  // The old indicator flipped to "saved" 1s after the last edit regardless of
  // the engine. Run far past that: with no settle report, nothing may claim it.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(screen.getByTestId("state").textContent).toBe("saving");

  // Only main's real report clears it.
  harness.emit("saved", harness.applied.at(-1)!.seq);
  expect(screen.getByTestId("state").textContent).toBe("saved");
});

it("observes unsaved edits on a replacement document", async () => {
  await mountBound();
  harness.emitLineageReplacement("winner");
  await waitFor(() => expect(harness.acknowledgedGenerations).toEqual([2]));

  act(() => {
    screen.getByTestId("type").click();
  });
  await flushLocalBatch();

  expect(screen.getByTestId("state").textContent).toBe("saving");
  expect(harness.applied).toHaveLength(1);
});

it("persists a late edit on the losing mirror during replacement", async () => {
  await mountBound();
  const losingDoc = lastBoundDoc!;

  harness.emitLineageReplacement("winner");
  act(() => {
    const text = losingDoc.getText("plainText");
    text.insert(text.length, "!");
  });

  await waitFor(() =>
    expect(screen.getByTestId("draft").textContent).toBe("seed!"),
  );
  await waitFor(() => expect(harness.acknowledgedGenerations).toEqual([2]));
  expect(harness.applied).toHaveLength(0);
  expect(screen.getByTestId("available").textContent).toBe("true");
});

it("recovers a dirty replaced scene immediately and hydrates its image", async () => {
  harness = harnessBridge("scene");
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  let resolveAsset!: (value: {
    descriptor: typeof IMAGE_DESCRIPTOR;
    bytes: Uint8Array;
  }) => void;
  const asset = new Promise<{
    descriptor: typeof IMAGE_DESCRIPTOR;
    bytes: Uint8Array;
  }>((resolve) => {
    resolveAsset = resolve;
  });
  const readAsset = vi.fn(() => asset);
  harness.setArtifactReader([IMAGE_DESCRIPTOR], readAsset);
  putSceneAsset(harness.sourceDoc, IMAGE_DESCRIPTOR);
  insertElementRevision(harness.sourceDoc, {
    id: "image-element",
    type: "image",
    fileId: IMAGE_DESCRIPTOR.id,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    index: "a1",
  });
  vi.stubGlobal("dohcDesktop", harness.api);
  render(
    <Harness workspaceId="ws-1" path="drawing.excalidraw" kind="scene" />,
  );
  await waitFor(() =>
    expect(screen.getByTestId("available").textContent).toBe("true"),
  );

  act(() => screen.getByTestId("type").click());
  harness.emitLineageReplacement("unused");

  expect(screen.getByTestId("draft-count").textContent).toBe("1");
  const immediate = parseExcalidrawDocument(
    screen.getByTestId("draft").textContent!,
  );
  expect(immediate.elements).toContainEqual(
    expect.objectContaining({ id: "recovered-shape", x: 10 }),
  );
  expect(immediate.elements).toContainEqual(
    expect.objectContaining({ id: "image-element", fileId: null }),
  );
  expect(immediate.files).toEqual({});
  await waitFor(() =>
    expect(screen.getByTestId("asset-recovery").textContent).toBe("loading:1"),
  );
  expect(readAsset).toHaveBeenCalledOnce();

  await act(async () => {
    resolveAsset({ descriptor: IMAGE_DESCRIPTOR, bytes });
    await asset;
  });

  await waitFor(() => {
    const recovered = parseExcalidrawDocument(
      screen.getByTestId("draft").textContent!,
    );
    expect(recovered.elements).toContainEqual(
      expect.objectContaining({
        id: "image-element",
        fileId: IMAGE_DESCRIPTOR.id,
      }),
    );
    expect(recovered.files[IMAGE_DESCRIPTOR.id]).toMatchObject({
      dataURL: "data:image/png;base64,iVBORw==",
    });
  });
  expect(screen.getByTestId("asset-recovery").textContent).toBe("none");
  expect(screen.getByTestId("draft-count").textContent).toBe("1");
});

it("hydrates winner-only scene assets after lineage replacement without reopening", async () => {
  harness = harnessBridge("scene");
  const loser = { ...IMAGE_DESCRIPTOR, id: "loser-image", ref: "assets/loser.png" };
  const winner = {
    ...IMAGE_DESCRIPTOR,
    id: "winner-image",
    ref: "assets/winner.png",
    sha256: "b".repeat(64),
  };
  const readAsset = vi.fn(async (assetId: string) => {
    if (assetId !== winner.id) throw new Error("stale asset authority");
    return { descriptor: winner, bytes: new Uint8Array([1, 2, 3]) };
  });
  harness.setArtifactReader([loser], readAsset);
  putSceneAsset(harness.sourceDoc, loser);
  insertElementRevision(harness.sourceDoc, {
    id: "loser-image-element",
    type: "image",
    fileId: loser.id,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    index: "a1",
  });
  vi.stubGlobal("dohcDesktop", harness.api);
  render(
    <Harness workspaceId="ws-1" path="drawing.excalidraw" kind="scene" />,
  );
  await waitFor(() =>
    expect(screen.getByTestId("artifact-asset-ids").textContent).toBe(loser.id),
  );

  harness.emitLineageReplacement("unused", [winner]);

  await waitFor(() =>
    expect(screen.getByTestId("artifact-asset-ids").textContent).toBe(winner.id),
  );
  expect(harness.openCount()).toBe(1);
  expect(screen.getByTestId("artifact-asset-ids").textContent).not.toContain(
    loser.id,
  );
  act(() => screen.getByTestId("hydrate-assets").click());
  await waitFor(() =>
    expect(screen.getByTestId("hydrated-assets").textContent).toBe(winner.id),
  );
  expect(readAsset).toHaveBeenNthCalledWith(1, loser.id);
  expect(readAsset).toHaveBeenNthCalledWith(2, winner.id);
  expect(readAsset).toHaveBeenCalledTimes(2);
});

it("does not reuse a losing lineage asset when the winner reuses its file ID", async () => {
  harness = harnessBridge("scene");
  const loser = {
    ...IMAGE_DESCRIPTOR,
    ref: "assets/loser.png",
    sha256: "a".repeat(64),
  };
  const winner = {
    ...IMAGE_DESCRIPTOR,
    ref: "assets/winner.png",
    sha256: "b".repeat(64),
  };
  let activeDescriptor = loser;
  const readAsset = vi.fn(async () => ({
    descriptor: activeDescriptor,
    bytes: new Uint8Array(activeDescriptor === loser ? [9] : [1, 2, 3]),
  }));
  harness.setArtifactReader([loser], readAsset);
  putSceneAsset(harness.sourceDoc, loser);
  insertElementRevision(harness.sourceDoc, {
    id: "lineage-image",
    type: "image",
    fileId: loser.id,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    index: "a1",
  });
  vi.stubGlobal("dohcDesktop", harness.api);
  render(
    <Harness workspaceId="ws-1" path="drawing.excalidraw" kind="scene" />,
  );
  await waitFor(() =>
    expect(screen.getByTestId("available").textContent).toBe("true"),
  );

  const retired = lastBoundDoc!;
  act(() => screen.getByTestId("type").click());
  harness.emitLineageReplacement("unused", [winner]);
  await waitFor(() => expect(readAsset).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(screen.getByTestId("asset-recovery").textContent).toBe("none"),
  );

  activeDescriptor = winner;
  act(() =>
    insertElementRevision(retired, {
      id: "lineage-image",
      type: "image",
      fileId: loser.id,
      version: 2,
      versionNonce: 2,
      isDeleted: false,
      index: "a1",
      x: 77,
    }),
  );
  await waitFor(() => {
    const recovered = parseExcalidrawDocument(
      screen.getByTestId("draft").textContent!,
    );
    expect(recovered.elements).toContainEqual(
      expect.objectContaining({ id: "lineage-image", x: 77 }),
    );
    expect(recovered.files[loser.id]).toMatchObject({
      dataURL: "data:image/png;base64,CQ==",
    });
  });
  expect(readAsset).toHaveBeenCalledTimes(1);

  act(() => screen.getByTestId("type").click());
  await flushLocalBatch();
  harness.emit("deleted", harness.applied.at(-1)!.seq);

  await waitFor(() => expect(readAsset).toHaveBeenCalledTimes(2));
  await waitFor(() => {
    const recovered = parseExcalidrawDocument(
      screen.getByTestId("draft").textContent!,
    );
    expect(recovered.files[winner.id]).toMatchObject({
      dataURL: "data:image/png;base64,AQID",
    });
  });
  expect(screen.getByTestId("draft").textContent).not.toContain("CQ==");
});

it("shows the failure when a settle fails, instead of reading Saved", async () => {
  await mountBound();

  act(() => {
    screen.getByTestId("type").click();
  });
  await flushLocalBatch();
  harness.emit("error", harness.applied.at(-1)!.seq);
  expect(screen.getByTestId("state").textContent).toBe("error");

  // It stays honest: no timer, no later edit-less event, walks it back.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(screen.getByTestId("state").textContent).toBe("error");
});

it("refuses transport writes synchronously after main reports deletion", async () => {
  await mountBound();

  act(() => {
    screen.getByTestId("type").click();
  });
  await flushLocalBatch();
  const appliedAtDelete = harness.applied.length;
  harness.emit("deleted", harness.applied.at(-1)!.seq);

  expect(screen.getByTestId("state").textContent).toBe("deleted");
  expect(screen.getByTestId("deleted").textContent).toBe("true");

  // A Y.Doc update can fire before the read-only React render commits. The
  // transport ref closes that gap, so no later update reaches main.
  act(() => {
    screen.getByTestId("type").click();
  });
  expect(harness.applied).toHaveLength(appliedAtDelete);
  expect(screen.getByTestId("state").textContent).toBe("deleted");

  harness.emit("error", harness.applied.at(-1)!.seq);
  expect(screen.getByTestId("state").textContent).toBe("deleted");
});

it("sets aside a refused scene, freezes writes, and releases the session", async () => {
  harness = harnessBridge("scene");
  vi.stubGlobal("dohcDesktop", harness.api);
  render(
    <Harness workspaceId="ws-1" path="drawing.excalidraw" kind="scene" />,
  );
  await waitFor(() =>
    expect(screen.getByTestId("available").textContent).toBe("true"),
  );

  act(() => screen.getByTestId("type").click());
  await flushLocalBatch();
  expect(harness.applyAttempts.map(({ seq }) => seq)).toEqual([1]);

  // Main acknowledged sequence 1 as an inert no-op after the workspace
  // became shared read-only. One last editor callback can run before React
  // commits view mode; the synchronous refusal must stop it at the transport.
  act(() => {
    harness.emitNow("read-only", 1);
    screen.getByTestId("type").click();
  });
  await flushLocalBatch();

  expect(screen.getByTestId("state").textContent).toBe("read-only");
  expect(screen.getByTestId("read-only-transition").textContent).toBe("true");
  expect(harness.applyAttempts.map(({ seq }) => seq)).toEqual([1]);
  await waitFor(() => expect(harness.closed).toHaveLength(1));
  await waitFor(() => {
    const recovered = JSON.parse(screen.getByTestId("draft").textContent!);
    expect(recovered).toMatchObject({
      type: "excalidraw",
      source: "https://excalidraw.com",
      elements: [expect.objectContaining({ id: "recovered-shape", x: 20 })],
      files: {},
    });
  });
});

it("replaces the same deletion's draft when a keystroke lands before read-only commits", async () => {
  await mountBound();

  act(() => {
    screen.getByTestId("type").click();
  });
  await flushLocalBatch();
  const appliedAtDelete = harness.applied.length;

  // One React batch: main reports deletion, then Tiptap emits one last local
  // update before the read-only render can commit.
  act(() => {
    harness.emitNow("deleted", harness.applied.at(-1)!.seq);
    screen.getByTestId("type").click();
  });

  await waitFor(() =>
    expect(screen.getByTestId("draft").textContent).toBe("seed!!"),
  );
  expect(harness.applied).toHaveLength(appliedAtDelete);
});

it("freezes the deleted doc's bytes at the event, immune to a remote edit that lands before serialization resolves", async () => {
  // #697 P1-A: the boundary capture snapshots the doc SYNCHRONOUSLY at the
  // deletion event and defers only the markdown PROJECTION (the part that
  // needs the lazy Tiptap module). Nothing before this pin distinguished
  // that from deferring the snapshot too — both pass every earlier test,
  // because unmount alone does not corrupt a Y.Doc's encodable state.
  //
  // A remote update is the real discriminator: it is NOT gated by
  // `writesRefused` (only LOCAL writes are refused after deletion), so it
  // can still land on the SAME doc while the projection is in flight. A
  // synchronous snapshot is immune to it; a deferred one would pick it up.
  await mountBound();

  act(() => {
    screen.getByTestId("type").click();
  });
  await flushLocalBatch();
  harness.emitNow("deleted", harness.applied.at(-1)!.seq);

  // Lands after the event, before the queued serialize job has resolved.
  harness.emitRemoteEdit("+remote");

  await waitFor(() => expect(screen.getByTestId("draft").textContent).toBe("seed!"));
});

it("stores a deleted scene as portable Excalidraw JSON", async () => {
  harness = harnessBridge("scene");
  vi.stubGlobal("dohcDesktop", harness.api);
  render(
    <Harness
      workspaceId="ws-1"
      path="drawing.excalidraw"
      kind="scene"
    />,
  );
  await waitFor(() =>
    expect(screen.getByTestId("available").textContent).toBe("true"),
  );

  act(() => screen.getByTestId("type").click());
  await flushLocalBatch();
  harness.emit("deleted", harness.applied.at(-1)!.seq);

  await waitFor(() => {
    const text = screen.getByTestId("draft").textContent ?? "none";
    expect(text).not.toBe("none");
    const recovered = JSON.parse(text);
    expect(recovered).toMatchObject({
      type: "excalidraw",
      source: "https://excalidraw.com",
      elements: [{ id: "recovered-shape" }],
      files: {},
    });
  });
});

it("upgrades one deleted-scene draft with its verified image bytes", async () => {
  harness = harnessBridge("scene");
  const bytes = new Uint8Array(50 * 1024 + 8);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(bytes.byteLength).toBeGreaterThan(48 * 1024);
  let resolveAsset!: (value: {
    descriptor: typeof IMAGE_DESCRIPTOR;
    bytes: Uint8Array;
  }) => void;
  const asset = new Promise<{
    descriptor: typeof IMAGE_DESCRIPTOR;
    bytes: Uint8Array;
  }>((resolve) => {
    resolveAsset = resolve;
  });
  const readAsset = vi.fn(() => asset);
  harness.setArtifactReader([IMAGE_DESCRIPTOR], readAsset);
  putSceneAsset(harness.sourceDoc, IMAGE_DESCRIPTOR);
  insertElementRevision(harness.sourceDoc, {
    id: "image-element",
    type: "image",
    fileId: IMAGE_DESCRIPTOR.id,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    index: "a1",
  });
  vi.stubGlobal("dohcDesktop", harness.api);
  render(
    <Harness workspaceId="ws-1" path="drawing.excalidraw" kind="scene" />,
  );
  await waitFor(() =>
    expect(screen.getByTestId("available").textContent).toBe("true"),
  );

  act(() => screen.getByTestId("type").click());
  await flushLocalBatch();
  harness.emit("deleted", harness.applied.at(-1)!.seq);

  expect(readAsset).toHaveBeenCalledOnce();
  expect(screen.getByTestId("asset-recovery").textContent).toBe("loading:1");
  expect(screen.getByTestId("draft-count").textContent).toBe("1");
  const immediate = JSON.parse(screen.getByTestId("draft").textContent!);
  expect(immediate.files).toEqual({});
  expect(
    immediate.elements.find((element: { id: string }) =>
      element.id === "image-element",
    ).fileId,
  ).toBeNull();

  // One last canvas callback can land before the read-only render commits.
  // Its immediate snapshot must not wait behind the older image read, and the
  // older async completion must not restore the previous scene revision.
  act(() => screen.getByTestId("type").click());
  await waitFor(() => {
    const latest = JSON.parse(screen.getByTestId("draft").textContent!);
    expect(
      latest.elements.find((element: { id: string }) =>
        element.id === "recovered-shape",
      ).x,
    ).toBe(20);
  });

  await act(async () => {
    resolveAsset({ descriptor: IMAGE_DESCRIPTOR, bytes });
    await asset;
  });

  await waitFor(() => {
    const text = screen.getByTestId("draft").textContent!;
    const recovered = parseExcalidrawDocument(text);
    expect(recovered.elements).toContainEqual(
      expect.objectContaining({
        id: "image-element",
        fileId: IMAGE_DESCRIPTOR.id,
      }),
    );
    expect(recovered.elements).toContainEqual(
      expect.objectContaining({ id: "recovered-shape", x: 20 }),
    );
    expect(recovered.files[IMAGE_DESCRIPTOR.id]).toMatchObject({
      id: IMAGE_DESCRIPTOR.id,
      mimeType: "image/png",
      created: IMAGE_DESCRIPTOR.created,
      lastRetrieved: IMAGE_DESCRIPTOR.lastRetrieved,
      version: IMAGE_DESCRIPTOR.version,
      dataURL: expect.stringMatching(/^data:image\/png;base64,iVBORw0KGgo/),
    });
  });
  expect(screen.getByTestId("draft-count").textContent).toBe("1");
  expect(screen.getByTestId("asset-recovery").textContent).toBe("none");
});

it("keeps missing images explicit and never exposes a dangling recovery ref", async () => {
  harness = harnessBridge("scene");
  harness.setArtifactReader([IMAGE_DESCRIPTOR], async () => {
    throw new Error("asset unavailable");
  });
  putSceneAsset(harness.sourceDoc, IMAGE_DESCRIPTOR);
  insertElementRevision(harness.sourceDoc, {
    id: "image-element",
    type: "image",
    fileId: IMAGE_DESCRIPTOR.id,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    index: "a1",
  });
  vi.stubGlobal("dohcDesktop", harness.api);
  render(
    <Harness workspaceId="ws-1" path="drawing.excalidraw" kind="scene" />,
  );
  await waitFor(() =>
    expect(screen.getByTestId("available").textContent).toBe("true"),
  );

  act(() => screen.getByTestId("type").click());
  await flushLocalBatch();
  harness.emit("deleted", harness.applied.at(-1)!.seq);

  await waitFor(() =>
    expect(screen.getByTestId("asset-recovery").textContent).toBe("missing:1"),
  );
  const recovered = parseExcalidrawDocument(
    screen.getByTestId("draft").textContent!,
  );
  expect(recovered.files).toEqual({});
  expect(recovered.elements).toContainEqual(
    expect.objectContaining({ id: "image-element", fileId: null }),
  );
});

it("still holds the final text after teardown, with no further save-state event to answer it", async () => {
  const view = render(<Harness workspaceId="ws-1" path="notes/big.md" enabled />);
  await waitFor(() => expect(screen.getByTestId("available").textContent).toBe("true"));

  act(() => {
    screen.getByTestId("type").click();
  });
  await flushLocalBatch();
  harness.emit("deleted", harness.applied.at(-1)!.seq);
  await waitFor(() => expect(screen.getByTestId("draft").textContent).toBe("seed!"));

  // A further edit, then straight to teardown — no separate save-state
  // report from main ever answers this edit. Correctness pin, not a
  // discriminator: `onUpdate` already snapshots this edit synchronously
  // before teardown runs, so removing the teardown-time call alone does not
  // fail this specific test (verified). It is exercised here anyway,
  // because it is the one path that would lose an edit if that ordering
  // ever changed.
  act(() => {
    screen.getByTestId("type").click();
  });
  act(() => {
    view.rerender(
      <Harness workspaceId="ws-1" path="notes/big.md" enabled={false} />,
    );
  });

  await waitFor(() => expect(screen.getByTestId("draft").textContent).toBe("seed!!"));
});

it("does not carry a deleted verdict into a fresh bind of the same path", async () => {
  const view = render(
    <Harness workspaceId="ws-1" path="notes/big.md" enabled />,
  );
  await waitFor(() => expect(screen.getByTestId("available").textContent).toBe("true"));
  act(() => {
    screen.getByTestId("type").click();
  });
  await flushLocalBatch();
  harness.emit("deleted", harness.applied.at(-1)!.seq);
  expect(screen.getByTestId("deleted").textContent).toBe("true");

  view.rerender(
    <Harness workspaceId="ws-1" path="notes/big.md" enabled={false} />,
  );
  await waitFor(() => expect(screen.getByTestId("available").textContent).toBe("false"));
  view.rerender(
    <Harness workspaceId="ws-1" path="notes/big.md" enabled />,
  );
  await waitFor(() => expect(screen.getByTestId("available").textContent).toBe("true"));

  expect(screen.getByTestId("deleted").textContent).toBe("false");
  const appliedBeforeFreshEdit = harness.applied.length;
  act(() => {
    screen.getByTestId("type").click();
  });
  await flushLocalBatch();
  expect(harness.applied).toHaveLength(appliedBeforeFreshEdit + 1);
});

it("observes deletion while the open answer is still in flight", async () => {
  harness.setEmitDeletedDuringOpen(true);
  render(<Harness workspaceId="ws-1" path="notes/big.md" />);

  await waitFor(() => expect(screen.getByTestId("available").textContent).toBe("true"));
  expect(screen.getByTestId("state").textContent).toBe("deleted");
  expect(screen.getByTestId("deleted").textContent).toBe("true");
});

it("keeps a failed delete interval retryable without storing a deleted verdict", async () => {
  harness.setRemovalInProgress({
    operation: "delete",
    message: "dohc is still deleting notes/big.md.",
  });
  render(<Harness workspaceId="ws-1" path="notes/big.md" />);

  await waitFor(() =>
    expect(screen.getByTestId("removal-operation").textContent).toBe("delete"),
  );
  expect(screen.getByTestId("removal-message").textContent).toBe(
    "dohc is still deleting notes/big.md.",
  );
  expect(screen.getByTestId("available").textContent).toBe("false");
  expect(screen.getByTestId("deleted").textContent).toBe("false");

  // The underlying delete failed and closed its interval. A new request opens
  // the still-present file without carrying a terminal verdict forward.
  harness.setRemovalInProgress(null);
  act(() => screen.getByTestId("retry").click());
  await waitFor(() => expect(screen.getByTestId("available").textContent).toBe("true"));
  expect(screen.getByTestId("removal-operation").textContent).toBe("none");
  expect(screen.getByTestId("deleted").textContent).toBe("false");
});

it("keeps invalid scene asset authority as a distinct unavailable outcome", async () => {
  harness = harnessBridge("scene");
  harness.setArtifactAssetsInvalid(true);
  vi.stubGlobal("dohcDesktop", harness.api);
  render(
    <Harness workspaceId="ws-1" path="drawing.excalidraw" kind="scene" />,
  );

  await waitFor(() =>
    expect(screen.getByTestId("artifact-assets-invalid").textContent).toBe(
      "true",
    ),
  );
  expect(screen.getByTestId("available").textContent).toBe("false");
  expect(screen.getByTestId("engine-may-hold-document").textContent).toBe(
    "false",
  );
  expect(screen.getByTestId("removal-operation").textContent).toBe("none");
});

it("passes a file-locked report through, and a real settle clears it", async () => {
  // #554: the transient lock is its own state so the surface can name the
  // blocker. Like "error" it never decays on a timer — only a real settle
  // report walks it back, which is what the engine's own retry produces.
  await mountBound();

  act(() => {
    screen.getByTestId("type").click();
  });
  await flushLocalBatch();
  harness.emit("file-locked", harness.applied.at(-1)!.seq);
  expect(screen.getByTestId("state").textContent).toBe("file-locked");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(screen.getByTestId("state").textContent).toBe("file-locked");

  // The engine's retry lands: the same real report clears it to Saved.
  harness.emit("saved", harness.applied.at(-1)!.seq);
  expect(screen.getByTestId("state").textContent).toBe("saved");
});

it("does not claim File in use for a lock refusal that predates the newest keystroke", async () => {
  // `file-locked` is the one refusal whose copy makes a durability claim —
  // dohc has your edits, and it is retrying. A refusal about older text would
  // promise safety for a keystroke the settle never carried, so it is held to
  // the same sequence guard "saved" uses.
  //
  // MUTATION: accept `file-locked` unconditionally -> this reads
  // "file-locked" while an edit is still in flight.
  await mountBound();

  act(() => {
    screen.getByTestId("type").click();
  });
  await flushLocalBatch();
  const firstSeq = harness.applied.at(-1)!.seq;
  act(() => {
    screen.getByTestId("type").click();
  });

  // The lock refusal belongs to the settle that started before the second
  // keystroke. The second edit is staged but not sent yet. The local sequence
  // already guards it, so the document stays saving instead of claiming the
  // edit is safely parked under a lock.
  harness.emit("file-locked", firstSeq);
  expect(screen.getByTestId("state").textContent).toBe("saving");

  // A refusal that DOES cover the newest edit names the blocker.
  await flushLocalBatch();
  const secondSeq = harness.applied.at(-1)!.seq;
  expect(secondSeq).toBeGreaterThan(firstSeq);
  harness.emit("file-locked", secondSeq);
  expect(screen.getByTestId("state").textContent).toBe("file-locked");
});

it("does not claim Saved for a settle that predates the newest keystroke", async () => {
  await mountBound();

  act(() => {
    screen.getByTestId("type").click();
  });
  await flushLocalBatch();
  const firstSeq = harness.applied.at(-1)!.seq;
  act(() => {
    screen.getByTestId("type").click();
  });

  // A settle that STARTED before the second keystroke reports success. It
  // never carried that staged, not-yet-sent edit, so the indicator must keep
  // saying "saving".
  harness.emit("saved", firstSeq);
  expect(screen.getByTestId("state").textContent).toBe("saving");

  // The follow-up settle covers it.
  await flushLocalBatch();
  const secondSeq = harness.applied.at(-1)!.seq;
  expect(secondSeq).toBeGreaterThan(firstSeq);
  harness.emit("saved", secondSeq);
  expect(screen.getByTestId("state").textContent).toBe("saved");
});

it("stays Saving while a rejected transport head retries ahead of later edits", async () => {
  harness.rejectNextApplyAttempts(1);
  await mountBound();

  act(() => screen.getByTestId("type").click());
  await flushLocalBatch();
  expect(harness.applyAttempts.map(({ seq }) => seq)).toEqual([1]);
  expect(harness.applied).toEqual([]);
  expect(screen.getByTestId("state").textContent).toBe("saving");

  // A later edit advances the same Yjs client clock. Its batch may become
  // ready, but it cannot pass the rejected head in the provider's send chain.
  act(() => screen.getByTestId("type").click());
  await flushLocalBatch();
  expect(harness.applyAttempts.map(({ seq }) => seq)).toEqual([1]);
  expect(screen.getByTestId("state").textContent).toBe("saving");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(218);
  });
  expect(harness.applyAttempts.map(({ seq }) => seq)).toEqual([1, 1, 2]);
  expect(harness.applied.map(({ seq }) => seq)).toEqual([1, 2]);

  // Even after transport recovery, the first batch's settle cannot vouch for
  // the later edit. Only the acknowledgement covering sequence 2 may clear it.
  harness.emit("saved", 1);
  expect(screen.getByTestId("state").textContent).toBe("saving");
  harness.emit("saved", 2);
  expect(screen.getByTestId("state").textContent).toBe("saved");
});

it.each([
  { kind: "richdoc" as const, path: "notes/big.md" },
  { kind: "scene" as const, path: "drawing.excalidraw" },
])("sets aside an oversized $kind edit and reports the measured limit", async ({
  kind,
  path,
}) => {
  harness = harnessBridge(kind);
  vi.stubGlobal("dohcDesktop", harness.api);
  render(
    <Harness
      workspaceId="ws-1"
      path={path}
      kind={kind}
      compactDraft
    />,
  );
  await waitFor(() =>
    expect(screen.getByTestId("available").textContent).toBe("true"),
  );

  act(() => screen.getByTestId("type-oversized").click());
  await flushLocalBatch();

  expect(harness.applyAttempts).toEqual([]);
  expect(screen.getByTestId("state").textContent).toBe("error");
  expect(screen.getByTestId("save-error").textContent).toContain(
    `ENGINE_YDOC_UPDATE_MAX_BYTES is ${ENGINE_YDOC_UPDATE_MAX_BYTES} bytes`,
  );
  expect(screen.getByTestId("save-error").textContent).toMatch(
    /the update is \d+ bytes/,
  );
  await waitFor(() =>
    expect(screen.getByTestId("draft").textContent).toBe("present"),
  );
  expect(Number(screen.getByTestId("draft-size").textContent)).toBeGreaterThan(
    ENGINE_YDOC_UPDATE_MAX_BYTES,
  );
});

it("reports pending and complete image recovery for an oversized scene", async () => {
  harness = harnessBridge("scene");
  let resolveAsset!: (value: {
    descriptor: typeof IMAGE_DESCRIPTOR;
    bytes: Uint8Array;
  }) => void;
  const asset = new Promise<{
    descriptor: typeof IMAGE_DESCRIPTOR;
    bytes: Uint8Array;
  }>((resolve) => {
    resolveAsset = resolve;
  });
  harness.setArtifactReader([IMAGE_DESCRIPTOR], () => asset);
  putSceneAsset(harness.sourceDoc, IMAGE_DESCRIPTOR);
  insertElementRevision(harness.sourceDoc, {
    id: "image-element",
    type: "image",
    fileId: IMAGE_DESCRIPTOR.id,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    index: "a1",
  });
  vi.stubGlobal("dohcDesktop", harness.api);
  render(
    <Harness workspaceId="ws-1" path="drawing.excalidraw" kind="scene" />,
  );
  await waitFor(() =>
    expect(screen.getByTestId("available").textContent).toBe("true"),
  );

  act(() => screen.getByTestId("type-oversized").click());
  await flushLocalBatch();

  expect(
    screen.getByTestId("permanent-failure-transition").textContent,
  ).toBe("true");
  expect(screen.getByTestId("asset-recovery").textContent).toBe("loading:1");
  const immediate = parseExcalidrawDocument(
    screen.getByTestId("draft").textContent!,
  );
  expect(immediate.files).toEqual({});
  expect(immediate.elements).toContainEqual(
    expect.objectContaining({ id: "image-element", fileId: null }),
  );

  await act(async () => {
    resolveAsset({ descriptor: IMAGE_DESCRIPTOR, bytes: new Uint8Array([1, 2, 3]) });
    await asset;
  });

  await waitFor(() =>
    expect(screen.getByTestId("asset-recovery").textContent).toBe("none"),
  );
  const recovered = parseExcalidrawDocument(
    screen.getByTestId("draft").textContent!,
  );
  expect(recovered.elements).toContainEqual(
    expect.objectContaining({
      id: "image-element",
      fileId: IMAGE_DESCRIPTOR.id,
    }),
  );
  expect(recovered.files[IMAGE_DESCRIPTOR.id]).toMatchObject({
    id: IMAGE_DESCRIPTOR.id,
    dataURL: "data:image/png;base64,AQID",
  });
});

it("reports a missing image after oversized-scene recovery fails", async () => {
  harness = harnessBridge("scene");
  harness.setArtifactReader([IMAGE_DESCRIPTOR], async () => {
    throw new Error("asset unavailable");
  });
  putSceneAsset(harness.sourceDoc, IMAGE_DESCRIPTOR);
  insertElementRevision(harness.sourceDoc, {
    id: "image-element",
    type: "image",
    fileId: IMAGE_DESCRIPTOR.id,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    index: "a1",
  });
  vi.stubGlobal("dohcDesktop", harness.api);
  render(
    <Harness workspaceId="ws-1" path="drawing.excalidraw" kind="scene" />,
  );
  await waitFor(() =>
    expect(screen.getByTestId("available").textContent).toBe("true"),
  );

  act(() => screen.getByTestId("type-oversized").click());
  await flushLocalBatch();

  await waitFor(() =>
    expect(screen.getByTestId("asset-recovery").textContent).toBe("missing:1"),
  );
  const recovered = parseExcalidrawDocument(
    screen.getByTestId("draft").textContent!,
  );
  expect(recovered.files).toEqual({});
  expect(recovered.elements).toContainEqual(
    expect.objectContaining({ id: "image-element", fileId: null }),
  );
});

it("degrades to not-engine-backed on a bridge without the save-state channel, instead of blanking the editor", async () => {
  // Round-2 regression. Subscribing synchronously in the effect body turned a
  // bridge that lacks this method (an older preload, a narrower host) from
  // "not engine-backed, fall back to the local editor" into an uncaught
  // TypeError that unmounted the whole document view. Every bridge call must
  // stay inside the caught region.
  const { onEngineYDocSaveState: _omitted, ...withoutSaveState } = harness.api;
  vi.stubGlobal("dohcDesktop", withoutSaveState);

  render(<Harness workspaceId="ws-1" path="notes/big.md" />);

  // The document view survives; it simply reports no engine session.
  await waitFor(() =>
    expect(screen.getByTestId("available").textContent).toBe("false"),
  );
  expect(screen.getByTestId("state").textContent).toBe("saved");
});

it("ignores a save-state report addressed to a different session", async () => {
  await mountBound();

  act(() => {
    screen.getByTestId("type").click();
  });
  await flushLocalBatch();
  const seq = harness.applied.at(-1)!.seq;

  // Another document's settle must never repaint this one (the renderer
  // async-state invariant): right seq, wrong session id.
  harness.emit("saved", seq, "eyd-someone-else");
  expect(screen.getByTestId("state").textContent).toBe("saving");

  harness.emit("saved", seq);
  expect(screen.getByTestId("state").textContent).toBe("saved");
});
