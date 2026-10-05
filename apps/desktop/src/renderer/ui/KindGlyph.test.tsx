// @vitest-environment jsdom
import { FILE_KIND_RECORDS, fileKindForPath } from "@dohc/workspace-contracts/kinds";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { KindGlyph } from "./KindGlyph";

afterEach(cleanup);

describe("KindGlyph", () => {
  it("draws every kind's registry glyph without naming it", () => {
    for (const kind of Object.values(FILE_KIND_RECORDS)) {
      const { container, unmount } = render(<KindGlyph kind={kind} size={15} />);
      const glyph = container.querySelector("svg");
      // lucide names each icon's class after the icon, and the registry's
      // glyph ids are lucide's names.
      expect(glyph?.classList.contains(`lucide-${kind.glyphId}`)).toBe(true);
      // Beside a name the glyph is decorative, so it never renames its row.
      expect(glyph?.getAttribute("aria-hidden")).toBe("true");
      expect(screen.queryByRole("img")).toBeNull();
      unmount();
    }
  });

  it("names a standalone glyph by its kind", () => {
    for (const kind of Object.values(FILE_KIND_RECORDS)) {
      const { unmount } = render(<KindGlyph kind={kind} size={15} labelled />);
      const glyph = screen.getByRole("img", { name: kind.name });
      expect(glyph.classList.contains(`lucide-${kind.glyphId}`)).toBe(true);
      expect(glyph.textContent).toBe("");
      unmount();
    }
  });

  it("takes its size and color from the caller", () => {
    const { container } = render(<KindGlyph kind={fileKindForPath("budget.csv")} size={13} className="text-subtle" />);
    const glyph = container.querySelector("svg");
    expect(glyph?.getAttribute("width")).toBe("13");
    expect(glyph?.getAttribute("height")).toBe("13");
    expect(glyph?.classList.contains("text-subtle")).toBe(true);
  });
});
