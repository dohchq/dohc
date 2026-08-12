// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  declareSceneRoots,
  foldScene,
  insertElementRevision,
  putSceneAsset,
} from "@dohc/excalidraw-scene";
import * as Y from "yjs";
import type { ExcalidrawCanvasProps } from "./ExcalidrawCanvas";
import type { DohcDesktopBridge } from "../ipc/bridgeContract";
import type { EngineYDocSaveStateEvent } from "../ipc/channels";

const canvas = vi.hoisted(() => ({
  props: null as null | Record<string, unknown>,
}));

vi.mock("./ExcalidrawCanvas", () => ({
  default: (props: ExcalidrawCanvasProps) => {
    canvas.props = props as unknown as Record<string, unknown>;
    return (
      <div
        data-testid="mock-excalidraw-canvas"
        data-read-only={String(props.readOnly)}
        data-source={props.document.source ?? ""}
        data-files={Object.keys(props.document.files).join(",")}
        data-scene-doc={String(props.sceneDoc !== undefined)}
        data-presence-topic={props.presence?.topic ?? ""}
        data-scene-elements={
          props.sceneDoc ? String(foldScene(props.sceneDoc).elements.length) : ""
        }
      >
        <button
          type="button"
          data-testid="mock-drawing-change"
          onClick={() =>
            props.onChange?.(
              JSON.stringify({
                type: "excalidraw",
                version: 2,
                source: "dohc-test",
                elements: [{ id: "changed", type: "rectangle" }],
                appState: {},
                files: {},
              }),
            )
          }
        >
          Change drawing
        </button>
      </div>
    );
  },
}));

import { classifyForView, FileInspector } from "./FileInspector";
import { EMPTY_EXCALIDRAW_DOCUMENT } from "./excalidrawDocument";

const CONTENT_HASH = "a".repeat(64);
const WRITTEN_HASH = "b".repeat(64);

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function largeValidPng(): Uint8Array {
  const base = Uint8Array.from(atob(PNG_BASE64), (char) => char.charCodeAt(0));
  const type = new TextEncoder().encode("tEXt");
  const data = new Uint8Array(50 * 1024);
  data.set(new TextEncoder().encode("Note\0"));
  data.fill(65, 5);
  const checksumInput = new Uint8Array(type.length + data.length);
  checksumInput.set(type);
  checksumInput.set(data, type.length);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(type, 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(checksumInput));
  const iendOffset = base.length - 12;
  const png = new Uint8Array(base.length + chunk.length);
  png.set(base.subarray(0, iendOffset));
  png.set(chunk, iendOffset);
  png.set(base.subarray(iendOffset), iendOffset + chunk.length);
  return png;
}

const ARTIFACT_DESCRIPTOR = {
  id: "file-1",
  mimeType: "image/png",
  created: 1,
  ref: "assets/excalidraw/image.png",
  sha256: "a".repeat(64),
  lastRetrieved: 2,
  version: 3,
};

function drawing(source: string, withFile = false): string {
  return JSON.stringify({
    type: "excalidraw",
    version: 2,
    source,
    elements: withFile
      ? [{ id: "image-1", type: "image", fileId: "file-1" }]
      : [],
    appState: {},
    files: withFile
      ? {
          "file-1": {
            id: "file-1",
            dataURL: "data:image/png;base64,iVBORw0KGgo=",
            mimeType: "image/png",
            created: 1,
            lastRetrieved: 1,
          },
        }
      : {},
  });
}

function bridgeFor(
  text = drawing("first", true),
  engineScene?: Y.Doc,
) {
  const saveStateListeners = new Set<
    (event: EngineYDocSaveStateEvent) => void
  >();
  let sessionId: string | null = null;
  return {
    readWorkspaceText: vi.fn<DohcDesktopBridge["readWorkspaceText"]>(async () => ({
      text,
      truncated: false,
      contentHash: CONTENT_HASH,
    })),
    writeWorkspaceText: vi.fn<DohcDesktopBridge["writeWorkspaceText"]>(
      async () => ({ status: "written", contentHash: WRITTEN_HASH }),
    ),
    openEngineYDocSession: vi.fn<DohcDesktopBridge["openEngineYDocSession"]>(async (payload) => {
      sessionId = payload.sessionId;
      return engineScene
        ? { available: true, initialUpdate: Y.encodeStateAsUpdate(engineScene) }
        : { available: false };
    }),
    closeEngineYDocSession: vi.fn(async () => undefined),
    applyEngineYDocUpdate: vi.fn(async () => undefined),
    readEngineYDocArtifactAsset: vi.fn<
      DohcDesktopBridge["readEngineYDocArtifactAsset"]
    >(async () => {
      throw new Error("The scene has no artifact assets.");
    }),
    onEngineYDocRemoteUpdate: vi.fn(() => () => undefined),
    onEngineYDocSaveState: vi.fn(
      (listener: (event: EngineYDocSaveStateEvent) => void) => {
        saveStateListeners.add(listener);
        return () => saveStateListeners.delete(listener);
      },
    ),
    emitSaveState(state: EngineYDocSaveStateEvent["state"], seq: number) {
      if (!sessionId) throw new Error("The scene session is not open.");
      for (const listener of saveStateListeners) {
        listener({ sessionId, state, seq });
      }
    },
    openFileExternally: vi.fn(async () => undefined),
  };
}

describe("FileInspector Excalidraw view", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canvas.props = null;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("classifies .excalidraw files as drawings", () => {
    expect(classifyForView("plans/architecture.EXCALIDRAW")).toBe("drawing");
  });

  it("does not let an inactive editor-group drawing claim focus", async () => {
    const bridge = bridgeFor();
    vi.stubGlobal("dohcDesktop", bridge);
    render(
      <FileInspector
        workspaceId="ws-1"
        path="plans/architecture.excalidraw"
        autoFocus={false}
      />,
    );

    await screen.findByTestId("mock-excalidraw-canvas");
    expect((canvas.props as unknown as ExcalidrawCanvasProps).autoFocus).toBe(
      false,
    );
  });

  it("loads embedded files and saves canvas changes through the file writer", async () => {
    const bridge = bridgeFor();
    vi.stubGlobal("dohcDesktop", bridge);
    const view = render(
      <FileInspector workspaceId="ws-1" path="plans/architecture.excalidraw" />,
    );

    const canvas = await screen.findByTestId("mock-excalidraw-canvas");
    expect(canvas.dataset.files).toBe("file-1");
    await waitFor(() => expect(canvas.dataset.readOnly).toBe("false"));
    fireEvent.click(screen.getByTestId("mock-drawing-change"));
    view.unmount();

    expect(bridge.writeWorkspaceText).toHaveBeenCalledTimes(1);
    expect(bridge.writeWorkspaceText).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      relativePath: "plans/architecture.excalidraw",
      text: expect.stringContaining('"id":"changed"'),
      expectedContentHash: CONTENT_HASH,
    });
  });

  it("initializes an empty new file as a portable drawing", async () => {
    const bridge = bridgeFor("");
    vi.stubGlobal("dohcDesktop", bridge);
    const view = render(
      <FileInspector workspaceId="ws-1" path="Untitled.excalidraw" />,
    );

    await screen.findByTestId("mock-excalidraw-canvas");
    await waitFor(() =>
      expect(screen.getByTestId("mock-excalidraw-canvas").dataset.readOnly).toBe(
        "false",
      ),
    );
    view.unmount();
    expect(bridge.writeWorkspaceText).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      relativePath: "Untitled.excalidraw",
      text: EMPTY_EXCALIDRAW_DOCUMENT,
      expectedContentHash: CONTENT_HASH,
    });
  });

  it("keeps drawings read-only in shared views", async () => {
    const bridge = bridgeFor();
    vi.stubGlobal("dohcDesktop", bridge);
    const view = render(
      <FileInspector
        workspaceId="share-1"
        path="architecture.excalidraw"
        readOnly
      />,
    );

    const canvas = await screen.findByTestId("mock-excalidraw-canvas");
    expect(canvas.dataset.readOnly).toBe("true");
    fireEvent.click(screen.getByTestId("mock-drawing-change"));
    view.unmount();
    expect(bridge.writeWorkspaceText).not.toHaveBeenCalled();
  });

  it("does not parse or save a truncated drawing with embedded files", async () => {
    const bridge = bridgeFor('{"type":"excalidraw","elements":[');
    bridge.readWorkspaceText = vi.fn(async () => ({
      text: '{"type":"excalidraw","elements":[',
      truncated: true as const,
      contentHash: null,
    }));
    vi.stubGlobal("dohcDesktop", bridge);
    const view = render(
      <FileInspector workspaceId="ws-1" path="large.excalidraw" />,
    );

    expect(await screen.findByTestId("view-drawing-truncated")).toBeTruthy();
    expect(screen.queryByTestId("mock-excalidraw-canvas")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Open the full file externally" }),
    );
    expect(bridge.openFileExternally).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      relativePath: "large.excalidraw",
    });
    view.unmount();
    expect(bridge.writeWorkspaceText).not.toHaveBeenCalled();
  });

  it("opens a truncated drawing from a bound scene without parsing the prefix", async () => {
    const bridge = bridgeFor('{"type":"excalidraw","elements":[');
    bridge.readWorkspaceText = vi.fn(async () => ({
      text: '{"type":"excalidraw","elements":[',
      truncated: true as const,
      contentHash: null,
    }));
    const scene = new Y.Doc();
    declareSceneRoots(scene);
    insertElementRevision(scene, {
      id: "engine-shape",
      type: "rectangle",
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      index: "a0",
    });
    bridge.openEngineYDocSession = vi.fn(async () => ({
      available: true,
      initialUpdate: Y.encodeStateAsUpdate(scene),
    }));
    vi.stubGlobal("dohcDesktop", bridge);
    render(<FileInspector workspaceId="ws-1" path="large.excalidraw" />);

    const canvas = await screen.findByTestId("mock-excalidraw-canvas");
    expect(canvas.dataset.sceneDoc).toBe("true");
    expect(canvas.dataset.sceneElements).toBe("1");
    expect(canvas.dataset.readOnly).toBe("false");
    expect(screen.queryByTestId("view-drawing-truncated")).toBeNull();
    expect(bridge.writeWorkspaceText).not.toHaveBeenCalled();
  });

  it("hydrates a verified large PNG outside the engine Y.Doc", async () => {
    const bytes = largeValidPng();
    expect(bytes.byteLength).toBeGreaterThan(48 * 1024);
    expect([...bytes.subarray(0, 8)]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const scene = new Y.Doc();
    declareSceneRoots(scene);
    insertElementRevision(scene, {
      id: "image-1",
      type: "image",
      fileId: ARTIFACT_DESCRIPTOR.id,
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      index: "a0",
    });
    putSceneAsset(scene, ARTIFACT_DESCRIPTOR);
    const bridge = bridgeFor(drawing("engine"), scene);
    bridge.openEngineYDocSession = vi.fn(async () => ({
      available: true,
      initialUpdate: Y.encodeStateAsUpdate(scene),
      artifactAssets: [ARTIFACT_DESCRIPTOR],
    }));
    bridge.readEngineYDocArtifactAsset = vi.fn(async () => ({
      descriptor: ARTIFACT_DESCRIPTOR,
      bytes,
    }));
    vi.stubGlobal("dohcDesktop", bridge);
    const view = render(
      <FileInspector workspaceId="ws-1" path="large.excalidraw" />,
    );

    await screen.findByTestId("mock-excalidraw-canvas");
    const props = canvas.props as unknown as ExcalidrawCanvasProps;
    const hydrateAssets = props.hydrateAssets;
    expect(hydrateAssets).toBeTypeOf("function");
    view.rerender(
      <FileInspector workspaceId="ws-1" path="large.excalidraw" />,
    );
    expect(
      (canvas.props as unknown as ExcalidrawCanvasProps).hydrateAssets,
    ).toBe(hydrateAssets);
    const doc = props.sceneDoc!;
    const beforeHydration = Y.encodeStateVector(doc);
    const [file] = await hydrateAssets!();

    expect(file).toMatchObject({
      id: ARTIFACT_DESCRIPTOR.id,
      mimeType: "image/png",
      created: ARTIFACT_DESCRIPTOR.created,
      lastRetrieved: ARTIFACT_DESCRIPTOR.lastRetrieved,
      version: ARTIFACT_DESCRIPTOR.version,
    });
    expect(file?.dataURL).toMatch(/^data:image\/png;base64,iVBOR/);
    expect(file?.dataURL.length).toBeGreaterThan(64 * 1024);
    expect(bridge.readEngineYDocArtifactAsset).toHaveBeenCalledWith({
      sessionId: expect.any(String),
      assetId: ARTIFACT_DESCRIPTOR.id,
    });
    expect(Y.encodeStateAsUpdate(doc, beforeHydration)).toHaveLength(2);
    expect(Y.encodeStateAsUpdate(doc).byteLength).toBeLessThan(4 * 1024);
  });

  it.each([
    "image/bmp",
    "image/x-icon",
    "image/avif",
    "image/jfif",
  ] as const)("hydrates upstream's native %s asset type", async (mimeType) => {
    const descriptor = { ...ARTIFACT_DESCRIPTOR, mimeType };
    const scene = new Y.Doc();
    declareSceneRoots(scene);
    putSceneAsset(scene, descriptor);
    const bridge = bridgeFor(drawing("engine"), scene);
    bridge.openEngineYDocSession = vi.fn(async () => ({
      available: true,
      initialUpdate: Y.encodeStateAsUpdate(scene),
      artifactAssets: [descriptor],
    }));
    bridge.readEngineYDocArtifactAsset = vi.fn(async () => ({
      descriptor,
      bytes: new Uint8Array([1, 2, 3]),
    }));
    vi.stubGlobal("dohcDesktop", bridge);
    render(<FileInspector workspaceId="ws-1" path="drawing.excalidraw" />);

    await screen.findByTestId("mock-excalidraw-canvas");
    const props = canvas.props as unknown as ExcalidrawCanvasProps;
    const [file] = await props.hydrateAssets!();

    expect(file?.mimeType).toBe(mimeType);
    expect(file?.dataURL).toBe(`data:${mimeType};base64,AQID`);
  });

  it("keeps the drawing editable when an artifact asset cannot load", async () => {
    const scene = new Y.Doc();
    declareSceneRoots(scene);
    putSceneAsset(scene, ARTIFACT_DESCRIPTOR);
    const bridge = bridgeFor(drawing("engine"), scene);
    bridge.openEngineYDocSession = vi.fn(async () => ({
      available: true,
      initialUpdate: Y.encodeStateAsUpdate(scene),
      artifactAssets: [ARTIFACT_DESCRIPTOR],
    }));
    bridge.readEngineYDocArtifactAsset = vi.fn(async () => {
      throw new Error("missing asset");
    });
    vi.stubGlobal("dohcDesktop", bridge);
    render(<FileInspector workspaceId="ws-1" path="drawing.excalidraw" />);

    const view = await screen.findByTestId("mock-excalidraw-canvas");
    const props = canvas.props as unknown as ExcalidrawCanvasProps;
    await expect(props.hydrateAssets!()).resolves.toEqual([]);
    expect(view.dataset.readOnly).toBe("false");
  });

  it("drops an asset read that resolves after the drawing session changes", async () => {
    const firstScene = new Y.Doc();
    const secondScene = new Y.Doc();
    declareSceneRoots(firstScene);
    declareSceneRoots(secondScene);
    putSceneAsset(firstScene, ARTIFACT_DESCRIPTOR);
    let resolveAsset!: (value: {
      descriptor: typeof ARTIFACT_DESCRIPTOR;
      bytes: Uint8Array;
    }) => void;
    const pendingAsset = new Promise<{
      descriptor: typeof ARTIFACT_DESCRIPTOR;
      bytes: Uint8Array;
    }>((resolve) => {
      resolveAsset = resolve;
    });
    const bridge = bridgeFor();
    bridge.openEngineYDocSession = vi.fn(async (payload) => ({
      available: true,
      initialUpdate: Y.encodeStateAsUpdate(
        payload.path === "first.excalidraw" ? firstScene : secondScene,
      ),
      artifactAssets:
        payload.path === "first.excalidraw" ? [ARTIFACT_DESCRIPTOR] : [],
    }));
    bridge.readEngineYDocArtifactAsset = vi.fn(() => pendingAsset);
    vi.stubGlobal("dohcDesktop", bridge);
    const view = render(
      <FileInspector workspaceId="ws-1" path="first.excalidraw" />,
    );
    await screen.findByTestId("mock-excalidraw-canvas");
    const firstProps = canvas.props as unknown as ExcalidrawCanvasProps;
    const pendingHydration = firstProps.hydrateAssets!();

    view.rerender(
      <FileInspector workspaceId="ws-2" path="second.excalidraw" />,
    );
    await waitFor(() => {
      const current = canvas.props as unknown as ExcalidrawCanvasProps;
      expect(current.sceneDoc).not.toBe(firstProps.sceneDoc);
    });
    resolveAsset({ descriptor: ARTIFACT_DESCRIPTOR, bytes: largeValidPng() });

    await expect(pendingHydration).resolves.toEqual([]);
    expect(
      (canvas.props as unknown as ExcalidrawCanvasProps).hydrateAssets,
    ).toBeUndefined();
  });

  it("binds owner-workspace presence to the exact engine document", async () => {
    const bridge = bridgeFor();
    const scene = new Y.Doc();
    declareSceneRoots(scene);
    bridge.openEngineYDocSession = vi.fn(async () => ({
      available: true,
      initialUpdate: Y.encodeStateAsUpdate(scene),
      objectId: "object-1",
      versionId: "main",
    }));
    const transport = {
      publish: vi.fn(),
      leave: vi.fn(),
      poll: vi.fn(),
    };
    const transportForScope = vi.fn(() => transport as never);
    vi.stubGlobal("dohcDesktop", bridge);
    render(
      <FileInspector
        workspaceId="ws-1"
        path="architecture.excalidraw"
        drawingCollaboration={{
          transportForScope,
          clientId: "client-1",
          displayName: "Alice",
        }}
      />,
    );

    const canvas = await screen.findByTestId("mock-excalidraw-canvas");
    expect(canvas.dataset.presenceTopic).toBe(
      'scene:["ws-1","main","object-1"]',
    );
    expect(transportForScope).toHaveBeenCalledWith({
      kind: "workspace",
      workspaceId: "ws-1",
    });
  });

  it("does not construct a presence transport in solo mode", async () => {
    const bridge = bridgeFor();
    const scene = new Y.Doc();
    declareSceneRoots(scene);
    bridge.openEngineYDocSession = vi.fn(async () => ({
      available: true,
      initialUpdate: Y.encodeStateAsUpdate(scene),
      objectId: "object-1",
      versionId: "main",
    }));
    vi.stubGlobal("dohcDesktop", bridge);
    render(<FileInspector workspaceId="ws-1" path="architecture.excalidraw" />);

    const canvas = await screen.findByTestId("mock-excalidraw-canvas");
    expect(canvas.dataset.presenceTopic).toBe("");
  });

  it("keeps the drawing available when presence transport setup fails", async () => {
    const bridge = bridgeFor();
    const scene = new Y.Doc();
    declareSceneRoots(scene);
    bridge.openEngineYDocSession = vi.fn(async () => ({
      available: true,
      initialUpdate: Y.encodeStateAsUpdate(scene),
      objectId: "object-1",
      versionId: "main",
    }));
    vi.stubGlobal("dohcDesktop", bridge);
    render(
      <FileInspector
        workspaceId="ws-1"
        path="architecture.excalidraw"
        drawingCollaboration={{
          transportForScope: () => {
            throw new Error("presence unavailable");
          },
          clientId: "client-1",
          displayName: "Alice",
        }}
      />,
    );

    const canvas = await screen.findByTestId("mock-excalidraw-canvas");
    expect(canvas.dataset.sceneDoc).toBe("true");
    expect(canvas.dataset.presenceTopic).toBe("");
  });

  it("shows the engine's exact save state for a drawing", async () => {
    const scene = new Y.Doc();
    declareSceneRoots(scene);
    const bridge = bridgeFor(drawing("engine"), scene);
    vi.stubGlobal("dohcDesktop", bridge);
    render(<FileInspector workspaceId="ws-1" path="drawing.excalidraw" />);

    const chip = await screen.findByTestId("drawing-save-state");
    await waitFor(() => expect(chip.textContent).toBe("Saved"));
    act(() => bridge.emitSaveState("file-locked", 1));

    expect(chip.dataset.state).toBe("file-locked");
    expect(chip.textContent).toBe("File in use");
    expect(chip.title).toContain("retries until the file is free");
  });

  it("keeps a truncated drawing non-writable while its scene opens", async () => {
    const bridge = bridgeFor('{"type":"excalidraw","elements":[');
    bridge.readWorkspaceText = vi.fn(async () => ({
      text: '{"type":"excalidraw","elements":[',
      truncated: true as const,
      contentHash: null,
    }));
    bridge.openEngineYDocSession = vi.fn(
      () => new Promise(() => undefined),
    );
    vi.stubGlobal("dohcDesktop", bridge);
    const view = render(
      <FileInspector workspaceId="ws-1" path="large.excalidraw" />,
    );

    expect(await screen.findByTestId("view-drawing-opening")).toBeTruthy();
    expect(screen.queryByTestId("mock-excalidraw-canvas")).toBeNull();
    expect(screen.queryByTestId("view-drawing-truncated")).toBeNull();
    expect(bridge.writeWorkspaceText).not.toHaveBeenCalled();
    view.unmount();
  });

  it("explains an engine-held drawing and retries without a writable fallback", async () => {
    const scene = new Y.Doc();
    declareSceneRoots(scene);
    const bridge = bridgeFor(drawing("disk"));
    bridge.openEngineYDocSession = vi
      .fn()
      .mockResolvedValueOnce({
        available: false,
        engineMayHoldDocument: true,
      })
      .mockResolvedValueOnce({
        available: true,
        initialUpdate: Y.encodeStateAsUpdate(scene),
      });
    vi.stubGlobal("dohcDesktop", bridge);
    render(<FileInspector workspaceId="ws-1" path="drawing.excalidraw" />);

    const notice = await screen.findByTestId(
      "engine-may-hold-document-notice",
    );
    expect(notice.textContent).toContain(
      "dohc could not open this document for editing.",
    );
    expect(notice.textContent).toContain("It is read-only for now.");
    expect(screen.getByTestId("mock-excalidraw-canvas").dataset.readOnly).toBe(
      "true",
    );
    expect(bridge.writeWorkspaceText).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => {
      expect(bridge.openEngineYDocSession).toHaveBeenCalledTimes(2);
      expect(screen.queryByTestId("engine-may-hold-document-notice")).toBeNull();
      expect(screen.getByTestId("mock-excalidraw-canvas").dataset.sceneDoc).toBe(
        "true",
      );
    });
    expect(bridge.writeWorkspaceText).not.toHaveBeenCalled();
  });

  it("shows an actionable error for invalid drawing JSON", async () => {
    const bridge = bridgeFor("not json");
    vi.stubGlobal("dohcDesktop", bridge);
    render(<FileInspector workspaceId="ws-1" path="broken.excalidraw" />);

    expect(
      (await screen.findByTestId("view-drawing-error")).textContent,
    ).toContain("The drawing is not valid JSON.");
    fireEvent.click(screen.getByRole("button", { name: "Open externally" }));
    expect(bridge.openFileExternally).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      relativePath: "broken.excalidraw",
    });
  });

  it.each([
    [
      "a null element",
      '{"type":"excalidraw","elements":[null],"appState":{},"files":{}}',
      "The drawing has an invalid element.",
    ],
    [
      "a null active tool",
      '{"type":"excalidraw","elements":[],"appState":{"activeTool":null},"files":{}}',
      "The drawing has an invalid active tool.",
    ],
  ])("contains %s before mounting Excalidraw", async (_label, text, message) => {
    const bridge = bridgeFor(text);
    vi.stubGlobal("dohcDesktop", bridge);
    render(<FileInspector workspaceId="ws-1" path="broken.excalidraw" />);

    expect(
      (await screen.findByTestId("view-drawing-error")).textContent,
    ).toContain(message);
    expect(screen.queryByTestId("mock-excalidraw-canvas")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open externally" }));
    expect(bridge.openFileExternally).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      relativePath: "broken.excalidraw",
    });
  });

  it("does not let a late read repaint a different drawing", async () => {
    let resolveFirst!: (value: {
      text: string;
      truncated: false;
      contentHash: string;
    }) => void;
    let resolveSecond!: typeof resolveFirst;
    const first = new Promise<Parameters<typeof resolveFirst>[0]>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<Parameters<typeof resolveFirst>[0]>((resolve) => {
      resolveSecond = resolve;
    });
    const bridge = bridgeFor();
    bridge.readWorkspaceText = vi.fn((payload) =>
      payload.relativePath === "first.excalidraw" ? first : second,
    );
    vi.stubGlobal("dohcDesktop", bridge);
    const view = render(
      <FileInspector workspaceId="ws-1" path="first.excalidraw" />,
    );
    view.rerender(
      <FileInspector workspaceId="ws-2" path="second.excalidraw" />,
    );

    await act(async () => {
      resolveSecond({
        text: drawing("second"),
        truncated: false,
        contentHash: CONTENT_HASH,
      });
    });
    expect((await screen.findByTestId("mock-excalidraw-canvas")).dataset.source).toBe(
      "second",
    );

    await act(async () => {
      resolveFirst({
        text: drawing("first"),
        truncated: false,
        contentHash: CONTENT_HASH,
      });
    });
    expect(screen.getByTestId("mock-excalidraw-canvas").dataset.source).toBe(
      "second",
    );
  });
});
