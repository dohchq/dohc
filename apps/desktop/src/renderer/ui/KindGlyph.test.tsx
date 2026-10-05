// @vitest-environment jsdom
import { FILE_KIND_RECORDS, fileKindForPath } from "@dohc/workspace-contracts/kinds";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { KindGlyph } from "./KindGlyph";

afterEach(cleanup);

describe("KindGlyph", () => {
  it("draws every kind's registry glyph, labelled by the kind's name", () => {
    for (const kind of Object.values(FILE_KIND_RECORDS)) {
      const { unmount } = render(<KindGlyph kind={kind} size={15} />);
      const glyph = screen.getByRole("img", { name: kind.name });
      // lucide names each icon's class after the icon, and the registry's
      // glyph ids are lucide's names.
      expect(glyph.classList.contains(`lucide-${kind.glyphId}`)).toBe(true);
      // The glyph says the kind; it adds no words.
      expect(glyph.textContent).toBe("");
      unmount();
    }
  });

  it("takes its size and color from the caller", () => {
    render(<KindGlyph kind={fileKindForPath("budget.csv")} size={13} className="text-subtle" />);
    const glyph = screen.getByRole("img", { name: "CSV table" });
    expect(glyph.getAttribute("width")).toBe("13");
    expect(glyph.getAttribute("height")).toBe("13");
    expect(glyph.classList.contains("text-subtle")).toBe(true);
  });
});
