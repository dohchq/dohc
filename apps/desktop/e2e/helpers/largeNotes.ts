export type LargeNoteKind = "small" | "plain" | "rich";

export const LARGE_NOTE_SECTIONS = 400;

const sentence = (i: number) =>
  `Section ${i} keeps a paragraph of ordinary prose with a [[note-${i % 37}]] link, some **bold** text and a value of ${i * 17}.`;

/**
 * Markdown for the notes the typing checks use.
 *
 * - `small`: 12 headings and paragraphs, 1.5 KB.
 * - `plain`: 400 sections of a heading and four paragraphs, 190 KB.
 * - `rich`: 400 sections of a heading, a paragraph, a code block, a callout and
 *   a table, with a Mermaid diagram in every fifth, 153 KB.
 *
 * `plain` and `rich` are close in size, so the two separate what a note's
 * length costs from what its block types cost.
 */
export function largeNote(kind: LargeNoteKind): string {
  if (kind === "small")
    return Array.from({ length: 12 }, (_, i) => `## Heading ${i}\n\n${sentence(i)}\n`).join("\n");
  const sections: string[] = [];
  for (let i = 0; i < LARGE_NOTE_SECTIONS; i++) {
    if (kind === "plain") {
      sections.push(
        `## Heading ${i}\n\n${[0, 1, 2, 3].map((n) => sentence(i * 4 + n)).join("\n\n")}\n`,
      );
      continue;
    }
    sections.push(
      [
        `## Heading ${i}`,
        sentence(i),
        "```ts\n" +
          `export function compute${i}(input: number): number {\n  return input * ${i} + 1;\n}\n` +
          "```",
        `> [!note] Callout ${i}\n> A callout body for section ${i}.`,
        `| Name | Value | Note |\n| --- | --- | --- |\n| row ${i} | ${i * 3} | first |\n| next ${i} | ${i * 5} | second |`,
        ...(i % 5 === 0 ? ["```mermaid\ngraph TD\n  A" + i + " --> B" + i + "\n```"] : []),
      ].join("\n\n") + "\n",
    );
  }
  return sections.join("\n");
}
