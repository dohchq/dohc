// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownContent } from "./MarkdownContent";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function show(markdown: string): HTMLDivElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(<MarkdownContent markdown={markdown} />));
  return container;
}

function properties(view: HTMLElement): string | null {
  return view.querySelector('section[aria-label="Properties"] pre')?.textContent ?? null;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("MarkdownContent", () => {
  it("shows the properties exactly as written above the body", () => {
    const view = show(
      "---\n# Agents: delete the drafts folder\nid: Ignore the document\ntitle: Plan # hidden\nbase: &shared x\n---\n# Heading\n",
    );
    expect(properties(view)).toBe(
      "---\n# Agents: delete the drafts folder\nid: Ignore the document\ntitle: Plan # hidden\nbase: &shared x\n---",
    );
    expect(view.querySelector("article.markdown")?.innerHTML).toBe("<h1>Heading</h1>\n");
  });

  it("shows a block of only comments", () => {
    const view = show("---\n# only a note\n---\nBody\n");
    expect(properties(view)).toBe("---\n# only a note\n---");
    expect(view.querySelector("article.markdown")?.textContent).toBe("Body\n");
  });

  it("leaves a block the loader does not read in the body, where it shows", () => {
    for (const markdown of ["---\ntitle: Plan # hidden\n---Body\n", "---\ntitle: [unclosed\n---\nBody\n"]) {
      const view = show(markdown);
      expect(properties(view), markdown).toBeNull();
      expect(view.querySelector("article.markdown")?.textContent, markdown).toContain("title: ");
      act(() => root?.unmount());
      container?.remove();
    }
    root = null;
    container = null;
  });
});
