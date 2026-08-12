// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { declareSceneRoots, foldScene, insertElementRevision } from "@dohc/excalidraw-scene";
import * as Y from "yjs";

const excalidraw = vi.hoisted(() => {
  const updateScene = vi.fn();
  const addFiles = vi.fn();
  return {
    updateScene,
    addFiles,
    api: { updateScene, addFiles },
    props: null as null | Record<string, unknown>,
  };
});

vi.mock("@excalidraw/excalidraw", () => ({
  CaptureUpdateAction: { NEVER: "never" },
  Excalidraw: (props: Record<string, unknown>) => {
    excalidraw.props = props;
    (props.excalidrawAPI as ((api: unknown) => void) | undefined)?.(
      excalidraw.api,
    );
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
