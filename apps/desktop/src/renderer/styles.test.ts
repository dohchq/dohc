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
});
