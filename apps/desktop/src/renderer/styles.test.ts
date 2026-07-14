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

function cssRuleForSelectorGroup(selectors: string[]): string {
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  const expected = selectors.map(normalize);
  const withoutComments = stylesCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g);
  for (const match of rules) {
    const actual = (match[1] ?? "").split(",").map(normalize);
    if (expected.every((selector) => actual.includes(selector))) {
      return match[2] ?? "";
    }
  }
  throw new Error(`styles.css must contain selector group: ${selectors.join(", ")}`);
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
    // Task lists exist in two DOM shapes (TipTap data-type attrs and the
    // markdown-parsed li[data-checked] form) — the selectors must exclude
    // BOTH from bullet styling and style BOTH as task lists.
    const unordered = cssRule(
      '.dohc-notion-editor ul:not([data-type="taskList"]):not(:has(> li[data-checked]))',
    );
    const ordered = cssRule('.dohc-notion-editor ol:not([data-type="taskList"])');
    const taskList = cssRule(
      '.dohc-notion-editor ul[data-type="taskList"],\n.dohc-notion-editor ul:has(> li[data-checked])',
    );
    const listParagraph = cssRule(".dohc-notion-editor li > p");

    expect(unordered).toContain("list-style-type: disc;");
    expect(ordered).toContain("list-style-type: decimal;");
    expect(taskList).toContain("list-style: none;");
    expect(listParagraph).toContain("min-height: 1.65em;");
  });

  it("keeps every slash-command block on the document writing axis", () => {
    const topLevelBlock = cssRule(".dohc-notion-editor > *");
    const callout = cssRule(".dohc-callout");
    const mermaid = cssRule(".dohc-mermaid-preview");
    const math = cssRule(".dohc-math-block");
    const renderedMath = cssRuleForSelectorGroup([
      ".dohc-math-block .katex-display",
      ".dohc-math-block .katex-display > .katex",
    ]);
    const image = cssRule(".dohc-notion-editor > .dohc-editor-image");

    expect(topLevelBlock).toContain("max-width: var(--dohc-editor-measure);");
    expect(topLevelBlock).toContain("margin-left: auto;");
    expect(topLevelBlock).toContain("margin-right: auto;");
    expect(callout).toContain("margin: 14px auto;");
    expect(mermaid).toContain("margin: 0 auto 12px;");
    expect(math).toContain("margin: 0.6em auto;");
    expect(math).toContain("text-align: left;");
    expect(renderedMath).toContain("text-align: left;");
    expect(image).toContain("max-width: min(100%, var(--dohc-editor-measure));");
    expect(image).toContain(
      "margin-inline-start: max(0px, calc((100% - var(--dohc-editor-measure)) / 2));",
    );
  });
});

describe("editor tab strip css", () => {
  it("hides the strip's scrollbar so a painted bar never pushes the fixed-height tabs into vertical overflow", () => {
    expect(cssRule(".dohc-tab-strip")).toContain("scrollbar-width: none;");
    expect(cssRule(".dohc-tab-strip::-webkit-scrollbar")).toContain("display: none;");
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
