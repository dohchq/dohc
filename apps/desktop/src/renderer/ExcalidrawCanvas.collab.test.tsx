// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { declareSceneRoots, foldScene, insertElementRevision } from "@dohc/excalidraw-scene";
import * as Y from "yjs";

const excalidraw = vi.hoisted(() => {
  let rendering = false;
  const updateScene = vi.fn(() => {
    if (rendering) {
      throw new Error("The Excalidraw API was used during child render.");
    }
  });
  const addFiles = vi.fn();
  return {
    updateScene,
    addFiles,
    api: { updateScene, addFiles },
    props: null as null | Record<string, unknown>,
    beginRender: () => {
      rendering = true;
    },
    endRender: () => {
      rendering = false;
    },
  };
});

vi.mock("@excalidraw/excalidraw", () => ({
  CaptureUpdateAction: { NEVER: "never" },
  Excalidraw: (props: Record<string, unknown>) => {
    excalidraw.props = props;
    excalidraw.beginRender();
    try {
      (props.excalidrawAPI as ((api: unknown) => void) | undefined)?.(
        excalidraw.api,
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

afterEach(() => {
  cleanup();
  excalidraw.updateScene.mockReset();
  excalidraw.addFiles.mockReset();
  excalidraw.props = null;
});

it("waits until commit before using the Excalidraw API", () => {
  const doc = new Y.Doc();
  declareSceneRoots(doc);

  expect(() =>
    render(
      <ExcalidrawCanvas
        document={parseExcalidrawDocument(EMPTY_EXCALIDRAW_DOCUMENT)}
        readOnly={false}
        sceneDoc={doc}
      />,
    ),
  ).not.toThrow();
  expect(excalidraw.updateScene).toHaveBeenCalled();
});

it("renders remote scene updates without echoing them", () => {
  const doc = new Y.Doc();
  declareSceneRoots(doc);
  render(
    <ExcalidrawCanvas
      document={parseExcalidrawDocument(EMPTY_EXCALIDRAW_DOCUMENT)}
      readOnly={false}
      sceneDoc={doc}
    />,
  );
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

it("removes a refused image while keeping an ordinary scene change", () => {
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

  expect(excalidraw.addFiles).toHaveBeenCalledTimes(1);
  expect(excalidraw.addFiles).toHaveBeenCalledWith([
    expect.objectContaining({ id: "current" }),
  ]);
});
