// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as Y from "yjs";
import { insertElementRevision, putSceneAsset } from "@dohc/excalidraw-scene";
import { ENGINE_YDOC_UPDATE_MAX_BYTES } from "../../ipc/channels";
import { resetOrphanedDrafts, useOrphanedDrafts } from "../orphanedDrafts";
import { disposeEngineDocLeasesForTests } from "./engineDocLease";
import { useEngineDoc } from "./useEngineDoc";
import { useAuthorCapacityNotice } from "./useAuthorCapacityNotice";
import { harnessBridge, IMAGE_DESCRIPTOR } from "./engineDocSaveStateTestHarness";
import { parseExcalidrawDocument } from "../excalidrawDocument";

vi.mock("../../ipc/channels", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../ipc/channels")>()),
  ENGINE_YDOC_UPDATE_MAX_BYTES: 4 * 1024,
}));

let projectionFails = false;
vi.mock("@dohc/ydoc-projection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dohc/ydoc-projection")>();
  return {
    ...actual,
    yDocToMarkdown: (doc: Y.Doc) => {
      if (projectionFails) throw new Error("projection failed");
      return actual.yDocToMarkdown(doc);
    },
    yDocToArtifactMarkdown: (doc: Y.Doc) => {
      if (projectionFails) throw new Error("projection failed");
      return actual.yDocToArtifactMarkdown(doc);
    },
  };
});

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
    workspaceId: props.workspaceId,
    path: props.path,
    authorCapacity: engine.authorCapacity,
    saveState: engine.saveState,
    reportError: props.reportError,
    retry: () => setRetryKey((n) => n + 1),
  });
  if (engine.doc !== null) lastBoundDoc = engine.doc;
  const drafts = useOrphanedDrafts(props.workspaceId, props.path);
  return (
    <div>
      <span data-testid="state">{engine.goneCause ?? engine.saveState.kind}</span>
      <span data-testid="save-error">{engine.saveError ?? "none"}</span>
      <span data-testid="available">{String(engine.available)}</span>
      <span data-testid="artifact-assets-invalid">{String(engine.artifactAssetsInvalid)}</span>
      <span data-testid="engine-may-hold-document">{String(engine.engineMayHoldDocument)}</span>
      <span data-testid="deleted">{String(engine.deletedWhileEditing)}</span>
      <span data-testid="read-only-transition">{String(engine.readOnlyWhileEditing)}</span>
      <span data-testid="read-only-cause">{engine.readOnlyCause ?? "none"}</span>
      <span data-testid="permanent-failure-transition">
        {String(engine.permanentFailureWhileEditing)}
      </span>
      <span data-testid="draft">
        {props.compactDraft
          ? drafts.at(-1)
            ? "present"
            : "none"
          : (drafts.at(-1)?.text ?? "none")}
      </span>
      <span data-testid="draft-size">{String(drafts.at(-1)?.text.length ?? 0)}</span>
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
            engine.artifactAssets.map((asset) => engine.readArtifactAsset(asset)),
          ).then((loaded) =>
            setHydratedAssets(loaded.map(({ descriptor }) => descriptor.id).join(",")),
          );
        }}
      >
        hydrate assets
      </button>
      <span data-testid="removal-operation">{engine.removalInProgress?.operation ?? "none"}</span>
      <span data-testid="removal-message">{engine.removalInProgress?.message ?? "none"}</span>
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
          engine.doc?.getText("plainText").insert(0, "x".repeat(ENGINE_YDOC_UPDATE_MAX_BYTES + 1));
        }}
      >
        type oversized
      </button>
    </div>
  );
}

let harness: ReturnType<typeof harnessBridge>;
let releaseDeferredDelivery: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  harness = harnessBridge();
  vi.stubGlobal("dohcDesktop", harness.api);
  resetOrphanedDrafts();
  lastBoundDoc = null;
  projectionFails = false;
});

afterEach(async () => {
  // Teardown waits for every acknowledgement, including one a failed test
  // left in flight.
  releaseDeferredDelivery?.();
  releaseDeferredDelivery = null;
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

// Main accepts edit 1 and reports it pending, then saved to host, while the
// bridge response to that edit is still in flight. The host save waits for
// the response, and no later event follows it.
async function bufferHostSaveBehindDeferredResponse() {
  const response = new Promise<void>((resolve) => {
    releaseDeferredDelivery = resolve;
  });
  const apply = harness.api.applyEngineYDocUpdate;
  harness.api.applyEngineYDocUpdate = async (payload) => {
    const accepted = await apply(payload);
    await response;
    return accepted;
  };
  const hook = renderHook(() =>
    useEngineDoc({ workspaceId: "ws-1", path: "notes/a.md", enabled: true }),
  );
  await waitFor(() => expect(hook.result.current.available).toBe(true));
  let delivered!: Promise<void>;
  act(() => {
    const text = hook.result.current.doc!.getText("plainText");
    text.insert(text.length, "!");
    delivered = hook.result.current.flushPendingLocalUpdates();
  });
  await waitFor(() =>
    expect(harness.applied).toEqual([{ sessionId: harness.sessionId(), seq: 1 }]),
  );
  act(() => harness.emitNow("pending-share", 1));
  act(() => harness.emitNow("saved-to-host", 1));
  expect(hook.result.current.saveState.kind).toBe("pending-share");
  return {
    hook,
    finishDelivery: () =>
      act(async () => {
        releaseDeferredDelivery!();
        await delivered;
      }),
  };
}

it("keeps a failed lineage handoff visible and read-only", async () => {
  await mountBound();
  const retired = lastBoundDoc!;
  harness.setLineageReplacementFailure(new Error("acknowledgement refused"));

  act(() => screen.getByTestId("type").click());
  harness.emitLineageReplacement("winner");

  await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("error"));
  expect(screen.getByTestId("available").textContent).toBe("true");
  expect(screen.getByTestId("read-only-transition").textContent).toBe("true");
  expect(screen.getByTestId("read-only-cause").textContent).toBe("lineage-failure");
  expect(screen.getByTestId("save-error").textContent).toContain("acknowledgement refused");
  expect(screen.getByTestId("draft").textContent).toBe("seed!");
  expect(lastBoundDoc).toBe(retired);

  const attemptsBefore = harness.applyAttempts.length;
  act(() => screen.getByTestId("type").click());
  await flushLocalBatch();
  expect(harness.applyAttempts).toHaveLength(attemptsBefore);
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
  let resolveLoser!: (value: { descriptor: typeof loser; bytes: Uint8Array }) => void;
  let resolveWinner!: (value: { descriptor: typeof winner; bytes: Uint8Array }) => void;
  const loserRead = new Promise<{ descriptor: typeof loser; bytes: Uint8Array }>((resolve) => {
    resolveLoser = resolve;
  });
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
  render(<Harness workspaceId="ws-1" path="drawing.excalidraw" kind="scene" />);
  await waitFor(() => expect(screen.getByTestId("available").textContent).toBe("true"));

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
    const recovered = parseExcalidrawDocument(screen.getByTestId("draft").textContent!);
    expect(recovered.files[winner.id]).toMatchObject({
      dataURL: "data:image/png;base64,AQID",
    });
  });
  expect(screen.getByTestId("asset-recovery").textContent).toBe("none");
  expect(screen.getByTestId("draft").textContent).not.toContain("CQ==");
});

it("delivers the final mirror state before the final consumer closes and reopens", async () => {
  const view = render(<Harness workspaceId="ws-1" path="notes/big.md" enabled />);
  await waitFor(() => expect(screen.getByTestId("available").textContent).toBe("true"));
  harness.rejectNextApplyAttempts(1);

  act(() => {
    screen.getByTestId("type").click();
  });
  await waitFor(() => expect(harness.applyAttempts).toHaveLength(2));
  expect(harness.applied).toHaveLength(1);

  view.unmount();
  await waitFor(() => expect(harness.closed).toHaveLength(1));

  render(<Harness workspaceId="ws-1" path="notes/big.md" enabled />);
  await waitFor(() => expect(screen.getByTestId("available").textContent).toBe("true"));
  expect(screen.getByTestId("text").textContent).toBe("seed!");
  expect(harness.applyAttempts).toHaveLength(2);
  expect(harness.applied).toHaveLength(1);
});

it("sets aside the final mirror when live repair and final delivery fail", async () => {
  const view = render(<Harness workspaceId="ws-1" path="notes/big.md" enabled />);
  await waitFor(() => expect(screen.getByTestId("available").textContent).toBe("true"));
  harness.rejectNextApplyAttempts(3);

  act(() => {
    screen.getByTestId("type").click();
  });
  await waitFor(() => expect(harness.applyAttempts).toHaveLength(1));
  view.unmount();
  await waitFor(() => expect(harness.closed).toHaveLength(1));

  render(<Harness workspaceId="ws-1" path="notes/big.md" enabled />);
  await waitFor(() => expect(screen.getByTestId("available").textContent).toBe("true"));
  expect(screen.getByTestId("text").textContent).toBe("seed");
  expect(screen.getByTestId("draft").textContent).toBe("seed!");
  expect(harness.applyAttempts).toHaveLength(2);
  expect(harness.applied).toHaveLength(0);
});

it("sets aside a refused scene, freezes writes, and releases the session", async () => {
  harness = harnessBridge("scene");
  vi.stubGlobal("dohcDesktop", harness.api);
  render(<Harness workspaceId="ws-1" path="drawing.excalidraw" kind="scene" />);
  await waitFor(() => expect(screen.getByTestId("available").textContent).toBe("true"));

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

  expect(screen.getByTestId("state").textContent).toBe("unknown");
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

// A winning lineage carries none of this window's edits. An unsaved edit on
// the retired document keeps its own draft, so a later read-only status sets
// aside only an edit made on the winner.
async function replaceAfterDeliveredEdit(options: { saved: boolean }) {
  await mountBound();
  const drafts = renderHook(() => useOrphanedDrafts("ws-1", "notes/big.md"));
  act(() => screen.getByTestId("type").click());
  await flushLocalBatch();
  expect(harness.applied).toHaveLength(1);
  if (options.saved) {
    act(() => harness.emitNow("saved", harness.applied.at(-1)!.seq));
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("saved-here"));
  }

  harness.emitLineageReplacement("winner");
  await waitFor(() => expect(screen.getByTestId("text").textContent).toBe("winner"));
  expect(screen.getByTestId("state").textContent).toBe("unknown");
  return drafts;
}

it("sets aside a winner edit beside the retired draft when read-only follows it", async () => {
  const drafts = await replaceAfterDeliveredEdit({ saved: false });
  await waitFor(() => expect(drafts.result.current.map((draft) => draft.text)).toEqual(["seed!"]));
  const retired = drafts.result.current[0]!;
  act(() => screen.getByTestId("type").click());
  await flushLocalBatch();
  expect(harness.applied).toHaveLength(2);

  act(() => harness.emitNow("read-only", 0));

  expect(screen.getByTestId("read-only-transition").textContent).toBe("true");
  await waitFor(() =>
    expect(drafts.result.current.map((draft) => draft.text).sort()).toEqual(["seed!", "winner!"]),
  );
  expect(drafts.result.current.find((draft) => draft.id === retired.id)).toEqual(retired);
  await waitFor(() => expect(harness.closed).toHaveLength(1));
});

// A received share's live host reports saved-to-host once it has accepted
// every pending edit, then read-only when access ends.
async function mountHostAcknowledgedDocument() {
  const hook = renderHook(() =>
    useEngineDoc({ workspaceId: "ws-1", path: "notes/a.md", enabled: true }),
  );
  const drafts = renderHook(() => useOrphanedDrafts("ws-1", "notes/a.md"));
  await waitFor(() => expect(hook.result.current.available).toBe(true));
  const typeAndDeliver = async (delivered: number) => {
    act(() => {
      const text = hook.result.current.doc!.getText("plainText");
      text.insert(text.length, "!");
    });
    expect(hook.result.current.saveState.kind).toBe("saving");
    await act(async () => {
      await hook.result.current.flushPendingLocalUpdates();
    });
    expect(harness.applied).toHaveLength(delivered);
  };
  return { hook, drafts, typeAndDeliver };
}

it("host acknowledgement recovery keeps a draft when read-only precedes the delivery response", async () => {
  const { hook, finishDelivery } = await bufferHostSaveBehindDeferredResponse();
  const drafts = renderHook(() => useOrphanedDrafts("ws-1", "notes/a.md"));

  act(() => harness.emitNow("read-only", 0));

  expect(hook.result.current.readOnlyWhileEditing).toBe(true);
  expect(hook.result.current.saveState.kind).toBe("unknown");
  await waitFor(() => expect(drafts.result.current.map((draft) => draft.text)).toEqual(["seed!"]));
  expect(harness.closed).toEqual([]);

  await finishDelivery();
  await waitFor(() => expect(harness.closed).toHaveLength(1));
  expect(hook.result.current.saveState.kind).toBe("unknown");
  expect(drafts.result.current.map((draft) => draft.text)).toEqual(["seed!"]);
});

it("host acknowledgement recovery sets nothing aside when the delivery response completes a host save", async () => {
  const { hook, finishDelivery } = await bufferHostSaveBehindDeferredResponse();
  const drafts = renderHook(() => useOrphanedDrafts("ws-1", "notes/a.md"));

  await finishDelivery();
  expect(hook.result.current.saveState.kind).toBe("saved-to-host");

  act(() => harness.emitNow("read-only", 0));

  expect(hook.result.current.readOnlyWhileEditing).toBe(true);
  expect(hook.result.current.saveState.kind).toBe("unknown");
  await waitFor(() => expect(harness.closed).toHaveLength(1));
  expect(drafts.result.current).toEqual([]);
});

it.each([
  ["completes", false],
  ["fails", true],
])(
  "names a keystroke's draft after a clean read-only status when projection %s",
  async (_, fails) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { hook, drafts, typeAndDeliver } = await mountHostAcknowledgedDocument();
    await typeAndDeliver(1);
    act(() => harness.emitNow("saved", harness.applied.at(-1)!.seq));
    expect(hook.result.current.saveState.kind).toBe("saved-here");
    const doc = hook.result.current.doc!;
    projectionFails = fails;

    act(() => {
      harness.emitNow("read-only", 0);
      const text = doc.getText("plainText");
      text.insert(text.length, "!");
    });

    const draftId = hook.result.current.readOnlyDraftId;
    expect(hook.result.current.readOnlyWhileEditing).toBe(true);
    expect(draftId).not.toBeNull();
    await waitFor(() =>
      expect(drafts.result.current.map(({ id, text }) => ({ id, text }))).toEqual([
        { id: draftId, text: "seed!!" },
      ]),
    );
    await waitFor(() => expect(harness.closed).toHaveLength(1));
    const refineFailure = [
      expect.stringContaining("could not refine the recovery draft"),
      expect.any(Error),
    ];
    if (fails) {
      await waitFor(() => expect(consoleError).toHaveBeenCalledWith(...refineFailure));
    } else {
      expect(consoleError).not.toHaveBeenCalledWith(...refineFailure);
    }
    expect(hook.result.current.readOnlyDraftId).toBe(draftId);
    expect(drafts.result.current.map(({ id, text }) => ({ id, text }))).toEqual([
      { id: draftId, text: "seed!!" },
    ]);
    consoleError.mockRestore();
  },
);

it("upgrades one deleted-scene draft with its verified image bytes", async () => {
  harness = harnessBridge("scene");
  const bytes = new Uint8Array(50 * 1024 + 8);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(bytes.byteLength).toBeGreaterThan(48 * 1024);
  let resolveAsset!: (value: { descriptor: typeof IMAGE_DESCRIPTOR; bytes: Uint8Array }) => void;
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
  render(<Harness workspaceId="ws-1" path="drawing.excalidraw" kind="scene" />);
  await waitFor(() => expect(screen.getByTestId("available").textContent).toBe("true"));

  act(() => screen.getByTestId("type").click());
  await flushLocalBatch();
  harness.emit("deleted", harness.applied.at(-1)!.seq);

  expect(readAsset).toHaveBeenCalledOnce();
  expect(screen.getByTestId("asset-recovery").textContent).toBe("loading:1");
  expect(screen.getByTestId("draft-count").textContent).toBe("1");
  const immediate = JSON.parse(screen.getByTestId("draft").textContent!);
  expect(immediate.files).toEqual({});
  expect(
    immediate.elements.find((element: { id: string }) => element.id === "image-element").fileId,
  ).toBeNull();

  // One last canvas callback can land before the read-only render commits.
  // Its immediate snapshot must not wait behind the older image read, and the
  // older async completion must not restore the previous scene revision.
  act(() => screen.getByTestId("type").click());
  await waitFor(() => {
    const latest = JSON.parse(screen.getByTestId("draft").textContent!);
    expect(
      latest.elements.find((element: { id: string }) => element.id === "recovered-shape").x,
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
  render(<Harness workspaceId="ws-1" path="drawing.excalidraw" kind="scene" />);
  await waitFor(() => expect(screen.getByTestId("available").textContent).toBe("true"));

  act(() => screen.getByTestId("type").click());
  await flushLocalBatch();
  harness.emit("deleted", harness.applied.at(-1)!.seq);

  await waitFor(() => expect(screen.getByTestId("asset-recovery").textContent).toBe("missing:1"));
  const recovered = parseExcalidrawDocument(screen.getByTestId("draft").textContent!);
  expect(recovered.files).toEqual({});
  expect(recovered.elements).toContainEqual(
    expect.objectContaining({ id: "image-element", fileId: null }),
  );
});

it("keeps invalid scene asset authority as a distinct unavailable outcome", async () => {
  harness = harnessBridge("scene");
  harness.setArtifactAssetsInvalid(true);
  vi.stubGlobal("dohcDesktop", harness.api);
  render(<Harness workspaceId="ws-1" path="drawing.excalidraw" kind="scene" />);

  await waitFor(() =>
    expect(screen.getByTestId("artifact-assets-invalid").textContent).toBe("true"),
  );
  expect(screen.getByTestId("available").textContent).toBe("false");
  expect(screen.getByTestId("engine-may-hold-document").textContent).toBe("false");
  expect(screen.getByTestId("removal-operation").textContent).toBe("none");
});

it.each([
  { kind: "richdoc" as const, path: "notes/big.md" },
  { kind: "scene" as const, path: "drawing.excalidraw" },
])("sets aside an oversized $kind edit and reports the measured limit", async ({ kind, path }) => {
  harness = harnessBridge(kind);
  vi.stubGlobal("dohcDesktop", harness.api);
  render(<Harness workspaceId="ws-1" path={path} kind={kind} compactDraft />);
  await waitFor(() => expect(screen.getByTestId("available").textContent).toBe("true"));

  act(() => screen.getByTestId("type-oversized").click());
  await flushLocalBatch();

  expect(harness.applyAttempts).toEqual([]);
  expect(screen.getByTestId("state").textContent).toBe("error");
  expect(screen.getByTestId("save-error").textContent).toContain(
    `ENGINE_YDOC_UPDATE_MAX_BYTES is ${ENGINE_YDOC_UPDATE_MAX_BYTES} bytes`,
  );
  expect(screen.getByTestId("save-error").textContent).toMatch(/the update is \d+ bytes/);
  await waitFor(() => expect(screen.getByTestId("draft").textContent).toBe("present"));
  expect(Number(screen.getByTestId("draft-size").textContent)).toBeGreaterThan(
    ENGINE_YDOC_UPDATE_MAX_BYTES,
  );
});

it("reports a capacity refusal once with a guarded retry and keeps the edit", async () => {
  const reportError = vi.fn();
  const view = render(<Harness workspaceId="ws-1" path="notes/a.md" reportError={reportError} />);
  await waitFor(() => expect(screen.getByTestId("available").textContent).toBe("true"));
  act(() => screen.getByTestId("type").click());
  await flushLocalBatch();
  harness.emit("error", 1, undefined, true);
  expect(screen.getByTestId("save-error").textContent).toContain(
    "too many authors have unsaved edits",
  );
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
