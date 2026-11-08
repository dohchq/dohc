import { describe, expect, it } from "vitest";
import { initialChunkCount, splitMarkdownBlocks } from "./splitMarkdownBlocks";

describe("splitMarkdownBlocks", () => {
  it("returns one chunk for a small document (identical render path)", () => {
    const chunks = splitMarkdownBlocks("# Title\n\nA paragraph.\n");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("# Title");
    expect(chunks[0]).toContain("A paragraph.");
  });

  it("never splits inside a fenced code block", () => {
    const fence = "```js\nconst a = 1;\n\n\nconst b = 2;\n```";
    const filler = Array.from({ length: 400 }, (_, i) => `Paragraph ${i} with some words.`).join("\n\n");
    const doc = `${filler}\n\n${fence}\n\n${filler}`;
    const chunks = splitMarkdownBlocks(doc);
    expect(chunks.length).toBeGreaterThan(1);
    // The full fence (including its interior blank lines) lives in one chunk.
    const holders = chunks.filter((c) => c.includes("const a = 1;"));
    expect(holders).toHaveLength(1);
    expect(holders[0]).toContain("const b = 2;");
    expect(holders[0]).toContain("```js");
  });

  it("appends reference link definitions to every chunk so links resolve", () => {
    const filler = Array.from({ length: 400 }, (_, i) => `Line ${i} [docs][d] here.`).join("\n\n");
    const doc = `${filler}\n\n[d]: https://example.test/docs`;
    const chunks = splitMarkdownBlocks(doc);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk).toContain("[d]: https://example.test/docs");
    }
  });

  it("chunk boundaries are blank-line block boundaries (no mid-paragraph cuts)", () => {
    const paragraphs = Array.from({ length: 300 }, (_, i) => `Paragraph number ${i} continues onto words.`);
    const doc = paragraphs.join("\n\n");
    const chunks = splitMarkdownBlocks(doc);
    // Re-joining chunks reproduces every paragraph intact.
    const joined = chunks.join("\n\n");
    for (const p of paragraphs) expect(joined).toContain(p);
    // And no chunk starts or ends mid-paragraph (always full lines from the set).
    for (const chunk of chunks) {
      const first = chunk.split("\n\n")[0];
      expect(first.startsWith("Paragraph number ")).toBe(true);
    }
  });

  it("keeps a table's row-height comment in the table's chunk across blank lines", () => {
    const comment = "<!-- dohc:table row-heights=1:84 -->";
    const table = "| A | B |\n| --- | --- |\n| a | b |";
    // The first chunk fills up on the line above the table.
    const doc = (above: string) => `${"x".repeat(4060)}\n\n${above}\n\n\n${table}\n\nAfter.`;
    const holder = (chunks: string[], text: string) => chunks.find((chunk) => chunk.includes(text));

    const plain = splitMarkdownBlocks(doc("a".repeat(comment.length)));
    expect(holder(plain, "| A | B |")).not.toBe(holder(plain, "a".repeat(comment.length)));
    const chunks = splitMarkdownBlocks(doc(comment));
    expect(holder(chunks, "| A | B |")).toBe(holder(chunks, comment));
    expect(holder(chunks, comment)).toContain(`${comment}\n\n\n${table}`);

    // A list item reads a comment across a blank line too.
    const item = `- ${comment}\n\n${table.replaceAll(/^/gmu, "  ")}`;
    const listed = splitMarkdownBlocks(`${"x".repeat(4060)}\n\n${item}\n\nAfter.`);
    expect(holder(listed, comment)).toContain(item);
  });

  it("initialChunkCount selects the leading window by bytes", () => {
    const chunks = ["a".repeat(3000), "b".repeat(3000), "c".repeat(3000)];
    expect(initialChunkCount(chunks, 4000)).toBe(2);
    expect(initialChunkCount(chunks, 100)).toBe(1);
    expect(initialChunkCount(chunks, 1_000_000)).toBe(3);
  });
});
