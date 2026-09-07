// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { insertElementRevision, putSceneAsset } from "@dohc/excalidraw-scene";
import { ENGINE_YDOC_UPDATE_MAX_BYTES } from "../../ipc/channels";
import { resetOrphanedDrafts, useOrphanedDrafts } from "../orphanedDrafts";
import { disposeEngineDocLeasesForTests } from "./engineDocLease";
import { retainObservedEngineDocLease } from "./engineDocLeaseTestHarness";
import { harnessBridge, IMAGE_DESCRIPTOR } from "./engineDocSaveStateTestHarness";
import { parseExcalidrawDocument } from "../excalidrawDocument";

const projectionGate = vi.hoisted(() => ({
  pending: null as Promise<void> | null,
  completed: 0,
}));

vi.mock("@dohc/ydoc-projection", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@dohc/ydoc-projection")
  >();
  return {
    ...actual,
    yDocToMarkdown(doc: Y.Doc) {
      const markdown = actual.yDocToMarkdown(doc);
      return (
        projectionGate.pending?.then(() => {
          projectionGate.completed += 1;
          return `${markdown} [projected]`;
        }) ??
        markdown
      );
    },
  };
});

let harness: ReturnType<typeof harnessBridge>;
let retained: ReturnType<typeof retainObservedEngineDocLease>;
let documentKind: "richdoc" | "scene";
let sceneVersion = 1;

function observeDrafts(path: string) {
  return renderHook(() => useOrphanedDrafts("ws-1", path));
}

let drafts: ReturnType<typeof observeDrafts>;

function retainDocument(path = "notes/big.md", kind: "richdoc" | "scene" = "richdoc") {
  documentKind = kind;
  sceneVersion = 1;
  drafts = observeDrafts(path);
  retained = retainObservedEngineDocLease({
    workspaceId: "ws-1",
    path,
    kind,
    enabled: true,
  });
}

function boundOutcome() {
  const outcome = retained.snapshot.outcome;
  if (outcome?.kind !== "bound") throw new Error("Expected a bound lease");
  return outcome;
}

function editDocument() {
  const doc = retained.boundDoc();
  if (documentKind === "scene") {
    sceneVersion += 1;
    insertElementRevision(doc, {
      id: "recovered-shape",
      type: "rectangle",
      version: sceneVersion,
      versionNonce: sceneVersion,
      isDeleted: false,
      index: "a0",
      x: (sceneVersion - 1) * 10,
    });
    return;
  }
  const text = doc.getText("plainText");
  text.insert(text.length, "!");
}

function editOversizedDocument() {
  const doc = retained.boundDoc();
  if (documentKind === "scene") {
    insertElementRevision(doc, {
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
  doc.getText("plainText").insert(0, "x".repeat(ENGINE_YDOC_UPDATE_MAX_BYTES + 1));
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  harness = harnessBridge();
  vi.stubGlobal("dohcDesktop", harness.api);
  resetOrphanedDrafts();
  projectionGate.pending = null;
  projectionGate.completed = 0;
});

afterEach(async () => {
  cleanup();
  retained?.release();
  await disposeEngineDocLeasesForTests();
  await retained?.lease.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetOrphanedDrafts();
  projectionGate.pending = null;
  projectionGate.completed = 0;
});

async function retainBound() {
  retainDocument();
  await waitFor(() => expect(retained.snapshot.outcome?.kind).toBe("bound"));
}

async function flushLocalBatch(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(32);
  });
}

it("never flips back to Saved on a timer — only a real settle report clears it", async () => {
  await retainBound();

  act(() => {
    editDocument();
  });
  expect(retained.snapshot.saveState).toBe("saving");

  // The old indicator flipped to "saved" 1s after the last edit regardless of
  // the engine. Run far past that: with no settle report, nothing may claim it.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(retained.snapshot.saveState).toBe("saving");

  // Only main's real report clears it.
  harness.emit("saved", harness.applied.at(-1)!.seq);
  expect(retained.snapshot.saveState).toBe("saved");
});

it("observes unsaved edits on a replacement document", async () => {
  await retainBound();
  harness.emitLineageReplacement("winner");
  await waitFor(() => expect(harness.acknowledgedGenerations).toEqual([2]));

  act(() => {
    editDocument();
  });
  await flushLocalBatch();

  expect(retained.snapshot.saveState).toBe("saving");
  expect(harness.applied).toHaveLength(1);
});

it("persists a late edit on the losing mirror during replacement", async () => {
  await retainBound();
  const losingDoc = retained.boundDoc();

  harness.emitLineageReplacement("winner");
  act(() => {
    const text = losingDoc.getText("plainText");
    text.insert(text.length, "!");
  });

  await waitFor(() =>
    expect(drafts.result.current.at(-1)?.text).toBe("seed!"),
  );
  await waitFor(() => expect(harness.acknowledgedGenerations).toEqual([2]));
  expect(harness.applied).toHaveLength(0);
  expect(retained.snapshot.outcome?.kind).toBe("bound");
});

it("keeps a failed lineage handoff visible and read-only", async () => {
  await retainBound();
  const retired = retained.boundDoc();
  harness.setLineageReplacementFailure(new Error("acknowledgement refused"));

  act(() => editDocument());
  harness.emitLineageReplacement("winner");

  await waitFor(() =>
    expect(retained.snapshot.saveState).toBe("error"),
  );
  expect(retained.snapshot.outcome?.kind).toBe("bound");
  expect(retained.snapshot.readOnlyTransition?.token).toBe(boundOutcome().token);
  expect(retained.snapshot.saveError).toContain(
    "acknowledgement refused",
  );
  expect(drafts.result.current.at(-1)?.text).toBe("seed!");
  expect(retained.boundDoc()).toBe(retired);

  const attemptsBefore = harness.applyAttempts.length;
  act(() => editDocument());
  await flushLocalBatch();
  expect(harness.applyAttempts).toHaveLength(attemptsBefore);
});

it("keeps a refused lineage acknowledgement visible and read-only", async () => {
  await retainBound();
  harness.setLineageReplacementRefusal("session-unavailable");

  act(() => editDocument());
  harness.emitLineageReplacement("winner");

  await waitFor(() =>
    expect(retained.snapshot.saveState).toBe("error"),
  );
  expect(retained.snapshot.readOnlyTransition?.token).toBe(boundOutcome().token);
  expect(retained.snapshot.saveError).toContain(
    "session-unavailable",
  );
});

it("restores a failed scene handoff with the losing asset authority", async () => {
  harness = harnessBridge("scene");
  const loser = {
    ...IMAGE_DESCRIPTOR,
    id: "loser-image",
    ref: "assets/loser.png",
    sha256: "a".repeat(64),
  };
  const winner = {
    ...IMAGE_DESCRIPTOR,
    id: "winner-image",
    ref: "assets/winner.png",
    sha256: "b".repeat(64),
  };
  let winnerOwnsReader = false;
  const readAsset = vi.fn(async () => ({
    descriptor: winnerOwnsReader ? winner : loser,
    bytes: winnerOwnsReader
      ? new Uint8Array([4, 5, 6])
      : new Uint8Array([1, 2, 3]),
  }));
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
  harness.setLineageReplacementFailure(new Error("acknowledgement refused"));
  vi.stubGlobal("dohcDesktop", harness.api);
  retainDocument("drawing.excalidraw", "scene");
  await waitFor(() =>
    expect(retained.snapshot.outcome?.kind).toBe("bound"),
  );
  expect(readAsset).not.toHaveBeenCalled();

  act(() => editDocument());
  harness.emitLineageReplacement("unused", [winner]);
  winnerOwnsReader = true;

  await waitFor(() =>
    expect(retained.snapshot.readOnlyTransition?.token).toBe(boundOutcome().token),
  );
  expect((boundOutcome().artifactAssets.map((asset) => asset.id).join(",") || "none")).toBe(loser.id);
  const bound = boundOutcome();
  const hydratedAssets = await Promise.all(
    bound.artifactAssets.map((asset) => bound.readArtifactAsset(asset)),
  );
  await waitFor(() =>
    expect(hydratedAssets.map(({ descriptor }) => descriptor.id).join(",")).toBe(loser.id),
  );
});

it("binds a winning lineage while the deleted path stays deleted", async () => {
  // Main keeps a deleted entry refusing updates whichever lineage wins, so
  // the renderer must keep reporting deletion across the replacement — while
  // a slow retired-recovery projection must still not block the winner from
  // binding.
  let releaseProjection!: () => void;
  projectionGate.pending = new Promise<void>((resolve) => {
    releaseProjection = resolve;
  });
  try {
    await retainBound();

    act(() => editDocument());
    harness.emitNow("deleted", 0);
    harness.emitLineageReplacement("unused");

    await waitFor(() => expect(harness.acknowledgedGenerations).toEqual([2]));
    await act(async () => {
      releaseProjection();
      await projectionGate.pending;
    });
    await waitFor(() =>
      expect(projectionGate.completed).toBeGreaterThanOrEqual(2),
    );
    expect(retained.snapshot.outcome?.kind).toBe("bound");
    expect(retained.snapshot.deletion?.token).toBe(boundOutcome().token);
  } finally {
    releaseProjection();
  }
});

it("loads scene asset bytes only when recovery needs them", async () => {
  harness = harnessBridge("scene");
  const readAsset = vi.fn(async () => ({
    descriptor: IMAGE_DESCRIPTOR,
    bytes: new Uint8Array([1, 2, 3]),
  }));
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
  retainDocument("drawing.excalidraw", "scene");
  await waitFor(() =>
    expect(retained.snapshot.outcome?.kind).toBe("bound"),
  );

  expect(readAsset).not.toHaveBeenCalled();

  act(() => editDocument());
  await flushLocalBatch();
  harness.emit("deleted", harness.applied.at(-1)!.seq);

  await waitFor(() => expect(readAsset).toHaveBeenCalledOnce());
  await waitFor(() => {
    const recovered = parseExcalidrawDocument(
      drafts.result.current.at(-1)?.text!,
    );
    expect(recovered.files[IMAGE_DESCRIPTOR.id]).toMatchObject({
      dataURL: "data:image/png;base64,AQID",
    });
  });
});

it("keeps retired scene authority after a successful replacement", async () => {
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
  const readAsset = vi.fn(() => asset);
  harness.setArtifactReader([IMAGE_DESCRIPTOR], readAsset);
  putSceneAsset(harness.sourceDoc, IMAGE_DESCRIPTOR);
  insertElementRevision(harness.sourceDoc, {
    id: "restorable-image",
    type: "image",
    fileId: IMAGE_DESCRIPTOR.id,
    version: 1,
    versionNonce: 1,
    isDeleted: true,
    index: "a1",
  });
  vi.stubGlobal("dohcDesktop", harness.api);
  try {
    retainDocument("drawing.excalidraw", "scene");
    await waitFor(() =>
      expect(retained.snapshot.outcome?.kind).toBe("bound"),
    );
    const retired = retained.boundDoc();

    harness.emitLineageReplacement("unused");
    await waitFor(() => expect(harness.acknowledgedGenerations).toEqual([2]));

    act(() =>
      insertElementRevision(retired, {
        id: "restorable-image",
        type: "image",
        fileId: IMAGE_DESCRIPTOR.id,
        version: 2,
        versionNonce: 2,
        isDeleted: false,
        index: "a1",
      }),
    );

    expect(retained.snapshot).toMatchObject({
      outcome: { kind: "bound" },
      sceneRecoveryAssets: null,
    });
    await act(async () => {
      resolveAsset({
        descriptor: IMAGE_DESCRIPTOR,
        bytes: new Uint8Array([1, 2, 3]),
      });
      await asset;
    });

    await waitFor(() => {
      const recovered = parseExcalidrawDocument(
        drafts.result.current.at(-1)?.text!,
      );
      expect(recovered.elements).toContainEqual(
        expect.objectContaining({
          id: "restorable-image",
          fileId: IMAGE_DESCRIPTOR.id,
        }),
      );
      expect(recovered.files[IMAGE_DESCRIPTOR.id]).toMatchObject({
        dataURL: "data:image/png;base64,AQID",
      });
    });
    expect(retained.snapshot.outcome?.kind).toBe("bound");
    expect(retained.snapshot).toMatchObject({
      outcome: { kind: "bound" },
      sceneRecoveryAssets: null,
    });
  } finally {
    resolveAsset({ descriptor: IMAGE_DESCRIPTOR, bytes: new Uint8Array([1, 2, 3]) });
  }
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
  const readAsset = vi.fn(async (descriptor: typeof IMAGE_DESCRIPTOR) => {
    if (descriptor.id !== winner.id) throw new Error("stale asset authority");
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
  retainDocument("drawing.excalidraw", "scene");
  await waitFor(() =>
    expect((boundOutcome().artifactAssets.map((asset) => asset.id).join(",") || "none")).toBe(loser.id),
  );

  harness.emitLineageReplacement("unused", [winner]);

  await waitFor(() =>
    expect((boundOutcome().artifactAssets.map((asset) => asset.id).join(",") || "none")).toBe(winner.id),
  );
  expect(harness.openCount()).toBe(1);
  expect((boundOutcome().artifactAssets.map((asset) => asset.id).join(",") || "none")).not.toContain(
    loser.id,
  );
  const bound = boundOutcome();
  const hydratedAssets = await Promise.all(
    bound.artifactAssets.map((asset) => bound.readArtifactAsset(asset)),
  );
  await waitFor(() =>
    expect(hydratedAssets.map(({ descriptor }) => descriptor.id).join(",")).toBe(winner.id),
  );
  expect(readAsset).toHaveBeenNthCalledWith(1, loser);
  expect(readAsset).toHaveBeenNthCalledWith(2, winner);
  expect(readAsset).toHaveBeenCalledTimes(2);
});

it("retries a failed retired-asset prewarm before writing a recovery draft", async () => {
  harness = harnessBridge("scene");
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
  let rejectPrewarm!: (error: Error) => void;
  const prewarm = new Promise<never>((_resolve, reject) => {
    rejectPrewarm = reject;
  });
  const readAsset = vi
    .fn()
    .mockImplementationOnce(() => prewarm)
    .mockResolvedValue({
      descriptor: IMAGE_DESCRIPTOR,
      bytes: new Uint8Array([1, 2, 3]),
    });
  harness.setArtifactReader([IMAGE_DESCRIPTOR], readAsset);
  vi.stubGlobal("dohcDesktop", harness.api);
  try {
    retainDocument("drawing.excalidraw", "scene");
    await waitFor(() =>
      expect(retained.snapshot.outcome?.kind).toBe("bound"),
    );

    act(() => editDocument());
    await waitFor(() =>
      expect(retained.snapshot.saveState).toBe("saving"),
    );
    harness.emitLineageReplacement("unused");
    await waitFor(() => expect(readAsset).toHaveBeenCalledOnce());
    await act(async () => {
      rejectPrewarm(new Error("temporary read failure"));
      await prewarm.catch(() => undefined);
    });

    await waitFor(() => expect(readAsset).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      const recovered = parseExcalidrawDocument(
        drafts.result.current.at(-1)?.text!,
      );
      expect(recovered.elements).toContainEqual(
        expect.objectContaining({
          id: "image-element",
          fileId: IMAGE_DESCRIPTOR.id,
        }),
      );
      expect(recovered.files[IMAGE_DESCRIPTOR.id]).toMatchObject({
        dataURL: "data:image/png;base64,AQID",
      });
    });
    expect(retained.snapshot).toMatchObject({
      outcome: { kind: "bound" },
      sceneRecoveryAssets: null,
    });
  } finally {
    rejectPrewarm(new Error("temporary read failure"));
  }
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
  let resolveLoser!: (value: {
    descriptor: typeof loser;
    bytes: Uint8Array;
  }) => void;
  let resolveWinner!: (value: {
    descriptor: typeof winner;
    bytes: Uint8Array;
  }) => void;
  const loserRead = new Promise<{ descriptor: typeof loser; bytes: Uint8Array }>(
    (resolve) => {
      resolveLoser = resolve;
    },
  );
  const winnerRead = new Promise<{
    descriptor: typeof winner;
    bytes: Uint8Array;
  }>((resolve) => {
    resolveWinner = resolve;
  });
  // Routed by descriptor identity, the way main selects among its pinned
  // descriptors: the reused id alone can no longer pick a lineage.
  const readAsset = vi.fn((descriptor: typeof IMAGE_DESCRIPTOR) =>
    descriptor.sha256 === loser.sha256 ? loserRead : winnerRead,
  );
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
  try {
    retainDocument("drawing.excalidraw", "scene");
    await waitFor(() =>
      expect(retained.snapshot.outcome?.kind).toBe("bound"),
    );

    const retired = retained.boundDoc();
    act(() => editDocument());
    harness.emitLineageReplacement("unused", [winner]);
    await waitFor(() => expect(readAsset).toHaveBeenCalledTimes(1));

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
    act(() => editDocument());
    await flushLocalBatch();
    harness.emit("deleted", harness.applied.at(-1)!.seq);

    await waitFor(() => expect(readAsset).toHaveBeenCalledTimes(2));
    expect(retained.snapshot.sceneRecoveryAssets).toEqual({ token: boundOutcome().token, state: "loading", count: 1 });
    await act(async () => {
      resolveLoser({ descriptor: loser, bytes: new Uint8Array([9]) });
      await loserRead;
    });
    expect(retained.snapshot.sceneRecoveryAssets).toEqual({ token: boundOutcome().token, state: "loading", count: 1 });

    await act(async () => {
      resolveWinner({ descriptor: winner, bytes: new Uint8Array([1, 2, 3]) });
      await winnerRead;
    });
    await waitFor(() => {
      const recovered = parseExcalidrawDocument(
        drafts.result.current.at(-1)?.text!,
      );
      expect(recovered.files[winner.id]).toMatchObject({
        dataURL: "data:image/png;base64,AQID",
      });
    });
    expect(retained.snapshot).toMatchObject({
      outcome: { kind: "bound" },
      sceneRecoveryAssets: null,
    });
    expect(drafts.result.current.at(-1)?.text).not.toContain("CQ==");
  } finally {
    resolveLoser({ descriptor: loser, bytes: new Uint8Array([9]) });
    resolveWinner({ descriptor: winner, bytes: new Uint8Array([1, 2, 3]) });
  }
});

it("keeps deletion recovery separate from refused winner edits", async () => {
  await retainBound();
  act(() => {
    editDocument();
  });
  await flushLocalBatch();
  const appliedAtDelete = harness.applied.length;
  harness.emit("deleted", harness.applied.at(-1)!.seq);
  await waitFor(() => expect(drafts.result.current.at(-1)?.text).toBe("seed!"));

  harness.emitLineageReplacement("winner");
  await waitFor(() => expect(harness.acknowledgedGenerations).toEqual([2]));
  expect(retained.snapshot.saveState).toBe("deleted");

  act(() => {
    editDocument();
  });
  await waitFor(() => expect(drafts.result.current.at(-1)?.text).toBe("winner!"));
  expect(harness.applied).toHaveLength(appliedAtDelete);
  expect(drafts.result.current.length).toBe(2);
  expect(drafts.result.current.map((draft) => draft.text).join("|")).toContain("seed!");
  expect(drafts.result.current.map((draft) => draft.text).join("|")).toContain("winner!");
  expect(retained.snapshot.saveState).toBe("deleted");

  cleanup();
  retained.release();
  await disposeEngineDocLeasesForTests();
  await retained.lease.dispose();
  drafts = observeDrafts("notes/big.md");
  expect(drafts.result.current.length).toBe(2);
  expect(drafts.result.current.map((draft) => draft.text).join("|")).toContain("seed!");
  expect(drafts.result.current.map((draft) => draft.text).join("|")).toContain("winner!");
});

it("keeps recovery from consecutive independent lineage replacements", async () => {
  await retainBound();
  act(() => {
    editDocument();
  });
  harness.emitLineageReplacement("winner");
  await waitFor(() => expect(harness.acknowledgedGenerations).toEqual([2]));

  act(() => {
    editDocument();
  });
  harness.emitLineageReplacement("final", [], 3);
  await waitFor(() => expect(harness.acknowledgedGenerations).toEqual([2, 3]));

  expect(drafts.result.current.length).toBe(2);
  expect(drafts.result.current.map((draft) => draft.text).join("|")).toContain("seed!");
  expect(drafts.result.current.map((draft) => draft.text).join("|")).toContain("winner!");
});

it("shows the failure when a settle fails, instead of reading Saved", async () => {
  await retainBound();

  act(() => {
    editDocument();
  });
  await flushLocalBatch();
  harness.emit("error", harness.applied.at(-1)!.seq);
  expect(retained.snapshot.saveState).toBe("error");

  // It stays honest: no timer, no later edit-less event, walks it back.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(retained.snapshot.saveState).toBe("error");
});

it("does not report Saved while an earlier delivery is still unanswered", async () => {
  await retainBound();
  const rejectFirst = harness.deferNextApplyFailure();
  try {

    act(() => {
      editDocument();
    });
    await flushLocalBatch();
    expect(harness.applyAttempts).toHaveLength(1);

    act(() => {
      editDocument();
    });
    await flushLocalBatch();

    // Main echoes a settle covering the newest seq while the first delivery has
    // not answered. It must not vouch for the whole mirror yet.
    harness.emit("saved", 2);
    expect(retained.snapshot.saveState).toBe("saving");

    rejectFirst();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    await waitFor(() => expect(harness.applied.at(-1)?.seq).toBe(2));
    expect(harness.mainText()).toBe("seed!!");
    // Every outstanding delivery is acknowledged; the deferred settle now
    // reports the mirror durable without another event.
    await waitFor(() =>
      expect(retained.snapshot.saveState).toBe("saved"),
    );
  } finally {
    rejectFirst();
  }
});

it("stays Saving until a retried delivery converges", async () => {
  await retainBound();
  harness.rejectNextApplyAttempts(2);

  act(() => {
    editDocument();
  });
  await flushLocalBatch();
  expect(harness.applyAttempts).toHaveLength(1);
  expect(retained.snapshot.saveState).toBe("saving");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  expect(harness.applyAttempts).toHaveLength(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  await waitFor(() => expect(harness.applyAttempts).toHaveLength(3));
  expect(harness.mainText()).toBe("seed!");

  harness.emit("saved", harness.applied.at(-1)!.seq);
  await waitFor(() =>
    expect(retained.snapshot.saveState).toBe("saved"),
  );
});

it("refuses transport writes synchronously after main reports deletion", async () => {
  await retainBound();

  act(() => {
    editDocument();
  });
  await flushLocalBatch();
  const appliedAtDelete = harness.applied.length;
  harness.emit("deleted", harness.applied.at(-1)!.seq);

  expect(retained.snapshot.saveState).toBe("deleted");
  expect(retained.snapshot.deletion?.token).toBe(boundOutcome().token);

  // A Y.Doc update can fire before the read-only React render commits. The
  // transport ref closes that gap, so no later update reaches main.
  act(() => {
    editDocument();
  });
  expect(harness.applied).toHaveLength(appliedAtDelete);
  expect(retained.snapshot.saveState).toBe("deleted");

  harness.emit("error", harness.applied.at(-1)!.seq);
  expect(retained.snapshot.saveState).toBe("deleted");
});

it("keeps one recovery draft when deletion lands during a lineage replacement handoff", async () => {
  await retainBound();

  act(() => {
    editDocument();
  });
  // The mirror is dirty, so the replacement's preserve persists a recovery
  // draft synchronously; main's deletion notice for the same session lands
  // before the handoff acknowledges. The deletion must refine the preserved
  // draft, not capture a sibling from the same mirror.
  act(() => {
    harness.emitLineageReplacement("winner!");
    harness.emitNow("deleted", 0);
  });

  await waitFor(() =>
    expect(retained.snapshot.saveState).toBe("deleted"),
  );
  expect(drafts.result.current.length).toBe(1);
  expect(drafts.result.current.at(-1)?.text).toContain("seed!");
});

it("freezes the deleted doc's bytes at the event, immune to a remote edit that lands before serialization resolves", async () => {
  // The boundary capture snapshots the doc synchronously at the
  // deletion event and defers only the markdown PROJECTION (the part that
  // needs the lazy Tiptap module). Nothing before this pin distinguished
  // that from deferring the snapshot too — both pass every earlier test,
  // because unmount alone does not corrupt a Y.Doc's encodable state.
  //
  // A remote update is the real discriminator: it is not gated by
  // `writesRefused` (only LOCAL writes are refused after deletion), so it
  // can still land on the same doc while the projection is in flight. A
  // synchronous snapshot is immune to it; a deferred one would pick it up.
  await retainBound();

  act(() => {
    editDocument();
  });
  await flushLocalBatch();
  harness.emitNow("deleted", harness.applied.at(-1)!.seq);

  // Lands after the event, before the queued serialize job has resolved.
  harness.emitRemoteEdit("+remote");

  await waitFor(() => expect(drafts.result.current.at(-1)?.text).toBe("seed!"));
});

it("stores a deleted scene as portable Excalidraw JSON", async () => {
  harness = harnessBridge("scene");
  vi.stubGlobal("dohcDesktop", harness.api);
  retainDocument("drawing.excalidraw", "scene");
  await waitFor(() =>
    expect(retained.snapshot.outcome?.kind).toBe("bound"),
  );

  act(() => editDocument());
  await flushLocalBatch();
  harness.emit("deleted", harness.applied.at(-1)!.seq);

  await waitFor(() => {
    const text = drafts.result.current.at(-1)?.text ?? "none";
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
  try {
    retainDocument("drawing.excalidraw", "scene");
    await waitFor(() =>
      expect(retained.snapshot.outcome?.kind).toBe("bound"),
    );

    act(() => editDocument());
    await flushLocalBatch();
    harness.emit("deleted", harness.applied.at(-1)!.seq);

    expect(readAsset).toHaveBeenCalledOnce();
    expect(retained.snapshot.sceneRecoveryAssets).toEqual({ token: boundOutcome().token, state: "loading", count: 1 });
    drafts.rerender();
    expect(drafts.result.current.length).toBe(1);
    const immediate = JSON.parse(drafts.result.current.at(-1)?.text!);
    expect(immediate.files).toEqual({});
    expect(
      immediate.elements.find((element: { id: string }) =>
        element.id === "image-element",
      ).fileId,
    ).toBeNull();

    // One last canvas callback can land before the read-only render commits.
    // Its immediate snapshot must not wait behind the older image read, and the
    // older async completion must not restore the previous scene revision.
    act(() => editDocument());
    await waitFor(() => {
      const latest = JSON.parse(drafts.result.current.at(-1)?.text!);
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
      const text = drafts.result.current.at(-1)?.text!;
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
    expect(drafts.result.current.length).toBe(1);
    expect(retained.snapshot).toMatchObject({
      outcome: { kind: "bound" },
      sceneRecoveryAssets: null,
    });
  } finally {
    resolveAsset({ descriptor: IMAGE_DESCRIPTOR, bytes });
  }
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
  retainDocument("drawing.excalidraw", "scene");
  await waitFor(() =>
    expect(retained.snapshot.outcome?.kind).toBe("bound"),
  );

  act(() => editDocument());
  await flushLocalBatch();
  harness.emit("deleted", harness.applied.at(-1)!.seq);

  await waitFor(() =>
    expect(retained.snapshot.sceneRecoveryAssets).toEqual({ token: boundOutcome().token, state: "missing", count: 1 }),
  );
  const recovered = parseExcalidrawDocument(
    drafts.result.current.at(-1)?.text!,
  );
  expect(recovered.files).toEqual({});
  expect(recovered.elements).toContainEqual(
    expect.objectContaining({ id: "image-element", fileId: null }),
  );
});

it("observes deletion while the open answer is still in flight", async () => {
  harness.setEmitDeletedDuringOpen(true);
  retainDocument();

  await waitFor(() => expect(retained.snapshot.outcome?.kind).toBe("bound"));
  expect(retained.snapshot.saveState).toBe("deleted");
  expect(retained.snapshot.deletion?.token).toBe(boundOutcome().token);
});

it("keeps invalid scene asset authority as a distinct unavailable outcome", async () => {
  harness = harnessBridge("scene");
  harness.setArtifactAssetsInvalid(true);
  vi.stubGlobal("dohcDesktop", harness.api);
  retainDocument("drawing.excalidraw", "scene");

  await waitFor(() =>
    expect(retained.snapshot.outcome?.kind).toBe("artifact-assets-invalid"),
  );
  expect(retained.snapshot.outcome?.kind).not.toBe("bound");
  expect(retained.snapshot.outcome?.kind).not.toBe("engine-may-hold-document");
  expect(retained.snapshot.outcome?.kind).not.toBe("removal-in-progress");
});

it("passes a file-locked report through, and a real settle clears it", async () => {
  // The transient lock is its own state so the surface can name the
  // blocker. Like "error" it never decays on a timer — only a real settle
  // report walks it back, which is what the engine's own retry produces.
  await retainBound();

  act(() => {
    editDocument();
  });
  await flushLocalBatch();
  harness.emit("file-locked", harness.applied.at(-1)!.seq);
  expect(retained.snapshot.saveState).toBe("file-locked");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(retained.snapshot.saveState).toBe("file-locked");

  // The engine's retry lands: the same real report clears it to Saved.
  harness.emit("saved", harness.applied.at(-1)!.seq);
  expect(retained.snapshot.saveState).toBe("saved");
});

it("does not claim File in use for a lock refusal that predates the newest keystroke", async () => {
  // `file-locked` is the one refusal whose copy makes a durability claim —
  // dohc has your edits, and it is retrying. A refusal about older text would
  // promise safety for a keystroke the settle never carried, so it is held to
  // the same sequence guard "saved" uses.
  //
  await retainBound();

  act(() => {
    editDocument();
  });
  await flushLocalBatch();
  const firstSeq = harness.applied.at(-1)!.seq;
  act(() => {
    editDocument();
  });

  // The lock refusal belongs to the settle that started before the second
  // keystroke. The second edit is staged but not sent yet. The local sequence
  // already guards it, so the document stays saving instead of claiming the
  // edit is safely parked under a lock.
  harness.emit("file-locked", firstSeq);
  expect(retained.snapshot.saveState).toBe("saving");

  // A refusal that does cover the newest edit names the blocker.
  await flushLocalBatch();
  const secondSeq = harness.applied.at(-1)!.seq;
  expect(secondSeq).toBeGreaterThan(firstSeq);
  harness.emit("file-locked", secondSeq);
  expect(retained.snapshot.saveState).toBe("file-locked");
});

it("does not claim Saved for a settle that predates the newest keystroke", async () => {
  await retainBound();

  act(() => {
    editDocument();
  });
  await flushLocalBatch();
  const firstSeq = harness.applied.at(-1)!.seq;
  act(() => {
    editDocument();
  });

  // A settle that started before the second keystroke reports success. It
  // never carried that staged, not-yet-sent edit, so the indicator must keep
  // saying "saving".
  harness.emit("saved", firstSeq);
  expect(retained.snapshot.saveState).toBe("saving");

  // The follow-up settle covers it.
  await flushLocalBatch();
  const secondSeq = harness.applied.at(-1)!.seq;
  expect(secondSeq).toBeGreaterThan(firstSeq);
  harness.emit("saved", secondSeq);
  await waitFor(() =>
    expect(retained.snapshot.saveState).toBe("saved"),
  );
});

it("stays Saving while a rejected transport head retries ahead of later edits", async () => {
  harness.rejectNextApplyAttempts(1);
  await retainBound();

  act(() => editDocument());
  await flushLocalBatch();
  expect(harness.applyAttempts.map(({ seq }) => seq)).toEqual([1]);
  expect(harness.applied).toEqual([]);
  expect(retained.snapshot.saveState).toBe("saving");

  // A later edit advances the same Yjs client clock. Its batch may become
  // ready, but it cannot pass the rejected head in the provider's send chain.
  act(() => editDocument());
  await flushLocalBatch();
  expect(harness.applyAttempts.map(({ seq }) => seq)).toEqual([1]);
  expect(retained.snapshot.saveState).toBe("saving");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(218);
  });
  expect(harness.applyAttempts.map(({ seq }) => seq)).toEqual([1, 1, 2]);
  expect(harness.applied.map(({ seq }) => seq)).toEqual([1, 2]);

  // Even after transport recovery, the first batch's settle cannot vouch for
  // the later edit. Only the acknowledgement covering sequence 2 may clear it.
  harness.emit("saved", 1);
  expect(retained.snapshot.saveState).toBe("saving");
  harness.emit("saved", 2);
  expect(retained.snapshot.saveState).toBe("saved");
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
  retainDocument(path, kind);
  await waitFor(() =>
    expect(retained.snapshot.outcome?.kind).toBe("bound"),
  );

  act(() => editOversizedDocument());
  await flushLocalBatch();

  expect(harness.applyAttempts).toEqual([]);
  expect(retained.snapshot.saveState).toBe("error");
  expect(retained.snapshot.saveError).toContain(
    `ENGINE_YDOC_UPDATE_MAX_BYTES is ${ENGINE_YDOC_UPDATE_MAX_BYTES} bytes`,
  );
  expect(retained.snapshot.saveError).toMatch(
    /the update is \d+ bytes/,
  );
  await waitFor(() =>
    expect(drafts.result.current.at(-1)).toBeDefined(),
  );
  expect((drafts.result.current.at(-1)?.text.length ?? 0)).toBeGreaterThan(
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
  try {
    retainDocument("drawing.excalidraw", "scene");
    await waitFor(() =>
      expect(retained.snapshot.outcome?.kind).toBe("bound"),
    );

    act(() => editOversizedDocument());
    await flushLocalBatch();

    expect(retained.snapshot.permanentFailure?.token).toBe(boundOutcome().token);
    expect(retained.snapshot.sceneRecoveryAssets).toEqual({ token: boundOutcome().token, state: "loading", count: 1 });
    const immediate = parseExcalidrawDocument(
      drafts.result.current.at(-1)?.text!,
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
      expect(retained.snapshot).toMatchObject({
        outcome: { kind: "bound" },
        sceneRecoveryAssets: null,
      }),
    );
    const recovered = parseExcalidrawDocument(
      drafts.result.current.at(-1)?.text!,
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
  } finally {
    resolveAsset({ descriptor: IMAGE_DESCRIPTOR, bytes: new Uint8Array([1, 2, 3]) });
  }
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
  retainDocument("drawing.excalidraw", "scene");
  await waitFor(() =>
    expect(retained.snapshot.outcome?.kind).toBe("bound"),
  );

  act(() => editOversizedDocument());
  await flushLocalBatch();

  await waitFor(() =>
    expect(retained.snapshot.sceneRecoveryAssets).toEqual({ token: boundOutcome().token, state: "missing", count: 1 }),
  );
  const recovered = parseExcalidrawDocument(
    drafts.result.current.at(-1)?.text!,
  );
  expect(recovered.files).toEqual({});
  expect(recovered.elements).toContainEqual(
    expect.objectContaining({ id: "image-element", fileId: null }),
  );
});

it("ignores a save-state report addressed to a different session", async () => {
  await retainBound();

  act(() => {
    editDocument();
  });
  await flushLocalBatch();
  const seq = harness.applied.at(-1)!.seq;

  // Another document's settle must never repaint this one (the renderer
  // async-state invariant): right seq, wrong session id.
  harness.emit("saved", seq, "eyd-someone-else");
  expect(retained.snapshot.saveState).toBe("saving");

  harness.emit("saved", seq);
  await waitFor(() =>
    expect(retained.snapshot.saveState).toBe("saved"),
  );
});
