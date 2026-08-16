// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncrementalMarkdownDocument } from "./IncrementalMarkdownDocument";
import { MARKDOWN_COMPONENTS } from "./markdownComponents";

vi.mock("../bridge", () => ({ bridge: vi.fn() }));

afterEach(() => {
  cleanup();
});

const TABLE = [
  "| Field | Limit |",
  "| --- | ---: |",
  "| name | 214 |",
  "| entry | 1024 |",
].join("\n");

function renderMarkdown(body: string) {
  return render(
    <IncrementalMarkdownDocument body={body} components={MARKDOWN_COMPONENTS} />,
  );
}

describe("MARKDOWN_COMPONENTS tables", () => {
  it("renders a GFM table as a table and leaves no pipe syntax on screen", () => {
    const view = renderMarkdown(TABLE);

    const table = view.container.querySelector("table");
    expect(table).not.toBeNull();
    expect(
      Array.from(table!.querySelectorAll("th")).map((cell) => cell.textContent),
    ).toEqual(["Field", "Limit"]);
    expect(
      Array.from(table!.querySelectorAll("td")).map((cell) => cell.textContent),
    ).toEqual(["name", "214", "entry", "1024"]);
    expect(table!.querySelectorAll("tr")).toHaveLength(3);

    // The whole point of the fix: the reader sees a table, never the source.
    expect(view.container.textContent).not.toContain("|");
    expect(view.container.textContent).not.toContain("---");
  });

  it("keeps the column alignment the author declared", () => {
    const view = renderMarkdown(TABLE);

    const headers = view.container.querySelectorAll("th");
    expect(headers[0]?.style.textAlign).toBe("");
    expect(headers[1]?.style.textAlign).toBe("right");
    const cells = view.container.querySelectorAll("td");
    expect(cells[1]?.style.textAlign).toBe("right");
  });

  it("scrolls a wide table inside its own container so the page never does", () => {
    const view = renderMarkdown(TABLE);

    const table = view.container.querySelector("table");
    const wrapper = table?.parentElement;
    expect(wrapper?.className).toContain("overflow-x-auto");
    // The document body itself must not carry the horizontal scroll.
    expect(view.container.className).not.toContain("overflow-x-auto");
  });

  it("styles table cells with the document's own border and header tokens", () => {
    const view = renderMarkdown(TABLE);

    expect(view.container.querySelector("table")?.className).toContain(
      "border-line",
    );
    expect(view.container.querySelector("th")?.className).toContain("bg-panel");
    expect(view.container.querySelector("td")?.className).toContain(
      "border-line",
    );
  });

  it("renders a table that a split document carries in one chunk", () => {
    // Over the incremental threshold, so the body is split into chunks. A
    // table holds no blank line, so it must survive as one block.
    const filler = `${"padding paragraph ".repeat(60)}\n\n`;
    const view = renderMarkdown(`${TABLE}\n\n${filler.repeat(400)}`);

    expect(view.container.querySelectorAll("table")).toHaveLength(1);
    expect(view.container.querySelectorAll("th")).toHaveLength(2);
    expect(view.container.textContent).not.toContain("| Field |");
  });
});
