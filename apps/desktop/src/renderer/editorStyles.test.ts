// @vitest-environment jsdom
import { EditorState, NodeSelection } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { beforeAll, describe, expect, it } from "vitest";
import { doc, paragraph, schema } from "./editor/testDocs";
import css from "./styles.css?raw";

// The whole stylesheet, so each check reads the margin the cascade gives.
beforeAll(() => {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
});

// The editor and the read view both wear .dohc-notion-editor, and draw a
// cell's text as paragraphs inside it.
describe("a table cell's paragraphs", () => {
  // The space each block leaves below it in the cell: the larger of its bottom
  // margin and the next block's top margin, since the two collapse.
  const spaces = (cell: string, tag = "td") => {
    document.body.innerHTML = `<div class="dohc-notion-editor"><table><tbody><tr><${tag}>${cell}</${tag}></tr></tbody></table></div>`;
    const blocks = [...document.querySelector(tag)!.children].map((block) => getComputedStyle(block));
    return blocks.map((block, i) => `${Math.max(parseFloat(block.marginBottom), parseFloat(blocks[i + 1]?.marginTop ?? "0"))}px`);
  };

  it("end at the cell's padding", () => {
    expect(spaces("<p>Ada</p>")).toEqual(["0px"]);
    expect(spaces("<p>Name</p>", "th")).toEqual(["0px"]);
  });

  it("keep the space between two paragraphs in one cell", () => {
    expect(spaces("<p>First</p><p>Second</p>")).toEqual(["12px", "0px"]);
  });

  it("keep the space above a list or a code block that follows them", () => {
    expect(spaces("<p>Packing</p><ul><li><p>Boots</p></li></ul>")[0]).toBe("12px");
    expect(spaces("<p>Run</p><pre><code>pnpm dev</code></pre>")[0]).toBe("12px");
  });

  it("keep a heading's own larger space above it", () => {
    expect(spaces("<p>Day one</p><h3>Lisbon</h3>")[0]).toBe("24px");
  });

  // The editor draws the column-resize handle after the cell's last block.
  it("stay flush while the column-resize handle sits after the paragraph", () => {
    expect(spaces('<p>Ada</p><div class="column-resize-handle"></div>')).toEqual(["0px", "0px"]);
  });

  it("leave body paragraphs alone", () => {
    document.body.innerHTML = '<div class="dohc-notion-editor"><p>Body</p><p>More</p></div>';
    expect(getComputedStyle(document.querySelector("p")!).marginBottom).toBe("12px");
  });
});

// Linux's fontconfig answers Times New Roman with a Times-like face. Windows
// and macOS have Georgia, so the stack stops there for them.
it("sets quotes in Noto Serif on Linux before any Times face", () => {
  const stack = /--font-serif: ([^;]+);/.exec(css)![1]!.split(",").map((family) => family.trim());
  expect(stack.indexOf("'Noto Serif'")).toBe(stack.indexOf("Georgia") + 1);
  expect(stack.indexOf("'Noto Serif'")).toBeLessThan(stack.indexOf("'Times New Roman'"));
});

it("tints a wikilink pill the editor node-selects", () => {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  host.className = "dohc-notion-editor";
  document.body.append(host);
  const view = new EditorView(host, {
    state: EditorState.create({ doc: doc(paragraph("See ", schema.nodes.wikilink!.create({ target: "notes/plan" }), " today")) }),
  });
  try {
    const pill = host.querySelector(".dohc-wikilink-pill")!;
    const rest = getComputedStyle(pill).backgroundImage;
    // "See " fills positions 1 to 5, so the pill starts at 5.
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, 5)));
    expect(host.querySelector(".dohc-wikilink-pill")).toBe(pill);
    expect(pill.classList.contains("ProseMirror-selectednode")).toBe(true);
    expect(getComputedStyle(pill).backgroundImage).not.toBe(rest);
    expect(getComputedStyle(pill).backgroundImage).toContain("--dohc-selection");
  } finally {
    view.destroy();
  }
});
