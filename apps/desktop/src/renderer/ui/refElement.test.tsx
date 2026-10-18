// @vitest-environment jsdom
import { FILE_KIND_RECORDS } from "@dohc/workspace-contracts/kinds";
import { cleanup, render, screen } from "@testing-library/react";
import { useEffect, useLayoutEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Ref } from "./Ref";
import { REF_HOVER } from "./refChip";
import { refElement } from "./refElement";

afterEach(cleanup);

const tokens = (element: Element | null | undefined) => [...(element?.classList ?? [])].sort();

// The editor draws DOM, not React, so refElement is Ref's span built by hand.
// These pin the two to one look.
describe("refElement", () => {
  // First, so no earlier call has built a glyph: the editor builds chips
  // inside React's effects, where flushSync cannot render.
  it("draws its glyph when built inside a React effect", () => {
    const built: HTMLSpanElement[] = [];
    function Host() {
      useLayoutEffect(() => {
        built.push(refElement({ path: "data/funnel.csv" }));
      }, []);
      useEffect(() => {
        built.push(refElement({ path: "sketch.excalidraw" }));
      }, []);
      return null;
    }
    render(<Host />);
    expect(built).toHaveLength(2);
    for (const chip of built) expect(chip.querySelector("svg")?.childElementCount).toBeGreaterThan(0);
  });

  it("is Ref's span: the same classes, glyph and name", () => {
    render(<Ref path="research/competitors.md" title="Competitor landscape" testId="ref" />);
    const ref = screen.getByTestId("ref");
    const element = refElement({ path: "research/competitors.md", title: "Competitor landscape" });

    expect(tokens(element)).toEqual(tokens(ref));
    expect(element.title).toBe(ref.title);
    expect(tokens(element.lastElementChild)).toEqual(tokens(ref.querySelector("svg + span")));
    expect(element.textContent).toBe("Competitor landscape");
  });

  it("draws each kind's glyph as KindGlyph does", () => {
    for (const kind of Object.values(FILE_KIND_RECORDS)) {
      const { container, unmount } = render(<Ref path="any.bin" kind={kind} />);
      const drawn = container.querySelector("svg");
      const built = refElement({ path: "any.bin", kind }).querySelector("svg");
      expect(built?.innerHTML).toBe(drawn?.innerHTML);
      expect(built?.innerHTML).not.toBe("");
      expect(tokens(built)).toEqual(tokens(drawn));
      for (const name of ["width", "height", "viewBox", "stroke-width", "aria-hidden"]) {
        expect(built?.getAttribute(name)).toBe(drawn?.getAttribute(name));
      }
      unmount();
    }
  });

  it("names a file by its basename without a title, and dashes a missing target", () => {
    const element = refElement({ path: "notes/gone.md", missing: true });
    render(<Ref path="notes/gone.md" missing testId="ref" />);
    expect(element.textContent).toBe("gone.md");
    expect(element.dataset.missing).toBe("true");
    expect(tokens(element)).toEqual(tokens(screen.getByTestId("ref")));
  });

  it("takes the hover of a chip that opens when asked", () => {
    expect(refElement({ path: "a.md" }).className).not.toContain(REF_HOVER);
    expect(refElement({ path: "a.md", opens: true }).className).toContain(REF_HOVER);
  });
});
