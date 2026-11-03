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

  it("draws a table in the editor's frame, header and rows in one body", () => {
    const view = renderMarkdown(TABLE);

    // The editor's .tableWrapper scrolls a wide table inside itself, so the
    // page never scrolls sideways.
    const table = view.container.querySelector("table");
    expect(table?.parentElement?.className).toBe("tableWrapper");
    // The editor keeps every row in one tbody, and only the first row drops
    // its top hairline. A thead would drop the first body row's too.
    expect(table?.querySelector("thead")).toBeNull();
    expect(table?.querySelectorAll(":scope > tbody")).toHaveLength(1);
    expect(table?.querySelectorAll(":scope > tbody > tr")).toHaveLength(3);
    // The editor's cells hold a paragraph, and its spacing sets their height.
    expect(table?.querySelectorAll(":is(th, td) > p")).toHaveLength(6);
  });

  it("sizes columns as the editor does, so a wide table scrolls", () => {
    const header = `| ${Array.from({ length: 10 }, (_, i) => `C${i}`).join(" | ")} |`;
    const view = renderMarkdown(`${header}\n|${" --- |".repeat(10)}\n|${" x |".repeat(10)}`);

    // Tiptap's TableView: each column at least 120px, the table at least
    // their sum, so ten columns outgrow the 752px frame and scroll.
    const table = view.container.querySelector("table");
    expect(table?.style.minWidth, "The table keeps only `width: 100%`, so a wide table squeezes its columns, then widens when the editor replaces it.").toBe("1200px");
    const cols = table?.querySelectorAll(":scope > colgroup > col") ?? [];
    expect(cols).toHaveLength(10);
    expect((cols[0] as HTMLTableColElement).style.minWidth).toBe("120px");
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

// The editor keeps a resized row's height in a comment above the table and
// sets it on the row: `<tr style="height: 84px">`.
const annotated = (pairs: string) => `<!-- dohc:table row-heights=${pairs} -->\n${TABLE}`;

function rowHeights(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("tr"), (row) => row.style.height);
}

describe("read table row heights", () => {
  it("sets each stored row height on its row and hides the comment", () => {
    const view = renderMarkdown(`${annotated("1:84,2:120")}\n\nBelow the table.`);

    expect(rowHeights(view.container), "The read body draws every row at its natural height, so rows grow when the editor replaces it.").toEqual(["", "84px", "120px"]);
    expect(view.container.textContent).not.toContain("dohc:table");
    expect(view.container.textContent).toContain("Below the table.");
  });

  it("reads the comment where the editor does", () => {
    const quoted = `> <!-- dohc:table row-heights=1:84 -->\n${TABLE.replaceAll(/^/gmu, "> ")}`;
    const listed = `- <!-- dohc:table row-heights=1:84 -->\n${TABLE.replaceAll(/^/gmu, "  ")}`;
    const spaced = `<!-- dohc:table row-heights=1:84 -->\n\n${TABLE}`;
    for (const body of [spaced, quoted, listed]) {
      const view = renderMarkdown(body);
      expect(rowHeights(view.container), body).toEqual(["", "84px", ""]);
      expect(view.container.textContent, body).not.toContain("dohc:table");
      view.unmount();
    }
  });

  it("skips a row the table does not have and a height that is not positive", () => {
    for (const [pairs, heights] of [
      ["9:84,1:0,2:5", ["", "", "5px"]],
      ["1:99999999999999999999,2:120", ["", "", "120px"]],
    ] as const) {
      const view = renderMarkdown(annotated(pairs));
      expect(rowHeights(view.container), pairs).toEqual(heights);
      expect(view.container.textContent, pairs).not.toContain("dohc:table");
      view.unmount();
    }
  });

  it("leaves a malformed comment, or one with no table under it, as text", () => {
    for (const body of [
      annotated("1:84px"),
      annotated("1:8.5"),
      annotated("1:84,"),
      `  ${annotated("1:84")}`,
      "<!-- dohc:table row-heights=1:84 -->\nNot a table.",
      `<!-- note -->\n${TABLE}`,
    ]) {
      const view = renderMarkdown(body);
      expect(rowHeights(view.container).join(""), body).toBe("");
      expect(view.container.textContent, body).toContain(body.trim().split("\n")[0]);
      view.unmount();
    }
    const fenced = renderMarkdown("```\n<!-- dohc:table row-heights=1:84 -->\n| A |\n| --- |\n| a |\n```");
    expect(fenced.container.querySelector("table")).toBeNull();
    expect(fenced.container.querySelector("pre")?.textContent).toContain("row-heights=1:84");
  });

  it("draws the height the document holds now, not one an earlier render parsed", () => {
    const view = renderMarkdown(annotated("1:84"));
    expect(rowHeights(view.container)).toEqual(["", "84px", ""]);

    view.rerender(<IncrementalMarkdownDocument body={annotated("1:120")} components={MARKDOWN_COMPONENTS} />);
    expect(rowHeights(view.container)).toEqual(["", "120px", ""]);
    view.rerender(<IncrementalMarkdownDocument body={TABLE} components={MARKDOWN_COMPONENTS} />);
    expect(rowHeights(view.container)).toEqual(["", "", ""]);
  });

  it("keeps a comment with its table when a split document's chunk fills up on it", () => {
    // Over the incremental threshold. The first chunk fills up on the comment,
    // so a split at the blank line under it would leave the table in the next
    // chunk without its heights.
    const filler = `${"padding paragraph ".repeat(60)}\n\n`.repeat(40);
    const body = (pairs: string) =>
      `${"x".repeat(4060)}\n\n<!-- dohc:table row-heights=${pairs} -->\n\n${TABLE}\n\n${filler}`;

    const view = renderMarkdown(body("1:84"));
    expect(rowHeights(view.container)).toEqual(["", "84px", ""]);
    expect(view.container.textContent).not.toContain("dohc:table");
    view.rerender(<IncrementalMarkdownDocument body={body("2:120")} components={MARKDOWN_COMPONENTS} />);
    expect(rowHeights(view.container)).toEqual(["", "", "120px"]);
  });
});
