import { describe, expect, it, vi } from "vitest";
import { dohcMarkdownExtensions, readInline } from "./dohc-markdown-extensions.js";
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
    ["callout", /\n( {0,3}>\s?\[!)/],
    ["mathBlock", /\n(\$\$)/],
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

  // marked asks a block start about the text after its first character, which
  // never begins a line.
  it("reads a block marker one character into a line as text", () => {
    for (const line of ["a$$b$$", "a> [!note] x"]) {
      expect(parseRichdocMarkdown(`${line}\n`).content).toEqual([
        { type: "paragraph", content: [{ type: "text", text: line }] },
      ]);
    }
  });
});

describe("inline searches", () => {
  type Tokenize = (src: string, tokens: unknown[]) => { raw?: string } | undefined;
  const tokenizerFor = (name: string) => {
    const tokenize = dohcMarkdownExtensions.find((extension) => extension.name === name)?.config
      .markdownTokenizer?.tokenize;
    if (typeof tokenize !== "function") throw new Error(`Missing tokenizer: ${name}`);
    return tokenize as unknown as Tokenize;
  };
  const firstIndex = (src: string, pattern: RegExp) => {
    const match = pattern.exec(src);
    return match ? match.index + match[1]!.length : -1;
  };

  // marked asks about ever shorter ends of the source a read began with. Asked
  // in that order inside the read, each search finds what the earlier,
  // whole-rest search found.
  it("find inside a read what a search of the whole rest finds", () => {
    const starts = [
      ["highlight", (src: string) => firstIndex(src, /(^|[^\\=])==(?!\s)(?!=)/)],
      ["mathInline", (src: string) => firstIndex(src, /(^|[^\\$])\$(?=[^\s$])/)],
      ["inlineAtom", (src: string) => src.indexOf("{{atom:")],
    ] as const;
    const wikilink = tokenizerFor("wikilink");
    const atom = tokenizerFor("inlineAtom");
    const earlierAtom = (src: string) => {
      const match = /^\{\{atom:([^}\s]+)([^}]*)\}\}/.exec(src);
      return match
        ? {
            type: "inlineAtom",
            raw: match[0],
            atomId: match[1],
            params: match[2]!.trim(),
            source: match[0].slice(2, -2),
          }
        : undefined;
    };
    const chunks = ["a", " ", "\n", "\\", "\\\\", "$", "$$", "=", "==", "[[", "]]", "]", "{{atom:"];
    chunks.push("}", "}}", "x y", "\t");
    let seed = 11;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    for (let sample = 0; sample < 3000; sample += 1) {
      let source = "";
      for (let index = 0; index < 24; index += 1) source += chunks[next() % chunks.length];
      const lexer = {};
      const tokens: unknown[] = [];
      readInline(lexer, tokens, source, () => {
        for (let at = 0; at < source.length; at += 1 + (next() % 3)) {
          const rest = source.slice(at);
          const label = JSON.stringify([source, at]);
          for (const [name, expected] of starts) {
            expect(startFor(name).call({ lexer }, rest.slice(1)), `${name} ${label}`).toBe(
              expected(rest.slice(1)),
            );
          }
          expect(wikilink(rest, tokens), label).toEqual(wikilink(rest, []));
          expect(atom(rest, tokens), label).toEqual(earlierAtom(rest));
          // A tokenizer can read its token's text in a read of its own.
          if (next() % 4 === 0) {
            const inner = readInline(lexer, [], "==a==", () =>
              startFor("highlight").call({ lexer }, "=a=="),
            );
            expect(inner).toBe(starts[0][1]("=a=="));
          }
        }
      });
    }
  });

  // Each start once read the rest of the text at every typed character; before
  // this fix these took 2.3 to 4.7 s, and the atoms 17 s.
  it.each([
    ["[", 32_768],
    ["$", 32_768],
    ["{{atom:", 8_192],
  ])(
    "reads a paragraph of typed %j once",
    (unit, size) => {
      const markdown = unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
      const started = performance.now();
      const doc = parseRichdocMarkdown(markdown);
      const elapsed = performance.now() - started;
      expect(doc.content?.map((block) => block.content?.map((node) => node.text).join(""))).toEqual(
        [markdown],
      );
      expect(elapsed).toBeLessThan(1_500);
    },
    60_000,
  );
});
