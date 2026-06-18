import { describe, expect, it } from "vitest";
import stylesCss from "./styles.css?raw";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cssRule(selector: string): string {
  const match = new RegExp(`^${escapeRegExp(selector)}\\s*\\{`, "m").exec(stylesCss);
  expect(match, `styles.css must contain ${selector}`).not.toBeNull();
  const open = stylesCss.indexOf("{", match!.index);
  const close = stylesCss.indexOf("}", open);
  return stylesCss.slice(open + 1, close);
}

describe("markdown editor layout css", () => {
  it("sizes the Tiptap document to its pane instead of the viewport", () => {
    const editor = cssRule(".dohc-tiptap-editor");
    const document = cssRule(".dohc-notion-editor");

    expect(editor).toContain("height: 100%;");
    expect(document).toContain("box-sizing: border-box;");
    expect(document).toContain("min-height: 100%;");
    expect(document).not.toContain("100vh");
  });

  it("keeps typed markdown list input rules visibly list-like", () => {
    const unordered = cssRule('.dohc-notion-editor ul:not([data-type="taskList"])');
    const ordered = cssRule('.dohc-notion-editor ol:not([data-type="taskList"])');
    const taskList = cssRule('.dohc-notion-editor ul[data-type="taskList"]');

    expect(unordered).toContain("list-style-type: disc;");
    expect(ordered).toContain("list-style-type: decimal;");
    expect(taskList).toContain("list-style: none;");
  });
});

describe("workbench cursor css", () => {
  it("uses a pointer cursor for clickable app chrome", () => {
    const clickableChrome = cssRule(
      '.app-chrome :is(button, [role="button"], [role="tab"], [role="treeitem"]):not(:disabled)',
    );

    expect(clickableChrome).toContain("cursor: pointer;");
  });
});
