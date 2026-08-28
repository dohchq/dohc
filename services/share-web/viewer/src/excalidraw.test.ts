import { describe, expect, it } from "vitest";
import { parsePublicExcalidrawScene } from "./excalidraw";

describe("parsePublicExcalidrawScene", () => {
  it("keeps drawing elements while removing links, embeds, and attached files", () => {
    const scene = parsePublicExcalidrawScene(JSON.stringify({
      type: "excalidraw",
      elements: [
        {
          id: "card",
          type: "rectangle",
          link: "https://example.invalid/private-roadmap",
          backgroundColor: "#ffc9c9",
        },
        { id: "embed", type: "embeddable", link: "https://example.invalid/app" },
        { id: "frame", type: "iframe", link: "https://example.invalid/frame" },
      ],
      appState: {
        gridSize: 20,
        openSidebar: "library",
        viewBackgroundColor: "#f8f9fa",
      },
      files: {
        private: { dataURL: "https://example.invalid/image.png" },
      },
    }));

    expect(scene).toEqual({
      elements: [{
        id: "card",
        type: "rectangle",
        link: null,
        backgroundColor: "#ffc9c9",
      }],
      appState: {
        gridSize: null,
        viewBackgroundColor: "#f8f9fa",
      },
    });
  });

  it.each([
    "not json",
    JSON.stringify({ type: "other", elements: [] }),
    JSON.stringify({ type: "excalidraw", elements: {} }),
    JSON.stringify({ type: "excalidraw", elements: [null] }),
  ])("rejects an invalid scene", (scene) => {
    expect(parsePublicExcalidrawScene(scene)).toBeNull();
  });
});
