// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as Y from "yjs";
import { insertElementRevision, putSceneAsset } from "@dohc/excalidraw-scene";
import { ENGINE_YDOC_UPDATE_MAX_BYTES } from "../../ipc/channels";
import {
  resetOrphanedDrafts,
  useOrphanedDrafts,
} from "../orphanedDrafts";
import { disposeEngineDocLeasesForTests } from "./engineDocLease";
import { useEngineDoc } from "./useEngineDoc";
import { useAuthorCapacityNotice } from "./useAuthorCapacityNotice";
import { harnessBridge, IMAGE_DESCRIPTOR } from "./engineDocSaveStateTestHarness";
import { parseExcalidrawDocument } from "../excalidrawDocument";

let lastBoundDoc: Y.Doc | null = null;

function Harness(props: {
  workspaceId: string;
  path: string;
  enabled?: boolean;
  kind?: "richdoc" | "scene";
  compactDraft?: boolean;
  reportError?: Parameters<typeof useAuthorCapacityNotice>[0]["reportError"];
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
  useAuthorCapacityNotice({
    workspaceId: props.workspaceId, path: props.path,
    authorCapacity: engine.authorCapacity, saveState: engine.saveState,
    reportError: props.reportError, retry: () => setRetryKey((n) => n + 1),
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
      <span data-testid="text">{engine.doc?.getText("plainText").toString() ?? "none"}</span>
      <button
        type="button"
        data-testid="hydrate-assets"
        onClick={() => {
          void Promise.all(
            engine.artifactAssets.map((asset) =>
              engine.readArtifactAsset(asset),
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

afterEach(async () => {
  cleanup();
  await disposeEngineDocLeasesForTests();
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

it("reports host acceptance only for the current local edit", async () => {
  render(<Harness workspaceId="ws-1" path="notes/a.md" />);
  await waitFor(() => expect(screen.getByTestId("available").textContent).toBe("true"));
  act(() => screen.getByTestId("type").click());
  await waitFor(() => expect(harness.applyAttempts).toHaveLength(1));
  act(() => harness.emitNow("saved-to-host", 1));
  await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("saved-to-host"));
  act(() => screen.getByTestId("type").click());
  await waitFor(() => expect(harness.applyAttempts).toHaveLength(2));
  act(() => harness.emitNow("pending-share", 2));
  act(() => harness.emitNow("saved-to-host", 1));
  expect(screen.getByTestId("state").textContent).toBe("pending-share");
  act(() => harness.emitNow("saved-to-host", 2));
  expect(screen.getByTestId("state").textContent).toBe("saved-to-host");
});

it("keeps a failed lineage handoff visible and read-only", async () => {
  await mountBound();
  const retired = lastBoundDoc!;
  harness.setLineageReplacementFailure(new Error("acknowledgement refused"));

  act(() => screen.getByTestId("type").click());
  harness.emitLineageReplacement("winner");

  await waitFor(() =>
    expect(screen.getByTestId("state").textContent).toBe("error"),
  );
  expect(screen.getByTestId("available").textContent).toBe("true");
  expect(screen.getByTestId("read-only-transition").textContent).toBe("true");
  expect(screen.getByTestId("save-error").textContent).toContain(
    "acknowledgement refused",
  );
  expect(screen.getByTestId("draft").textContent).toBe("seed!");
  expect(lastBoundDoc).toBe(retired);

  const attemptsBefore = harness.applyAttempts.length;
  act(() => screen.getByTestId("type").click());
  await flushLocalBatch();
  expect(harness.applyAttempts).toHaveLength(attemptsBefore);
});

it("keeps a refused lineage acknowledgement visible and read-only", async () => {
  await mountBound();
  harness.setLineageReplacementRefusal("session-unavailable");

  act(() => screen.getByTestId("type").click());
  harness.emitLineageReplacement("winner");

  await waitFor(() =>
    expect(screen.getByTestId("state").textContent).toBe("error"),
  );
  expect(screen.getByTestId("read-only-transition").textContent).toBe("true");
  expect(screen.getByTestId("save-error").textContent).toContain(
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
  render(
    <Harness workspaceId="ws-1" path="drawing.excalidraw" kind="scene" />,
  );
  await waitFor(() =>
    expect(screen.getByTestId("available").textContent).toBe("true"),
  );
  expect(readAsset).not.toHaveBeenCalled();

  act(() => screen.getByTestId("type").click());
  harness.emitLineageReplacement("unused", [winner]);
  winnerOwnsReader = true;

  await waitFor(() =>
    expect(screen.getByTestId("read-only-transition").textContent).toBe("true"),
  );
  expect(screen.getByTestId("artifact-asset-ids").textContent).toBe(loser.id);
  act(() => screen.getByTestId("hydrate-assets").click());
  await waitFor(() =>
    expect(screen.getByTestId("hydrated-assets").textContent).toBe(loser.id),
  );
});

it("clears a permanent refusal when an independent lineage wins", async () => {
  const view = render(<Harness workspaceId="ws-1" path="notes/big.md" />);
  await waitFor(() =>
    expect(screen.getByTestId("available").textContent).toBe("true"),
  );
  harness.rejectNextApplyAsTooLarge();

  act(() => screen.getByTestId("type").click());
  await flushLocalBatch();
  expect(
    screen.getByTestId("permanent-failure-transition").textContent,
  ).toBe("true");
  await waitFor(() =>
    expect(screen.getByTestId("draft").textContent).toBe("seed!"),
  );

  harness.emitLineageReplacement("winner");
  await waitFor(() =>
    expect(
      screen.getByTestId("permanent-failure-transition").textContent,
    ).toBe("false"),
  );
  expect(screen.getByTestId("available").textContent).toBe("true");

  act(() => screen.getByTestId("type").click());
  await flushLocalBatch();
  expect(harness.applied).toHaveLength(1);
  expect(screen.getByTestId("state").textContent).toBe("saving");

  view.rerender(
    <Harness workspaceId="ws-1" path="notes/big.md" enabled={false} />,
  );
  await waitFor(() =>
    expect(screen.getByTestId("available").textContent).toBe("false"),
  );
  expect(screen.getByTestId("draft").textContent).toBe("seed!");
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
  await waitFor(() =>
    expect(screen.getByTestId("state").textContent).toBe("saving"),
  );
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
  expect(screen.getByTestId("asset-recovery").textContent).toBe("none");
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
  render(
    <Harness workspaceId="ws-1" path="drawing.excalidraw" kind="scene" />,
  );
  await waitFor(() =>
    expect(screen.getByTestId("available").textContent).toBe("true"),
  );
  const retired = lastBoundDoc!;

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

  expect(screen.getByTestId("asset-recovery").textContent).toBe("none");
  await act(async () => {
    resolveAsset({
      descriptor: IMAGE_DESCRIPTOR,
      bytes: new Uint8Array([1, 2, 3]),
    });
    await asset;
  });

  await waitFor(() => {
    const recovered = parseExcalidrawDocument(
      screen.getByTestId("draft").textContent!,
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
  expect(screen.getByTestId("available").textContent).toBe("true");
  expect(screen.getByTestId("asset-recovery").textContent).toBe("none");
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
  render(
    <Harness workspaceId="ws-1" path="drawing.excalidraw" kind="scene" />,
  );
  await waitFor(() =>
    expect(screen.getByTestId("available").textContent).toBe("true"),
  );

  act(() => screen.getByTestId("type").click());
  await waitFor(() =>
    expect(screen.getByTestId("state").textContent).toBe("saving"),
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
      screen.getByTestId("draft").textContent!,
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
  expect(screen.getByTestId("asset-recovery").textContent).toBe("none");
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
  act(() => screen.getByTestId("type").click());
  await flushLocalBatch();
  harness.emit("deleted", harness.applied.at(-1)!.seq);

  await waitFor(() => expect(readAsset).toHaveBeenCalledTimes(2));
  expect(screen.getByTestId("asset-recovery").textContent).toBe("loading:1");
  await act(async () => {
    resolveLoser({ descriptor: loser, bytes: new Uint8Array([9]) });
    await loserRead;
  });
  expect(screen.getByTestId("asset-recovery").textContent).toBe("loading:1");

  await act(async () => {
    resolveWinner({ descriptor: winner, bytes: new Uint8Array([1, 2, 3]) });
    await winnerRead;
  });
  await waitFor(() => {
    const recovered = parseExcalidrawDocument(
      screen.getByTestId("draft").textContent!,
    );
    expect(recovered.files[winner.id]).toMatchObject({
      dataURL: "data:image/png;base64,AQID",
    });
  });
  expect(screen.getByTestId("asset-recovery").textContent).toBe("none");
  expect(screen.getByTestId("draft").textContent).not.toContain("CQ==");
});

it("delivers the final mirror state before the final consumer closes and reopens", async () => {
  const view = render(
    <Harness workspaceId="ws-1" path="notes/big.md" enabled />,
  );
  await waitFor(() =>
    expect(screen.getByTestId("available").textContent).toBe("true"),
  );
  harness.rejectNextApplyAttempts(1);

  act(() => {
    screen.getByTestId("type").click();
  });
  await waitFor(() => expect(harness.applyAttempts).toHaveLength(2));
  expect(harness.applied).toHaveLength(1);

  view.unmount();
  await waitFor(() => expect(harness.closed).toHaveLength(1));

  render(<Harness workspaceId="ws-1" path="notes/big.md" enabled />);
  await waitFor(() =>
    expect(screen.getByTestId("available").textContent).toBe("true"),
  );
  expect(screen.getByTestId("text").textContent).toBe("seed!");
  expect(harness.applyAttempts).toHaveLength(2);
  expect(harness.applied).toHaveLength(1);
});

it("delivers a rejected edit before retry replaces the live session", async () => {
  render(<Harness workspaceId="ws-1" path="notes/big.md" enabled />);
  await waitFor(() =>
    expect(screen.getByTestId("available").textContent).toBe("true"),
  );
  harness.rejectNextApplyAttempts(1);

  act(() => {
    screen.getByTestId("type").click();
  });
  await waitFor(() => expect(harness.applyAttempts).toHaveLength(1));
  act(() => {
    screen.getByTestId("retry").click();
  });

  await waitFor(() => expect(harness.closed).toHaveLength(1));
  await waitFor(() =>
    expect(screen.getByTestId("available").textContent).toBe("true"),
  );
  expect(screen.getByTestId("text").textContent).toBe("seed!");
  expect(harness.applyAttempts).toHaveLength(2);
  expect(harness.applied).toHaveLength(1);
});

it("sets aside the final mirror when live repair and final delivery fail", async () => {
  const view = render(
    <Harness workspaceId="ws-1" path="notes/big.md" enabled />,
  );
  await waitFor(() =>
    expect(screen.getByTestId("available").textContent).toBe("true"),
  );
  harness.rejectNextApplyAttempts(3);

  act(() => {
    screen.getByTestId("type").click();
  });
  await waitFor(() => expect(harness.applyAttempts).toHaveLength(1));
  view.unmount();
  await waitFor(() => expect(harness.closed).toHaveLength(1));

  render(<Harness workspaceId="ws-1" path="notes/big.md" enabled />);
  await waitFor(() =>
    expect(screen.getByTestId("available").textContent).toBe("true"),
  );
  expect(screen.getByTestId("text").textContent).toBe("seed");
  expect(screen.getByTestId("draft").textContent).toBe("seed!");
  expect(harness.applyAttempts).toHaveLength(2);
  expect(harness.applied).toHaveLength(0);
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


it("reports a capacity refusal once with a guarded retry and keeps the edit", async () => {
  const reportError = vi.fn();
  const view = render(<Harness workspaceId="ws-1" path="notes/a.md" reportError={reportError} />);
  await waitFor(() => expect(screen.getByTestId("available").textContent).toBe("true"));
  act(() => screen.getByTestId("type").click());
  await flushLocalBatch();
  harness.emit("error", 1, undefined, true);
  expect(screen.getByTestId("save-error").textContent).toContain("too many authors waiting to save");
  expect(reportError).toHaveBeenCalledTimes(1);
  const [message, error, retry] = reportError.mock.calls[0]!;
  expect(message).toContain("notes/a.md");
  expect(error).toBeInstanceOf(Error);
  expect(retry).toBeTypeOf("function");
  harness.emit("error", 1, undefined, true);
  expect(reportError).toHaveBeenCalledTimes(1);
  const before = lastBoundDoc!.getText("plainText").toString();
  await act(async () => retry());
  await waitFor(() => expect(harness.openCount()).toBe(2));
  expect(lastBoundDoc!.getText("plainText").toString()).toBe(before);
  view.rerender(<Harness workspaceId="ws-2" path="notes/b.md" reportError={reportError} />);
  await waitFor(() => expect(harness.openCount()).toBe(3));
  act(() => retry());
  expect(harness.openCount()).toBe(3);
});
