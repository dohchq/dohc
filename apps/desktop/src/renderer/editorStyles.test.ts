// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import css from "./styles.css?raw";

// The rule whose selector list is `selector`, as `{ selector, body }`.
function rule(selector: string) {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, selector).toBeGreaterThan(-1);
  const open = css.indexOf("{", start);
  return css.slice(open + 1, css.indexOf("}", open));
}

// The editor and the read view both wear .dohc-notion-editor.
describe("a table cell's paragraphs", () => {
  const selector = ".dohc-notion-editor :is(th, td) > p:last-of-type";
  const flush = (html: string) => {
    document.body.innerHTML = `<div class="dohc-notion-editor">${html}</div>`;
    return [...document.querySelectorAll("p")].map((p) => p.matches(selector));
  };

  it("end at the cell's padding", () => {
    expect(rule(selector)).toContain("margin-bottom: 0;");
    expect(flush("<table><tr><th><p>Name</p></th><td><p>Ada</p></td></tr></table>")).toEqual([true, true]);
  });

  it("keep the space between two paragraphs in one cell", () => {
    expect(flush("<table><tr><td><p>First</p><p>Second</p></td></tr></table>")).toEqual([false, true]);
  });

  it("stay flush while the column-resize handle sits after the paragraph", () => {
    expect(flush('<table><tr><td><p>Ada</p><div class="column-resize-handle"></div></td></tr></table>')).toEqual([true]);
  });

  it("leave body paragraphs alone", () => {
    expect(flush("<p>Body</p><p>More</p>")).toEqual([false, false]);
  });
});

// Linux's fontconfig answers Times New Roman with a Times-like face. Windows
// and macOS have Georgia, so the stack stops there for them.
it("sets quotes in Noto Serif on Linux before any Times face", () => {
  const stack = /--font-serif: ([^;]+);/.exec(css)![1]!.split(",").map((family) => family.trim());
  expect(stack.indexOf("'Noto Serif'")).toBe(stack.indexOf("Georgia") + 1);
  expect(stack.indexOf("'Noto Serif'")).toBeLessThan(stack.indexOf("'Times New Roman'"));
});

// ProseMirror marks a node-selected atom with .ProseMirror-selectednode.
it("tints a node-selected wikilink pill as a selected Ref chip is tinted", () => {
  expect(rule(".dohc-wikilink-pill.ProseMirror-selectednode")).toContain(
    "background-image: linear-gradient(var(--dohc-selection), var(--dohc-selection));",
  );
});
