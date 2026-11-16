// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { noteBlocks, readingPosition, showReadingPosition } from "./readingPosition";

const PANE_TOP = 100;

/** A pane of blocks stacked down the page with these heights. */
function pane(heights: number[]) {
  const element = document.createElement("div");
  element.getBoundingClientRect = () => ({ top: PANE_TOP }) as DOMRect;
  const blocks = heights.map((height, index) => {
    const block = document.createElement("p");
    block.getBoundingClientRect = () => {
      const top =
        PANE_TOP - element.scrollTop + heights.slice(0, index).reduce((sum, h) => sum + h, 0);
      return { top, bottom: top + height } as DOMRect;
    };
    element.append(block);
    return block;
  });
  return { element, blocks };
}

describe("the blocks of a note", () => {
  it("leave out the editor's widgets and the read view's code toolbars", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<h1></h1><div class="ProseMirror-widget"></div><p></p>' +
      '<div class="dohc-code-block-toolbar"></div><pre></pre>';
    expect(noteBlocks(root).map((block) => block.tagName)).toEqual(["H1", "P", "PRE"]);
    expect(noteBlocks(null)).toEqual([]);
  });
});

describe("a reading position", () => {
  it("names the block at the top of the pane and how far into it the top is", () => {
    const { element, blocks } = pane([50, 70, 180]);
    expect(readingPosition(element, blocks)).toEqual({ block: 0, into: 0 });
    element.scrollTop = 85;
    expect(readingPosition(element, blocks)).toEqual({ block: 1, into: 35 });
    // A block that ends exactly at the top is above it.
    element.scrollTop = 120;
    expect(readingPosition(element, blocks)).toEqual({ block: 2, into: 0 });
  });

  it("is nothing when every block is above the top", () => {
    const { element, blocks } = pane([50, 70]);
    element.scrollTop = 500;
    expect(readingPosition(element, blocks)).toBeNull();
    expect(readingPosition(element, [])).toBeNull();
  });

  it("is shown at the same block and offset in a view whose blocks have other heights", () => {
    const read = pane([40, 300, 90, 500, 60]);
    read.element.scrollTop = 40 + 300 + 90 + 123;
    const position = readingPosition(read.element, read.blocks)!;
    expect(position).toEqual({ block: 3, into: 123 });

    const editor = pane([44, 32, 32, 520, 32]);
    expect(showReadingPosition(editor.element, editor.blocks, position)).toBe(true);
    expect(editor.element.scrollTop).toBe(44 + 32 + 32 + 123);
    expect(readingPosition(editor.element, editor.blocks)).toEqual(position);
    // The blocks above take their real heights, and it is shown again.
    const grown = pane([44, 310, 95, 520, 32]);
    grown.element.scrollTop = editor.element.scrollTop;
    showReadingPosition(grown.element, grown.blocks, position);
    expect(readingPosition(grown.element, grown.blocks)).toEqual(position);
  });

  it("waits for a block that is not drawn yet", () => {
    const { element, blocks } = pane([50]);
    expect(showReadingPosition(element, blocks, { block: 4, into: 10 })).toBe(false);
    expect(element.scrollTop).toBe(0);
  });
});
