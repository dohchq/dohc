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
    // The full fence (including its interior blank lines) lives in ONE chunk.
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

  it("initialChunkCount selects the leading window by bytes", () => {
    const chunks = ["a".repeat(3000), "b".repeat(3000), "c".repeat(3000)];
    expect(initialChunkCount(chunks, 4000)).toBe(2);
    expect(initialChunkCount(chunks, 100)).toBe(1);
    expect(initialChunkCount(chunks, 1_000_000)).toBe(3);
  });
});
