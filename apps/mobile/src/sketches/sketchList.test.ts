import { describe, expect, it } from "vitest";
import type { WorkspaceFile } from "../server/workspaceReads";
import { allSketchRows, sketchTitle, uniqueSketchPath } from "./sketchList";

const file = (path: string): WorkspaceFile => ({
  path,
  objectId: `object:${path}`,
  page: path.endsWith(".md"),
});

describe("sketch list helpers", () => {
  it("strips .excalidraw case-insensitively for the screen title", () => {
    expect(sketchTitle("notes/Trip Map.excalidraw")).toBe("Trip Map");
    expect(sketchTitle("Wireframe.EXCALIDRAW")).toBe("Wireframe");
  });

  it("returns every non-dataset sketch in natural order beyond Home's 20-item preview cap", () => {
    const files = [
      ...Array.from({ length: 25 }, (_, i) => file(`diagrams/Sketch ${i + 1}.excalidraw`)),
      file("people/dataset.json"),
      file("people/hidden.excalidraw"),
      file("notes.md"),
    ];
    const rows = allSketchRows(files);
    expect(rows).toHaveLength(25);
    expect(rows[0]).toEqual({
      kind: "sketch",
      key: "sketch:diagrams/Sketch 1.excalidraw",
      path: "diagrams/Sketch 1.excalidraw",
      objectId: "object:diagrams/Sketch 1.excalidraw",
      name: "Sketch 1.excalidraw",
      folder: "diagrams",
    });
    expect(rows[1]?.name).toBe("Sketch 2.excalidraw");
    expect(rows[9]?.name).toBe("Sketch 10.excalidraw");
    expect(rows.some((r) => r.path === "people/hidden.excalidraw")).toBe(false);
  });

  it("picks the first unused Untitled sketch name case-insensitively", () => {
    expect(uniqueSketchPath([])).toBe("Untitled.excalidraw");
    expect(uniqueSketchPath([file("untitled.excalidraw")])).toBe("Untitled 2.excalidraw");
    expect(uniqueSketchPath([file("Untitled.excalidraw"), file("Untitled 2.excalidraw")])).toBe(
      "Untitled 3.excalidraw",
    );
  });
});
