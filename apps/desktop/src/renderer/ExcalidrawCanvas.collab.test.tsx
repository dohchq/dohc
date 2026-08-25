// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { declareSceneRoots, foldScene, insertElementRevision } from "@dohc/excalidraw-scene";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import * as Y from "yjs";
import type { PresenceTransport } from "./collab/presenceChannel";

const excalidraw = vi.hoisted(() => {
  let rendering = false;
  let apiHeld = false;
  let pendingApiCallback: ((api: unknown) => void) | null = null;
  const updateScene = vi.fn(() => {
    if (rendering) {
      throw new Error("The Excalidraw API was used during child render.");
    }
  });
  const addFiles = vi.fn();
  const defaultApi = { updateScene, addFiles };
  let currentApi = defaultApi;
  return {
    updateScene,
    addFiles,
    get api() {
      return currentApi;
    },
    props: null as null | Record<string, unknown>,
    beginRender: () => {
      rendering = true;
    },
    endRender: () => {
      rendering = false;
    },
    holdApi: () => {
      apiHeld = true;
    },
    deliverApi: () => {
      apiHeld = false;
      const callback = pendingApiCallback;
      pendingApiCallback = null;
      callback?.(excalidraw.api);
    },
    receiveApiCallback: (callback: ((api: unknown) => void) | undefined) => {
      if (!callback) return;
      if (apiHeld) {
        pendingApiCallback = callback;
      } else {
        callback(excalidraw.api);
      }
    },
    replaceApi: (replacement: typeof defaultApi) => {
      currentApi = replacement;
    },
    resetApiDelivery: () => {
      currentApi = defaultApi;
      apiHeld = false;
      pendingApiCallback = null;
    },
  };
});

vi.mock("@excalidraw/excalidraw", () => ({
  CaptureUpdateAction: { NEVER: "never" },
  Excalidraw: (props: Record<string, unknown>) => {
    excalidraw.props = props;
    excalidraw.beginRender();
    try {
      excalidraw.receiveApiCallback(
        props.excalidrawAPI as ((api: unknown) => void) | undefined,
      );
    } finally {
      excalidraw.endRender();
    }
    return null;
  },
  restore: vi.fn(),
  serializeAsJSON: vi.fn(),
}));

import ExcalidrawCanvas from "./ExcalidrawCanvas";
import { EMPTY_EXCALIDRAW_DOCUMENT, parseExcalidrawDocument } from "./excalidrawDocument";

function rectangle(version: number, nonce: number, x: number) {
  return {
    id: "shape",
    type: "rectangle",
    version,
    versionNonce: nonce,
    isDeleted: false,
    index: "a0",
    x,
  };
}

function trackedPresenceTransport() {
  let pollCalls = 0;
  let leaveCalls = 0;
  const activePolls = new Set<AbortSignal>();
  const transport: PresenceTransport = {
    async publish() {
      return { version: 1, peers: [] };
    },
    async leave() {
      leaveCalls += 1;
    },
    poll: ({ signal }) => {
      pollCalls += 1;
      activePolls.add(signal);
      return new Promise((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            activePolls.delete(signal);
            resolve({ version: 1, peers: [] });
          },
          { once: true },
        );
      });
    },
  };
  return {
    transport,
    activePolls: () => activePolls.size,
    pollCalls: () => pollCalls,
    leaveCalls: () => leaveCalls,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  excalidraw.updateScene.mockReset();
  excalidraw.addFiles.mockReset();
  excalidraw.props = null;
  excalidraw.resetApiDelivery();
});

it("adopts an API whose ready microtask drains before commit", async () => {
  const doc = new Y.Doc();
  declareSceneRoots(doc);
  insertElementRevision(doc, rectangle(1, 10, 20));
  const presence = trackedPresenceTransport();
  const hydrateAssets = vi.fn(async () => [
    { id: "image", dataURL: "data:image/png;base64,QQ==" },
  ] as never);
  vi.stubGlobal("queueMicrotask", (callback: VoidFunction) => callback());

  render(
    <ExcalidrawCanvas
      document={parseExcalidrawDocument(EMPTY_EXCALIDRAW_DOCUMENT)}
      readOnly={false}
      sceneDoc={doc}
      hydrateAssets={hydrateAssets}
      presence={{
        topic: "scene-1",
        clientId: "client-1",
        displayName: "Alice",
        transport: presence.transport,
      }}
    />,
  );

  await waitFor(() => {
    expect(excalidraw.updateScene).toHaveBeenCalledWith(
      expect.objectContaining({
        elements: [expect.objectContaining({ id: "shape", x: 20 })],
      }),
    );
    expect(hydrateAssets).toHaveBeenCalledOnce();
    expect(excalidraw.addFiles).toHaveBeenCalledOnce();
    expect(excalidraw.props?.isCollaborating).toBe(true);
    expect(presence.activePolls()).toBe(1);
  });
});

it("keeps asset installation best-effort when Excalidraw rejects the files", async () => {
  const doc = new Y.Doc();
  declareSceneRoots(doc);
  const hydrateAssets = vi.fn(async () => [
    { id: "image", dataURL: "data:image/png;base64,QQ==" },
  ] as never);
  excalidraw.addFiles.mockImplementationOnce(() => {
    throw new Error("asset install failed");
  });

  render(
    <ExcalidrawCanvas
      document={parseExcalidrawDocument(EMPTY_EXCALIDRAW_DOCUMENT)}
      readOnly={false}
      sceneDoc={doc}
      hydrateAssets={hydrateAssets}
    />,
  );

  await waitFor(() => expect(excalidraw.addFiles).toHaveBeenCalledOnce());
  excalidraw.updateScene.mockClear();
  act(() => insertElementRevision(doc, rectangle(1, 10, 20)));
  expect(excalidraw.updateScene).toHaveBeenCalledWith(
    expect.objectContaining({
      elements: [expect.objectContaining({ id: "shape", x: 20 })],
    }),
  );
  await act(async () => {});
});

it("rejects hydration once Excalidraw replaces its imperative API", async () => {
  const doc = new Y.Doc();
  declareSceneRoots(doc);
  let resolveRetired!: (files: never) => void;
  const retired = new Promise<never>((resolve) => {
    resolveRetired = resolve;
  });
  const hydrateAssets = vi
    .fn()
    .mockImplementationOnce(() => retired)
    .mockImplementationOnce(() => new Promise<never>(() => {}));
  render(
    <ExcalidrawCanvas
      document={parseExcalidrawDocument(EMPTY_EXCALIDRAW_DOCUMENT)}
      readOnly={false}
      sceneDoc={doc}
      hydrateAssets={hydrateAssets}
    />,
  );
  await waitFor(() => expect(hydrateAssets).toHaveBeenCalledOnce());

  const replacementAddFiles = vi.fn();
  const replacementApi = {
    updateScene: excalidraw.updateScene,
    addFiles: replacementAddFiles,
  };
  excalidraw.replaceApi(replacementApi);
  const replaceApi = excalidraw.props?.excalidrawAPI as (
    api: typeof replacementApi,
  ) => void;
  await act(async () => {
    // Resolve first so its continuation is already queued when the callback
    // replaces apiRef. The readyApi state update has not committed yet, so
    // only the exact imperative-API identity check can reject these files.
    resolveRetired([
      { id: "retired", dataURL: "data:image/png;base64,QQ==" },
    ] as never);
    replaceApi(replacementApi);
    await retired;
  });

  expect(excalidraw.addFiles).not.toHaveBeenCalled();
  expect(replacementAddFiles).not.toHaveBeenCalled();
  await waitFor(() => expect(hydrateAssets).toHaveBeenCalledTimes(2));
  expect(replacementAddFiles).not.toHaveBeenCalled();
});

it("ignores hydration failure from a replaced Excalidraw API", async () => {
  const doc = new Y.Doc();
  declareSceneRoots(doc);
  let rejectRetired!: (error: Error) => void;
  const retired = new Promise<never>((_resolve, reject) => {
    rejectRetired = reject;
  });
  const hydrateAssets = vi
    .fn()
    .mockImplementationOnce(() => retired)
    .mockImplementationOnce(() => new Promise<never>(() => {}));
  const onAssetRefusedChange = vi.fn();
  render(
    <ExcalidrawCanvas
      document={parseExcalidrawDocument(EMPTY_EXCALIDRAW_DOCUMENT)}
      readOnly={false}
      sceneDoc={doc}
      hydrateAssets={hydrateAssets}
      onAssetRefusedChange={onAssetRefusedChange}
    />,
  );
  await waitFor(() => expect(hydrateAssets).toHaveBeenCalledOnce());

  const replacementApi = {
    updateScene: excalidraw.updateScene,
    addFiles: vi.fn(),
  };
  excalidraw.replaceApi(replacementApi);
  const replaceApi = excalidraw.props?.excalidrawAPI as (
    api: typeof replacementApi,
  ) => void;
  await act(async () => {
    rejectRetired(new Error("retired hydration failed"));
    replaceApi(replacementApi);
    await retired.catch(() => undefined);
  });

  expect(onAssetRefusedChange).not.toHaveBeenCalled();
  await waitFor(() => expect(hydrateAssets).toHaveBeenCalledTimes(2));
  expect(onAssetRefusedChange).not.toHaveBeenCalled();
});

it("binds the initial scene after a production-scheduled mount", async () => {
  const doc = new Y.Doc();
  declareSceneRoots(doc);
  insertElementRevision(doc, rectangle(1, 10, 20));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  root.render(
    <ExcalidrawCanvas
      document={parseExcalidrawDocument(EMPTY_EXCALIDRAW_DOCUMENT)}
      readOnly={false}
      sceneDoc={doc}
    />,
  );
  try {
    for (
      let turn = 0;
      turn < 10 && !excalidraw.updateScene.mock.calls.length;
      turn += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(excalidraw.updateScene).toHaveBeenCalledWith(
      expect.objectContaining({
        elements: [expect.objectContaining({ id: "shape", x: 20 })],
      }),
    );
  } finally {
    root.unmount();
    container.remove();
  }
});

it("starts the scene, hydration, and presence after a delayed API callback", async () => {
  const doc = new Y.Doc();
  declareSceneRoots(doc);
  insertElementRevision(doc, rectangle(1, 10, 20));
  const presence = trackedPresenceTransport();
  const hydrateAssets = vi.fn(async () => [
    { id: "image", dataURL: "data:image/png;base64,QQ==" },
  ] as never);
  excalidraw.holdApi();

  render(
    <ExcalidrawCanvas
      document={parseExcalidrawDocument(EMPTY_EXCALIDRAW_DOCUMENT)}
      readOnly={false}
      sceneDoc={doc}
      hydrateAssets={hydrateAssets}
      presence={{
        topic: "scene-1",
        clientId: "client-1",
        displayName: "Alice",
        transport: presence.transport,
      }}
    />,
  );

  expect(excalidraw.updateScene).not.toHaveBeenCalled();
  expect(hydrateAssets).not.toHaveBeenCalled();
  expect(presence.pollCalls()).toBe(0);

  await act(async () => {
    excalidraw.deliverApi();
    await Promise.resolve();
  });

  await waitFor(() => {
    expect(excalidraw.updateScene).toHaveBeenCalledWith(
      expect.objectContaining({
        elements: [expect.objectContaining({ id: "shape", x: 20 })],
      }),
    );
    expect(excalidraw.addFiles).toHaveBeenCalledOnce();
    expect(excalidraw.props?.isCollaborating).toBe(true);
    expect(presence.activePolls()).toBe(1);
  });
});

it("keeps one scene, hydration, and presence binding through Strict Mode replay", async () => {
  const doc = new Y.Doc();
  declareSceneRoots(doc);
  const presence = trackedPresenceTransport();
  const hydrateAssets = vi.fn(async () => [
    { id: "image", dataURL: "data:image/png;base64,QQ==" },
  ] as never);

  render(
    <StrictMode>
      <ExcalidrawCanvas
        document={parseExcalidrawDocument(EMPTY_EXCALIDRAW_DOCUMENT)}
        readOnly={false}
        sceneDoc={doc}
        hydrateAssets={hydrateAssets}
        presence={{
          topic: "scene-1",
          clientId: "client-1",
          displayName: "Alice",
          transport: presence.transport,
        }}
      />
    </StrictMode>,
  );

  await waitFor(() => {
    expect(excalidraw.addFiles).toHaveBeenCalledOnce();
    expect(presence.activePolls()).toBe(1);
  });
  expect(presence.pollCalls()).toBe(1);

  excalidraw.updateScene.mockClear();
  act(() => insertElementRevision(doc, rectangle(1, 10, 20)));
  expect(excalidraw.updateScene).toHaveBeenCalledWith(
    expect.objectContaining({
      elements: [expect.objectContaining({ id: "shape", x: 20 })],
      captureUpdate: "never",
    }),
  );
  expect(presence.activePolls()).toBe(1);
  expect(presence.pollCalls()).toBe(1);
});

it("destroys the old presence binding on a scene switch and unmount", async () => {
  const firstDoc = new Y.Doc();
  const secondDoc = new Y.Doc();
  declareSceneRoots(firstDoc);
  declareSceneRoots(secondDoc);
  const firstPresence = trackedPresenceTransport();
  const secondPresence = trackedPresenceTransport();
  const view = render(
    <ExcalidrawCanvas
      document={parseExcalidrawDocument(EMPTY_EXCALIDRAW_DOCUMENT)}
      readOnly={false}
      sceneDoc={firstDoc}
      presence={{
        topic: "scene-1",
        clientId: "client-1",
        displayName: "Alice",
        transport: firstPresence.transport,
      }}
    />,
  );
  await waitFor(() => expect(firstPresence.activePolls()).toBe(1));

  view.rerender(
    <ExcalidrawCanvas
      document={parseExcalidrawDocument(EMPTY_EXCALIDRAW_DOCUMENT)}
      readOnly={false}
      sceneDoc={secondDoc}
      presence={{
        topic: "scene-2",
        clientId: "client-1",
        displayName: "Alice",
        transport: secondPresence.transport,
      }}
    />,
  );

  await waitFor(() => {
    expect(firstPresence.activePolls()).toBe(0);
    expect(firstPresence.leaveCalls()).toBe(1);
    expect(secondPresence.activePolls()).toBe(1);
  });
  expect(firstPresence.pollCalls()).toBe(1);
  expect(secondPresence.pollCalls()).toBe(1);

  view.unmount();
  await waitFor(() => {
    expect(secondPresence.activePolls()).toBe(0);
    expect(secondPresence.leaveCalls()).toBe(1);
  });
  expect(secondPresence.pollCalls()).toBe(1);
});

it("renders remote scene updates without echoing them", async () => {
  const doc = new Y.Doc();
  declareSceneRoots(doc);
  render(
    <ExcalidrawCanvas
      document={parseExcalidrawDocument(EMPTY_EXCALIDRAW_DOCUMENT)}
      readOnly={false}
      sceneDoc={doc}
    />,
  );
  await waitFor(() => expect(excalidraw.updateScene).toHaveBeenCalled());
  excalidraw.updateScene.mockClear();

  act(() => insertElementRevision(doc, rectangle(1, 10, 20)));
  expect(excalidraw.updateScene).toHaveBeenCalledWith(
    expect.objectContaining({
      elements: [expect.objectContaining({ id: "shape", x: 20 })],
      captureUpdate: "never",
    }),
  );
  const beforeEcho = Y.encodeStateVector(doc);
  act(() => {
    (
      excalidraw.props?.onChange as (
        elements: readonly unknown[],
        appState: Record<string, unknown>,
        files: Record<string, unknown>,
      ) => void
    )([rectangle(1, 10, 20)], {}, {});
  });
  expect(Y.encodeStateAsUpdate(doc, beforeEcho)).toHaveLength(2);
});

it("keeps presence dormant when no collaboration is available", () => {
  const doc = new Y.Doc();
  declareSceneRoots(doc);
  render(
    <ExcalidrawCanvas
      document={parseExcalidrawDocument(EMPTY_EXCALIDRAW_DOCUMENT)}
      readOnly={false}
      sceneDoc={doc}
    />,
  );

  expect(excalidraw.props?.isCollaborating).toBe(false);
  expect(excalidraw.props?.onPointerUpdate).toBeUndefined();
});

it("blocks a stale canvas callback as soon as the scene becomes read-only", async () => {
  const doc = new Y.Doc();
  declareSceneRoots(doc);
  const presence = trackedPresenceTransport();
  const collaboration = {
    topic: "scene-1",
    clientId: "client-1",
    displayName: "Alice",
    transport: presence.transport,
  };
  const document = parseExcalidrawDocument(EMPTY_EXCALIDRAW_DOCUMENT);
  const view = render(
    <ExcalidrawCanvas
      document={document}
      readOnly={false}
      sceneDoc={doc}
      presence={collaboration}
    />,
  );
  await waitFor(() => expect(presence.activePolls()).toBe(1));
  const staleOnChange = excalidraw.props?.onChange as (
    elements: readonly unknown[],
    appState: Record<string, unknown>,
    files: Record<string, unknown>,
  ) => void;
  const before = Y.encodeStateVector(doc);

  view.rerender(
    <ExcalidrawCanvas
      document={document}
      readOnly
      sceneDoc={doc}
      presence={collaboration}
    />,
  );

  expect(excalidraw.props?.viewModeEnabled).toBe(true);
  expect(excalidraw.props?.onChange).toBeUndefined();
  act(() => staleOnChange([rectangle(1, 10, 20)], {}, {}));
  expect(Y.encodeStateAsUpdate(doc, before)).toHaveLength(2);
  await waitFor(() => {
    expect(excalidraw.props?.isCollaborating).toBe(false);
    expect(presence.activePolls()).toBe(0);
  });
  expect(presence.leaveCalls()).toBe(1);
});

it("reports collaboration only after presence binds", async () => {
  const doc = new Y.Doc();
  declareSceneRoots(doc);
  render(
    <ExcalidrawCanvas
      document={parseExcalidrawDocument(EMPTY_EXCALIDRAW_DOCUMENT)}
      readOnly={false}
      sceneDoc={doc}
      presence={{
        topic: "scene-1",
        clientId: "client-1",
        displayName: "Alice",
        transport: {
          async publish() {
            return { version: 1, peers: [] };
          },
          async leave() {},
          poll: ({ signal }) =>
            new Promise((resolve) => {
              signal.addEventListener(
                "abort",
                () => resolve({ version: 1, peers: [] }),
                { once: true },
              );
            }),
        },
      }}
    />,
  );

  await waitFor(() => expect(excalidraw.props?.isCollaborating).toBe(true));
  expect(excalidraw.props?.onPointerUpdate).toBeTypeOf("function");
});

it("records native undo output as a new higher revision", () => {
  const doc = new Y.Doc();
  declareSceneRoots(doc);
  render(
    <ExcalidrawCanvas
      document={parseExcalidrawDocument(EMPTY_EXCALIDRAW_DOCUMENT)}
      readOnly={false}
      sceneDoc={doc}
    />,
  );
  const onChange = excalidraw.props?.onChange as (
    elements: readonly unknown[],
    appState: Record<string, unknown>,
    files: Record<string, unknown>,
  ) => void;

  act(() => onChange([rectangle(2, 20, 40)], {}, {}));
  act(() => onChange([rectangle(3, 30, 0)], {}, {}));
  expect(foldScene(doc).elements[0]).toMatchObject({ version: 3, x: 0 });
  expect(declareSceneRoots(doc).revisions.size).toBe(1);
});

it("removes a refused image while keeping an ordinary scene change", async () => {
  const doc = new Y.Doc();
  declareSceneRoots(doc);
  const onAssetRefusedChange = vi.fn();
  render(
    <ExcalidrawCanvas
      document={parseExcalidrawDocument(EMPTY_EXCALIDRAW_DOCUMENT)}
      readOnly={false}
      sceneDoc={doc}
      onAssetRefusedChange={onAssetRefusedChange}
    />,
  );
  await waitFor(() => expect(excalidraw.updateScene).toHaveBeenCalled());
  excalidraw.updateScene.mockClear();
  const onChange = excalidraw.props?.onChange as (
    elements: readonly unknown[],
    appState: Record<string, unknown>,
    files: Record<string, unknown>,
  ) => void;
  const unsupportedImage = {
    id: "image-element",
    type: "image",
    version: 1,
    versionNonce: 20,
    isDeleted: false,
    index: "a1",
    fileId: "image",
  };

  act(() =>
    onChange(
      [rectangle(1, 10, 20), unsupportedImage],
      {},
      { image: { dataURL: "data:image/png;base64,SECRET" } },
    ),
  );

  expect(foldScene(doc).elements).toEqual([rectangle(1, 10, 20)]);
  expect(onAssetRefusedChange).toHaveBeenCalledWith(true);
  expect(excalidraw.updateScene).toHaveBeenLastCalledWith(
    expect.objectContaining({
      elements: [expect.objectContaining({ id: "shape" })],
      captureUpdate: "never",
    }),
  );
  expect(excalidraw.props?.UIOptions).toMatchObject({ tools: { image: false } });

  act(() => onChange([rectangle(2, 30, 40)], {}, {}));
  expect(onAssetRefusedChange).toHaveBeenLastCalledWith(false);
});

it("hydrates an engine-bound image outside the Y.Doc", async () => {
  const doc = new Y.Doc();
  declareSceneRoots(doc);
  const payload = `data:image/png;base64,${"A".repeat(50 * 1024)}`;
  const hydrateAssets = vi.fn(async () => [
    {
      id: "large-image",
      mimeType: "image/png",
      dataURL: payload,
      created: 1,
    },
  ] as never);

  render(
    <ExcalidrawCanvas
      document={parseExcalidrawDocument(EMPTY_EXCALIDRAW_DOCUMENT)}
      readOnly={false}
      sceneDoc={doc}
      hydrateAssets={hydrateAssets}
    />,
  );

  await vi.waitFor(() => expect(excalidraw.addFiles).toHaveBeenCalledOnce());
  expect(excalidraw.addFiles).toHaveBeenCalledWith([
    expect.objectContaining({ id: "large-image", dataURL: payload }),
  ]);
  expect(Y.encodeStateAsUpdate(doc).byteLength).toBeLessThan(1024);
  expect(new TextDecoder().decode(Y.encodeStateAsUpdate(doc))).not.toContain(
    payload.slice(-1024),
  );
});

it("hydrates a tombstoned image before a remote undo revives it", async () => {
  const doc = new Y.Doc();
  declareSceneRoots(doc);
  insertElementRevision(doc, {
    id: "image-element",
    type: "image",
    version: 2,
    versionNonce: 2,
    isDeleted: true,
    index: "a0",
    fileId: "image-file",
  });
  const hydrateAssets = vi.fn(async () => [
    {
      id: "image-file",
      mimeType: "image/png",
      dataURL: "data:image/png;base64,AQID",
      created: 1,
    },
  ] as never);

  render(
    <ExcalidrawCanvas
      document={parseExcalidrawDocument(EMPTY_EXCALIDRAW_DOCUMENT)}
      readOnly={false}
      sceneDoc={doc}
      hydrateAssets={hydrateAssets}
    />,
  );

  await vi.waitFor(() => expect(excalidraw.addFiles).toHaveBeenCalledOnce());
  excalidraw.updateScene.mockClear();
  act(() =>
    insertElementRevision(doc, {
      id: "image-element",
      type: "image",
      version: 3,
      versionNonce: 3,
      isDeleted: false,
      index: "a0",
      fileId: "image-file",
    }),
  );

  expect(excalidraw.updateScene).toHaveBeenCalledWith(
    expect.objectContaining({
      elements: [
        expect.objectContaining({
          id: "image-element",
          fileId: "image-file",
          isDeleted: false,
        }),
      ],
    }),
  );
  expect(hydrateAssets).toHaveBeenCalledOnce();
  expect(excalidraw.addFiles).toHaveBeenCalledOnce();
});

it("drops asset hydration that resolves after the scene changes", async () => {
  const firstDoc = new Y.Doc();
  const secondDoc = new Y.Doc();
  declareSceneRoots(firstDoc);
  declareSceneRoots(secondDoc);
  let resolveFirst!: (files: never) => void;
  let resolveSecond!: (files: never) => void;
  const first = new Promise<never>((resolve) => {
    resolveFirst = resolve;
  });
  const second = new Promise<never>((resolve) => {
    resolveSecond = resolve;
  });
  const view = render(
    <ExcalidrawCanvas
      document={parseExcalidrawDocument(EMPTY_EXCALIDRAW_DOCUMENT)}
      readOnly={false}
      sceneDoc={firstDoc}
      hydrateAssets={() => first}
    />,
  );
  view.rerender(
    <ExcalidrawCanvas
      document={parseExcalidrawDocument(EMPTY_EXCALIDRAW_DOCUMENT)}
      readOnly={false}
      sceneDoc={secondDoc}
      hydrateAssets={() => second}
    />,
  );

  await act(async () => {
    resolveSecond([
      { id: "current", dataURL: "data:image/png;base64,Qg==" },
    ] as never);
    await second;
  });
  await act(async () => {
    resolveFirst([
      { id: "stale", dataURL: "data:image/png;base64,QQ==" },
    ] as never);
    await first;
  });

  // MUTATION: omit the response guard's cleanup invalidation. The retired
  // scene's asset reaches the current Excalidraw API as a second addFiles.
  expect(excalidraw.addFiles).toHaveBeenCalledTimes(1);
  expect(excalidraw.addFiles).toHaveBeenCalledWith([
    expect.objectContaining({ id: "current" }),
  ]);
});

it("reports only the current asset hydration failure", async () => {
  const firstDoc = new Y.Doc();
  const secondDoc = new Y.Doc();
  declareSceneRoots(firstDoc);
  declareSceneRoots(secondDoc);
  let rejectFirst!: (error: Error) => void;
  let rejectSecond!: (error: Error) => void;
  const first = new Promise<never>((_resolve, reject) => {
    rejectFirst = reject;
  });
  const second = new Promise<never>((_resolve, reject) => {
    rejectSecond = reject;
  });
  const onAssetRefusedChange = vi.fn();
  const view = render(
    <ExcalidrawCanvas
      document={parseExcalidrawDocument(EMPTY_EXCALIDRAW_DOCUMENT)}
      readOnly={false}
      sceneDoc={firstDoc}
      hydrateAssets={() => first}
      onAssetRefusedChange={onAssetRefusedChange}
    />,
  );
  view.rerender(
    <ExcalidrawCanvas
      document={parseExcalidrawDocument(EMPTY_EXCALIDRAW_DOCUMENT)}
      readOnly={false}
      sceneDoc={secondDoc}
      hydrateAssets={() => second}
      onAssetRefusedChange={onAssetRefusedChange}
    />,
  );

  await act(async () => {
    rejectFirst(new Error("retired hydration failed"));
    await first.catch(() => undefined);
  });
  expect(onAssetRefusedChange).not.toHaveBeenCalled();

  await act(async () => {
    rejectSecond(new Error("current hydration failed"));
    await second.catch(() => undefined);
  });
  expect(onAssetRefusedChange).toHaveBeenCalledOnce();
  expect(onAssetRefusedChange).toHaveBeenCalledWith(true);
});
