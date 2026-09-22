// Synthetic fidelity corpus. The markdown entries mirror (and extend) the
// engine's ydocFidelity.test.ts corpus so the same structures that harness
// pins for projection fidelity are pushed through the yrs interop path.

export interface CorpusEntry {
  name: string;
  kind: "richdoc" | "plaintext";
  markdown: string;
}

export const CORPUS: CorpusEntry[] = [
  {
    name: "headings + inline marks",
    kind: "richdoc",
    markdown: [
      "# ATX heading",
      "",
      "A paragraph with **bold**, *emphasis*, `code`, and",
      "[a link](https://example.com).",
    ].join("\n"),
  },
  {
    name: "lists + nesting + blockquote",
    kind: "richdoc",
    markdown: [
      "> Quote level one",
      ">",
      "> - quoted bullet",
      "",
      "1. ordered",
      "2. ordered again",
      "   - nested bullet",
    ].join("\n"),
  },
  {
    name: "GFM table + task list + strikethrough",
    kind: "richdoc",
    markdown: [
      "| Metric | Value |",
      "| --- | ---: |",
      "| apples | 10 |",
      "",
      "- [ ] write the migration",
      "- [x] keep completed work visible",
      "",
      "~~obsolete note~~",
    ].join("\n"),
  },
  {
    name: "code fence",
    kind: "richdoc",
    markdown: ["```ts", "const answer = 42", "```"].join("\n"),
  },
  {
    name: "retired query fence labels stay inert",
    kind: "richdoc",
    markdown: [
      "```query",
      "from tasks",
      "```",
      "",
      "```dohc-query",
      "sum(hours)",
      "```",
    ].join("\n"),
  },
  {
    name: "frontmatter + obsidian power-user syntax",
    kind: "richdoc",
    markdown: [
      "---",
      "title: Daily note",
      "tags:",
      "  - alpha/beta",
      "---",
      "",
      "# Daily note",
      "",
      "See [[Projects/dohc#Graph view|graph plan]] and ![[assets/chart.png]].",
      "",
      "Body with #work/deep and ==highlighted text==.",
    ].join("\n"),
  },
  {
    name: "unicode: CJK, emoji, RTL, combining marks",
    kind: "richdoc",
    markdown: [
      "# 你好 world 👩‍👩‍👧‍👦",
      "",
      "مرحبا **بالعالم** and é combining, plus 𝔘𝔫𝔦𝔠𝔬𝔡𝔢.",
      "",
      "Emoji in `code 🎯` and a [链接](https://example.com/路径?q=值).",
    ].join("\n"),
  },
  {
    name: "deep nesting + hr + images",
    kind: "richdoc",
    markdown: [
      "- level 1",
      "  - level 2",
      "    - level 3 with **bold *nested italic* tail**",
      "",
      "---",
      "",
      "![alt text](https://example.com/img.png \"title\")",
      "",
      "Final ~~strike **bold-in-strike**~~ paragraph.",
    ].join("\n"),
  },
  {
    name: "frontmatter scalar types",
    kind: "richdoc",
    markdown: [
      "---",
      "id: abc-123",
      "title: Typed values",
      "count: 42",
      "ratio: 0.5",
      "done: true",
      "nothing: null",
      "nested:",
      "  a: 1",
      "  b: [x, y]",
      "---",
      "",
      "Body paragraph.",
    ].join("\n"),
  },
  {
    name: "plaintext with frontmatter",
    kind: "plaintext",
    markdown: [
      "---",
      "title: Plain",
      "---",
      "",
      "line one",
      "line two\twith a tab",
      "line three 🎉",
    ].join("\n"),
  },
  {
    name: "plaintext empty-ish",
    kind: "plaintext",
    markdown: "just one line",
  },
  {
    name: "long mixed document",
    kind: "richdoc",
    markdown: Array.from({ length: 40 }, (_, i) =>
      [
        `## Section ${i}`,
        "",
        `Paragraph ${i} with **bold ${i}**, *em ${i}*, and \`code ${i}\`.`,
        "",
        `- item ${i}.1`,
        `- item ${i}.2 with [link ${i}](https://example.com/${i})`,
        "",
      ].join("\n"),
    ).join("\n"),
  },
];
