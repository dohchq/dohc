// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExcalidrawCanvasProps } from "./ExcalidrawCanvas";
import type { DohcDesktopBridge } from "../ipc/bridgeContract";

vi.mock("./ExcalidrawCanvas", () => ({
  default: (props: ExcalidrawCanvasProps) => (
    <div
      data-testid="mock-excalidraw-canvas"
      data-read-only={String(props.readOnly)}
      data-source={props.document.source ?? ""}
      data-files={Object.keys(props.document.files).join(",")}
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
  ),
}));

import { classifyForView, FileInspector } from "./FileInspector";
import { EMPTY_EXCALIDRAW_DOCUMENT } from "./excalidrawDocument";

const CONTENT_HASH = "a".repeat(64);
const WRITTEN_HASH = "b".repeat(64);

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

function bridgeFor(text = drawing("first", true)) {
  return {
    readWorkspaceText: vi.fn<DohcDesktopBridge["readWorkspaceText"]>(async () => ({
      text,
      truncated: false,
      contentHash: CONTENT_HASH,
    })),
    writeWorkspaceText: vi.fn<DohcDesktopBridge["writeWorkspaceText"]>(
      async () => ({ status: "written", contentHash: WRITTEN_HASH }),
    ),
    openFileExternally: vi.fn(async () => undefined),
  };
}

describe("FileInspector Excalidraw view", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("classifies .excalidraw files as drawings", () => {
    expect(classifyForView("plans/architecture.EXCALIDRAW")).toBe("drawing");
  });

  it("loads embedded files and saves canvas changes through the file writer", async () => {
    const bridge = bridgeFor();
    vi.stubGlobal("dohcDesktop", bridge);
    const view = render(
      <FileInspector workspaceId="ws-1" path="plans/architecture.excalidraw" />,
    );

    const canvas = await screen.findByTestId("mock-excalidraw-canvas");
    expect(canvas.dataset.files).toBe("file-1");
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
      contentHash: CONTENT_HASH,
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
