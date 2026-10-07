// @vitest-environment jsdom
import { fileKindForPath } from "@dohc/workspace-contracts/kinds";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { KindGlyph } from "./ui/KindGlyph";
import { ViewHeader } from "./fileInspectorUi";

afterEach(cleanup);

// The glyph's lucide class, such as "lucide-pen-tool".
function glyphClass(element: Element | null | undefined): string | undefined {
  return [...(element?.classList ?? [])].find((name) => name.startsWith("lucide-") && name !== "lucide");
}

describe("ViewHeader", () => {
  // One kind, one glyph: the header draws the glyph Explorer draws for the
  // same path, from the kind record, and says no kind in words.
  it.each(["trip/plan.md", "trip/route.excalidraw", "trip/budget.csv", "trip/notes.json", "app/main.ts", "photo.png", "store.sqlite", "blob.bin"])(
    "draws the kind record's glyph for %s",
    (path) => {
      const { container } = render(<ViewHeader path={path} />);
      const header = container.querySelector("header");
      const glyph = header?.querySelector("svg");
      const expected = render(<KindGlyph kind={fileKindForPath(path)} size={13} />).container.querySelector("svg");
      expect(glyphClass(glyph)).toBe(glyphClass(expected));
      expect(glyph?.getAttribute("aria-hidden")).toBe("true");
      expect(header?.textContent).toBe(path);
    },
  );
});
