// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import {
  getDohcProseMirrorSchema,
  getDohcYDocBodyFragment,
  markdownToYDoc,
} from "@dohc/ydoc-projection";
import { IncrementalMarkdownDocument } from "./IncrementalMarkdownDocument";
import { MARKDOWN_COMPONENTS } from "./markdownComponents";
import { splitMarkdownBlocks } from "./splitMarkdownBlocks";

vi.mock("../bridge", () => ({ bridge: vi.fn() }));

afterEach(() => {
  cleanup();
});

// The read view must give a row the height the editor gives it, or the page
// moves when the editor replaces the read body. Each case runs the editor's
// own import and the read view on the same text.
type Rows = { heights: string[]; comment: boolean };

function editorRows(markdown: string): Rows {
  const body = yXmlFragmentToProseMirrorRootNode(
    getDohcYDocBodyFragment(markdownToYDoc(markdown)),
    getDohcProseMirrorSchema(),
  );
  const heights: string[] = [];
  body.descendants((node) => {
    const height: unknown = node.attrs.height;
    if (node.type.name === "tableRow") heights.push(typeof height === "number" ? `${height}px` : "");
  });
  return { heights, comment: body.textContent.includes("dohc:table") };
}

function readRows(markdown: string): Rows {
  const view = render(
    <IncrementalMarkdownDocument body={markdown} components={MARKDOWN_COMPONENTS} />,
  );
  const rows = {
    heights: Array.from(view.container.querySelectorAll("tr"), (row) => row.style.height),
    comment: view.container.textContent.includes("dohc:table"),
  };
  view.unmount();
  return rows;
}

const COMMENT = "<!-- dohc:table row-heights=1:84,2:120 -->";
const TABLE = ["| A |", "| --- |", "| a |", "| b |"];
const lines = (...parts: (string | string[])[]) => parts.flat().join("\n");
const prefixed = (prefix: string, rows: string[]) => rows.map((row) => prefix + row);

// Whether the editor reads the comment, and the text it reads it in.
const CASES: [string, boolean, string][] = [
  ["right above its table", true, lines(COMMENT, TABLE)],
  ["an empty blank line", true, lines(COMMENT, "", TABLE)],
  ["a blank line holding a space", false, lines(COMMENT, " ", TABLE)],
  ["a blank line holding a tab", false, lines(COMMENT, "\t", TABLE)],
  ["spaces after the comment", true, lines(`${COMMENT}   `, TABLE)],
  ["a space and a tab after the comment, then a blank line", true, lines(`${COMMENT} \t`, "", TABLE)],
  ["several empty blank lines", true, lines(COMMENT, "", "", "", TABLE)],
  ["several blank lines, one holding spaces", false, lines(COMMENT, "", "  ", "", TABLE)],
  ["Windows line endings", true, lines(COMMENT, "", TABLE).replaceAll("\n", "\r\n")],
  ["an indented comment", false, lines(` ${COMMENT}`, TABLE)],
  ["an indented table", true, lines(COMMENT, "", `   ${TABLE[0]}`, TABLE.slice(1))],
  ["a paragraph between", false, lines(COMMENT, "Text.", TABLE)],
  [
    "the reviewer's input",
    false,
    "<!-- dohc:table row-heights=1:84 -->\n \n| A |\n| --- |\n| a |",
  ],

  ["a quote", true, lines(`> ${COMMENT}`, prefixed("> ", TABLE))],
  ["a quote's empty blank line", true, lines(`> ${COMMENT}`, ">", prefixed("> ", TABLE))],
  ["a quote's blank line holding its one space", true, lines(`> ${COMMENT}`, "> ", prefixed("> ", TABLE))],
  ["a quote's blank line holding two spaces", false, lines(`> ${COMMENT}`, ">  ", prefixed("> ", TABLE))],
  ["a quote's blank line holding a tab", true, lines(`> ${COMMENT}`, ">\t", prefixed("> ", TABLE))],
  ["a quote's blank line holding a space and a tab", false, lines(`> ${COMMENT}`, "> \t", prefixed("> ", TABLE))],
  ["several quote blank lines", true, lines(`> ${COMMENT}`, ">", "> ", prefixed("> ", TABLE))],
  ["a tab after a quote's comment", true, lines(`> ${COMMENT}\t`, prefixed("> ", TABLE))],
  ["a quote's comment after two spaces", false, lines(`>  ${COMMENT}`, prefixed("> ", TABLE))],
  ["a quote's comment after a tab", true, lines(`>\t${COMMENT}`, prefixed("> ", TABLE))],

  ["a list item", true, lines(`- ${COMMENT}`, prefixed("  ", TABLE))],
  ["a list item's empty blank line", true, lines(`- ${COMMENT}`, "", prefixed("  ", TABLE))],
  ["a list item's blank line holding its indent", true, lines(`- ${COMMENT}`, "  ", prefixed("  ", TABLE))],
  ["a list item's blank line holding one space more", false, lines(`- ${COMMENT}`, "   ", prefixed("  ", TABLE))],
  ["a list item's blank line holding a tab", false, lines(`- ${COMMENT}`, "\t", prefixed("  ", TABLE))],
  ["an ordered item's blank line holding its indent", true, lines(`1. ${COMMENT}`, "   ", prefixed("   ", TABLE))],
  ["a list item's comment after a tab", true, lines(`-\t${COMMENT}`, "    ", prefixed("    ", TABLE))],
  ["a comment later in a list item", true, lines("- Text.", "", `  ${COMMENT}`, "  ", prefixed("  ", TABLE))],
  ["a comment indented past its list item's indent", false, lines("- Text.", "", `   ${COMMENT}`, prefixed("  ", TABLE))],

  ["a tab after a list item's comment", false, lines(`- ${COMMENT}\t`, prefixed("  ", TABLE))],
  ["a tab after a nested list item's comment", false, lines("- Text.", `  - ${COMMENT}\t`, prefixed("    ", TABLE))],
  ["a tab after a later comment in a list item", false, lines("- Text.", "", `  ${COMMENT}\t`, prefixed("  ", TABLE))],
  ["an ordered item's comment after a tab", true, lines(`1.\t${COMMENT}`, prefixed("    ", TABLE))],

  ["a list in a quote", true, lines(`> - ${COMMENT}`, ">", prefixed(">   ", TABLE))],
  ["a list in a quote, its blank line holding spaces", false, lines(`> - ${COMMENT}`, ">    ", prefixed(">   ", TABLE))],
  ["a quote in a list", true, lines(`- > ${COMMENT}`, "  >", prefixed("  > ", TABLE))],
  ["a quote in a list, its blank line holding spaces", false, lines(`- > ${COMMENT}`, "  >  ", prefixed("  > ", TABLE))],

  ["a tab after a comment in a list in a quote", false, lines(`> - ${COMMENT}\t`, ">", prefixed(">   ", TABLE))],
  ["a quote in a list, its comment after a tab", true, lines(`- >\t${COMMENT}`, prefixed("  > ", TABLE))],
  ["a tab after a comment in a quote in a list", false, lines(`- > ${COMMENT}\t`, prefixed("  > ", TABLE))],

  ["a task item", true, lines("- [ ] Task", "", `  ${COMMENT}`, prefixed("  ", TABLE))],
];

// The first chunk of a split document fills up on the comment, so a split
// after it would leave the table in the next chunk.
const split = (markdown: string) =>
  `${"x".repeat(4060)}\n\n${markdown}\n\n${`${"padding paragraph ".repeat(60)}\n\n`.repeat(32)}`;

describe("read table row heights match the editor's", () => {
  it.each(CASES)("%s", (_name, editorReads, markdown) => {
    const editor = editorRows(markdown);
    expect(editor.heights.includes("84px"), "The editor reads the comment").toBe(editorReads);
    expect(editor.comment).toBe(!editorReads);

    expect(readRows(markdown), "The read view disagrees with the editor").toEqual(editor);
    // A chunk keeps the comment, the blank lines as written, and the table.
    expect(splitMarkdownBlocks(split(markdown)).some((chunk) => chunk.includes(markdown))).toBe(true);
    expect(readRows(split(markdown)), "A split document disagrees with the editor").toEqual(
      editorRows(split(markdown)),
    );
  });
});
