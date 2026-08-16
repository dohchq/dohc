// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const excalidraw = vi.hoisted(() => ({
  restore: vi.fn(
    (document: {
      elements: unknown[];
      appState: Record<string, unknown>;
      files: Record<string, unknown>;
    }) => document,
  ),
  serializeAsJSON: vi.fn(
    (
      elements: readonly unknown[],
      appState: Record<string, unknown>,
      files: Record<string, unknown>,
    ) => JSON.stringify({ type: "excalidraw", elements, appState, files }),
  ),
}));

const drawingLink = vi.hoisted(() => ({
  href: "https://example.com/drawing",
  preventDefault: vi.fn(),
}));

vi.mock("@excalidraw/excalidraw", () => ({
  restore: excalidraw.restore,
  serializeAsJSON: excalidraw.serializeAsJSON,
  Excalidraw: (props: {
    viewModeEnabled?: boolean;
    autoFocus?: boolean;
    onLinkOpen?: (
      element: { id: string; link: string },
      event: { preventDefault(): void },
    ) => void;
    onChange?: (
      elements: readonly unknown[],
      appState: Record<string, unknown>,
      files: Record<string, unknown>,
    ) => void;
  }) => (
    <div>
      <button
        type="button"
        data-testid="mock-upstream-excalidraw"
        data-read-only={String(props.viewModeEnabled)}
        data-auto-focus={String(props.autoFocus)}
        onClick={() =>
          props.onChange?.(
            [{ id: "image-1", type: "image", fileId: "file-1" }],
            { viewBackgroundColor: "#ffffff" },
            {
              "file-1": {
                id: "file-1",
                dataURL: "data:image/png;base64,iVBORw0KGgo=",
                mimeType: "image/png",
              },
            },
          )
        }
      >
        Drawing
      </button>
      <button
        type="button"
        data-testid="mock-drawing-link"
        onClick={() =>
          props.onLinkOpen?.(
            { id: "linked", link: drawingLink.href },
            { preventDefault: drawingLink.preventDefault },
          )
        }
      >
        Link
      </button>
    </div>
  ),
}));

import ExcalidrawCanvas from "./ExcalidrawCanvas";

beforeEach(() => {
  drawingLink.href = "https://example.com/drawing";
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("ExcalidrawCanvas", () => {
  const document = {
    type: "excalidraw" as const,
    version: 2,
    elements: [],
    appState: {},
    files: {},
  };

  it("serializes the embedded files returned with a scene change", () => {
    const onChange = vi.fn();
    render(
      <ExcalidrawCanvas document={document} readOnly={false} onChange={onChange} />,
    );

    fireEvent.click(screen.getByTestId("mock-upstream-excalidraw"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(JSON.parse(onChange.mock.calls[0]![0]).files["file-1"]).toMatchObject({
      dataURL: "data:image/png;base64,iVBORw0KGgo=",
      mimeType: "image/png",
    });
  });

  it("does not install a change handler in read-only mode", () => {
    const onChange = vi.fn();
    render(
      <ExcalidrawCanvas document={document} readOnly onChange={onChange} />,
    );

    expect(screen.getByTestId("mock-upstream-excalidraw").dataset.readOnly).toBe(
      "true",
    );
    fireEvent.click(screen.getByTestId("mock-upstream-excalidraw"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not focus an editable canvas when its editor group is inactive", () => {
    render(
      <ExcalidrawCanvas document={document} readOnly={false} autoFocus={false} />,
    );

    expect(screen.getByTestId("mock-upstream-excalidraw").dataset.autoFocus).toBe(
      "false",
    );
  });

  it("opens links through the audited desktop bridge", async () => {
    const openExternalUrl = vi.fn(async () => undefined);
    vi.stubGlobal("dohcDesktop", { openExternalUrl });
    render(<ExcalidrawCanvas document={document} readOnly={false} />);

    fireEvent.click(screen.getByTestId("mock-drawing-link"));
    // The open waits on the confirm gate, so it lands a microtask later.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(openExternalUrl).toHaveBeenCalledWith({
      url: "https://example.com/drawing",
    });
    expect(drawingLink.preventDefault).toHaveBeenCalledOnce();
  });

  it("leaves internal element links to Excalidraw", async () => {
    const openExternalUrl = vi.fn(async () => undefined);
    vi.stubGlobal("dohcDesktop", { openExternalUrl });
    drawingLink.href = "#element=target&group=group";
    render(<ExcalidrawCanvas document={document} readOnly={false} />);

    fireEvent.click(screen.getByTestId("mock-drawing-link"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(drawingLink.preventDefault).not.toHaveBeenCalled();
    expect(openExternalUrl).not.toHaveBeenCalled();
  });
});
