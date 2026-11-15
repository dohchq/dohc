import { describe, expect, it, vi } from "vitest";
import { dohcMarkdownExtensions } from "./dohc-markdown-extensions.js";
import { parseRichdocMarkdown } from "./import-export.js";

function startFor(name: string): (source: string) => number {
  const start = dohcMarkdownExtensions.find((extension) => extension.name === name)?.config
    .markdownTokenizer?.start;
  if (typeof start !== "function") throw new Error(`Missing tokenizer: ${name}`);
  return start;
}

describe("block start searches", () => {
  // marked uses a start only to cut the paragraph it is about to read, which
  // ends at the first line holding only spaces. A marker past that line cuts
  // nothing, so the search stops there.
  it.each([
    ["callout", /(?:^|\n)( {0,3}>\s?\[!)/],
    ["mathBlock", /(?:^|\n)(\$\$)/],
  ] as const)("finds %s markers in the paragraph marked reads", (name, pattern) => {
    const start = startFor(name);
    const check = (source: string) => {
      const match = pattern.exec(source);
      const marker = match ? (match.index === 0 ? 0 : match.index + 1) : -1;
      const paragraphEnd = /\n *(?:\n|$)/.exec(source)?.index ?? source.length;
      const expected = marker < paragraphEnd ? marker : -1;
      expect(start(source), JSON.stringify(source)).toBe(expected);
    };
    for (const prefix of ["", "\n", "\n\n", "paragraph\n", "paragraph\n\n", "escaped\\", "x"]) {
      for (const indent of ["", " ", "   ", "    ", "\t"]) {
        for (const space of ["", " ", "\t", "\r", "\n", "\u00a0", "\u2028", "  "]) {
          check(`${prefix}${indent}>${space}[!note]\nbody`);
          check(`${prefix}${indent}$$tex$$\nbody`);
        }
      }
    }
    let seed = 42;
    const chunks = [
      "x",
      "\n",
      " ",
      "   ",
      ">",
      "\t",
      "\r",
      "[!",
      "$$",
      "$",
      "\\",
      "[",
      "!",
      "\u00a0",
    ];
    for (let sample = 0; sample < 2000; sample += 1) {
      let source = "";
      for (let index = 0; index < 24; index += 1) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        source += chunks[seed % chunks.length];
      }
      check(source);
    }
  });

  it("limits regular-expression work to marker prefixes on a long line", () => {
    const starts = [startFor("callout"), startFor("mathBlock")];
    const exec = RegExp.prototype.exec;
    let scanned = 0;
    const spy = vi.spyOn(RegExp.prototype, "exec").mockImplementation(function (
      this: RegExp,
      source: string,
    ) {
      scanned += source.length;
      return Reflect.apply(exec, this, [source]);
    });
    let positions: number[];
    try {
      positions = starts.map((start) => start("text[!$$".repeat(8192)));
    } finally {
      spy.mockRestore();
    }
    expect(positions).toEqual([-1, -1]);
    expect(scanned).toBeLessThanOrEqual(8192);
  });
});

describe("wikilink start search", () => {
  it("finds the wikilinks the earlier pattern found", () => {
    const start = startFor("wikilink");
    const pattern = /(^|[^\\])\[\[(?:\\.|[^\]\n\\])+\]\]/;
    const check = (source: string) => {
      const match = pattern.exec(source);
      const expected = match ? match.index + match[1]!.length : -1;
      expect(start(source), JSON.stringify(source)).toBe(expected);
    };
    const lineEnds = ["\n", "\r", String.fromCharCode(0x2028), String.fromCharCode(0x2029)];
    for (const inner of ["", "a", "\\]", "\\|", "\\\\", "[", "a|b", "\\", ...lineEnds]) {
      for (const prefix of ["", "x", "\\", "\\\\", "[", "]"]) check(`${prefix}[[${inner}]]`);
      for (const end of lineEnds) check(`[[a\\${end}b]]`);
    }
    let seed = 7;
    const chunks = ["[", "[[", "]", "]]", "\\", "a", "|", ...lineEnds];
    for (let sample = 0; sample < 4000; sample += 1) {
      let source = "";
      for (let index = 0; index < 16; index += 1) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        source += chunks[seed % chunks.length];
      }
      check(source);
    }
  });

  it("reads a paragraph of typed brackets without rescanning each one", () => {
    const started = performance.now();
    const doc = parseRichdocMarkdown("[".repeat(4096));
    const elapsed = performance.now() - started;
    expect(doc.content?.[0]?.content?.[0]?.text).toBe("[".repeat(4096));
    // The earlier pattern took about 25 s here; a single pass takes well under 1 s.
    expect(elapsed).toBeLessThan(2_000);
  }, 60_000);
});
