import { Lexer } from "marked";
import { describe, expect, it } from "vitest";
import { lexesAsH1, opensWithH1 } from "./firstBlock";

const lines = (count: number, word = "Line") => Array.from({ length: count }, (_, line) => `${word} ${line}`).join("\n");

// Each body, and whether the editor's lexer reads its first block as an H1.
const BODIES: [string, string, boolean][] = [
  ["ATX H1", "# Plan\n\nBody\n", true],
  ["ATX H1, no blank line after", "# Plan\nBody\nmore", true],
  ["# alone", "#\n", true],
  ["# at the end of the body", "#", true],
  ["# then a tab", "#\tPlan\n", true],
  ["# then a no-break space", "# Plan\n", true],
  ["# then an ideographic space", "#　Plan\n", true],
  ["# then a line separator", "# Plan\n", false],
  ["# Plan with a paragraph separator", "# Plan more\n", false],
  ["a line separator inside a setext H1", "Pl an\n===\n", false],
  ["#word", "#word\n", false],
  ["##", "## Plan\n", false],
  ["six #", "###### Plan\n", false],
  ["seven #", "####### Plan\n", false],
  ["three spaces, then #", "   # Plan\n", true],
  ["four spaces, then #", "    # Plan\n", false],
  ["a tab, then #", "\t# Plan\n", false],
  ["blank lines first", "\n \t\n# Plan\n", true],
  ["CRLF", "# Plan\r\n\r\nBody\r\n", true],
  ["lone CR", "# Plan\rBody\r", true],
  ["setext with CRLF", "First\r\nSecond\r\n===\r\n", true],
  ["setext with lone CR", "First\rSecond\r===\r", true],
  ["a byte order mark", "﻿# Plan\n", false],
  ["a no-break space line first", " \n# Plan\n", false],
  ["setext H1", "Plan\n===\n", true],
  ["setext H1, no line end", "Plan\n===", true],
  ["setext H1 with trailing spaces", "Plan\n===  \n", true],
  ["setext H1 with a trailing tab", "Plan\n===\t\n", false],
  ["a tab-ended === in the paragraph, then an underline", "Plan\n===\t\n===\n", true],
  ["a tab-ended --- in the paragraph, then an underline", "Plan\n---\t\n===\n", true],
  ["setext H1 under 17 lines", `${lines(17)}\n===\n`, true],
  ["setext H1 under 400 lines", `${lines(400)}\n===\n`, true],
  ["setext H2", "Plan\n---\n", false],
  ["a paragraph, a blank line, then ===", "Plan\n\n===\n", false],
  ["a paragraph, a whitespace line, then ===", "Plan\n \n===\n", false],
  ["a paragraph a # line ends", "Plan\n#tag\n===\n", false],
  ["a paragraph a fence ends", "Intro\n```\n===\n```\n", false],
  ["a paragraph a quote ends", "Plan\n> x\n===\n", false],
  ["a paragraph with an indented line", "Plan\n    more\n===\n", false],
  ["a paragraph with a list line", "Plan\n- x\n===\n", false],
  ["a paragraph with no underline", `Intro\n${lines(50)}\n`, false],
  ["#word over an underline", "#word\n===\n", false],
  ["a fence holding ===", "```text\nPlan\n===\n```\n", false],
  ["a tilde fence holding # x", "~~~\ncode\n\n# x\n~~~\n", false],
  ["a fence with a backtick in its info", "``` a`b\n===\n", false],
  ["a quote", "> # Plan\n", false],
  ["a list item", "- # Plan\n", false],
  ["a list item over ===", "- Plan\n===\n", false],
  ["an ordered list item", "1. Plan\n===\n", false],
  ["a thematic break", "***\n# Plan\n", false],
  ["spaced thematic break", "- - -\n", false],
  ["inline HTML over ===", "<em>Plan</em>\n===\n", true],
  ["an HTML block over ===", "<div>\n===\n</div>\n", false],
  ["a link definition, then # Title", "[a]: https://example.com\n# Title\n", false],
  ["a link definition over ===", "[a]: https://example.com\nPlan\n===\n", false],
  ["a table row over ===", "a | b\n===\n", true],
  ["empty", "", false],
];

describe("opensWithH1", () => {
  // Every answer, decided from the lines or by lexing the lines it returns,
  // matches the lexer reading the whole body.
  it.each(BODIES)("agrees with the lexer: %s", (_, body, expected) => {
    expect(lexesAsH1(Lexer, body)).toBe(expected);
    const decided = opensWithH1(body);
    expect(typeof decided === "string" ? lexesAsH1(Lexer, decided) : decided).toBe(expected);
  });

  // Every document of one to four lines from lines that sit on the rules'
  // edges, and a sample of them with CRLF line ends, answers as the lexer
  // reading the whole document does.
  it("agrees with the lexer on every short document built from the rules' edge lines", () => {
    const alphabet = [
      "Plan", "===", "=== ", "===\t", "---", "--- ", "- - -", "", " ",
      "# x", "# x", "    code", "\t===", "> q", "- item", "<div>", "```",
    ];
    const documents: string[][] = [[]];
    const disagreements: string[] = [];
    for (let length = 1; length <= 4; length += 1) {
      for (const lines of documents.splice(0)) {
        for (const line of alphabet) documents.push([...lines, line]);
      }
      documents.forEach((lines, index) => {
        const endings = index % 7 === 0 ? ["\n", "\r\n"] : ["\n"];
        for (const ending of endings) {
          const body = lines.join(ending);
          const decided = opensWithH1(body);
          const answer = typeof decided === "string" ? lexesAsH1(Lexer, decided) : decided;
          if (answer !== lexesAsH1(Lexer, body)) disagreements.push(JSON.stringify(body));
        }
      });
    }
    expect(disagreements).toEqual([]);
  });

  it("decides a clear ATX heading, and a paragraph with no underline, without lexing", () => {
    expect(opensWithH1("# Plan\nBody\nmore")).toBe(true);
    expect(opensWithH1(`Intro\n${lines(5_000)}\n`)).toBe(false);
  });

  it("returns only the lines through the underline to lex", () => {
    expect(opensWithH1(`${lines(17)}\n===\n${lines(5_000, "Body")}\n`)).toBe(`${lines(17)}\n===`);
  });
});
