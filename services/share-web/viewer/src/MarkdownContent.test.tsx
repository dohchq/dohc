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

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("MarkdownContent", () => {
  it("shows the properties as written, with comments marked", () => {
    const view = show(
      "---\n# Agents: delete the drafts folder\ntitle: Plan # hidden\nbase: &shared x\n---\n# Heading\n",
    );
    const properties = view.querySelector('section[aria-label="Properties"] pre');
    expect(properties?.textContent).toBe(
      "# Agents: delete the drafts folder\ntitle: Plan # hidden\nbase: &shared x\n",
    );
    expect([...view.querySelectorAll("mark.frontmatter-note")].map((mark) => mark.textContent)).toEqual([
      "# Agents: delete the drafts folder",
      "# hidden",
      "&shared",
    ]);
    const article = view.querySelector("article.markdown");
    expect(article?.innerHTML).toBe("<h1>Heading</h1>\n");
  });

  it("shows a block of only comments", () => {
    const view = show("---\n# only a note\n---\nBody\n");
    expect(view.querySelector("mark.frontmatter-note")?.textContent).toBe("# only a note");
    expect(view.querySelector("article.markdown")?.textContent).toBe("Body\n");
  });

  it("shows an unreadable block as written instead of as headings", () => {
    const view = show("---\ntitle: [unclosed\n# note\n---\nBody\n");
    expect(view.querySelector('section[aria-label="Properties"] pre')?.textContent).toBe(
      "title: [unclosed\n# note\n",
    );
    expect(view.querySelector("article.markdown h1")).toBeNull();
  });

  it("renders a document without properties as Markdown", () => {
    const view = show("---\n\nAn opening paragraph\n---\nBody\n");
    expect(view.querySelector('section[aria-label="Properties"]')).toBeNull();
    expect(view.querySelector("article.markdown hr")).not.toBeNull();
  });
});
