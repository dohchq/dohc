import { describe, expect, it } from "vitest";
import { stripMarkdown } from "./stripMarkdown";

const strip = (source: string) => stripMarkdown(source).text;

describe("stripMarkdown", () => {
  it("keeps the words of an agent's reply and drops its syntax", () => {
    expect(
      strip(
        "## Plan for **Friday**\n\nI'm in the *Personal* workspace, with `Hello.md`.\n\n- one\n- [x] two\n3. three\n\n> Remember the ferry.\n\n---\n\nSee [the plan](https://example.com/plan \"Plan\") and ![the cabin](https://example.com/c.png).",
      ),
    ).toBe(
      "Plan for Friday\n\nI'm in the Personal workspace, with Hello.md.\n\n• one\n• two\n3. three\n\nRemember the ferry.\n\n\nSee the plan and the cabin.",
    );
  });

  it("keeps code exactly, with its fences gone", () => {
    expect(strip("Run:\n```ts\nconst a = **b** * c_d;\n```\ndone")).toBe("Run:\nconst a = **b** * c_d;\ndone");
    expect(strip("use ``a ` b`` and `x*y*z`")).toBe("use a ` b and x*y*z");
  });

  it("keeps characters that are not syntax where they stand", () => {
    expect(strip("2 * 3 = 6, snake_case_name, a ~ b, #tag, 5 > 4, [x] alone")).toBe(
      "2 * 3 = 6, snake_case_name, a ~ b, #tag, 5 > 4, [x] alone",
    );
    expect(strip("\\*not bold\\* &amp; &#x41; &bogus; <https://example.com> <b>")).toBe(
      "*not bold* & A &bogus; https://example.com <b>",
    );
    expect(strip("&constructor; &toString;")).toBe("&constructor; &toString;");
    // A run with nothing to pair keeps its characters.
    expect(strip("file_ and a* b and ~c and __init__")).toBe("file_ and a* b and ~c and init");
  });

  it("pairs emphasis across the lines of a paragraph, not across blocks", () => {
    expect(strip("*one\ntwo* and ~~three\nfour~~")).toBe("one\ntwo and three\nfour");
    expect(strip("- *one\n- two*")).toBe("• *one\n• two*");
    expect(strip("*one\n\ntwo*")).toBe("*one\n\ntwo*");
  });

  it("drops reference definitions and table rules, and spaces table cells", () => {
    expect(strip("See [the plan][p].\n\n[p]: https://example.com\n\n| Day | Cost |\n| --- | ---: |\n| Fri | $180 |")).toBe(
      "See the plan.\n\n\n Day · Cost \n Fri · $180 ",
    );
  });

  it("keeps line breaks, including CRLF", () => {
    expect(strip("first **line**\r\nsecond line\n\nthird")).toBe("first line\nsecond line\n\nthird");
  });

  it("keeps atoms as written and says where they landed", () => {
    const source = "**hi @sam_x_** see [the @[notes/_draft_.md]](https://x.com) `@code`";
    const sam = source.indexOf("@sam");
    const note = source.indexOf("@[notes");
    const result = stripMarkdown(source, [
      { start: sam, end: sam + "@sam_x_".length },
      { start: note, end: note + "@[notes/_draft_.md]".length },
    ]);
    expect(result.text).toBe("hi @sam_x_ see the @[notes/_draft_.md] @code");
    expect(result.atoms.map((atom) => [atom.index, result.text.slice(atom.start, atom.end)])).toEqual([
      [0, "@sam_x_"],
      [1, "@[notes/_draft_.md]"],
    ]);
  });

  it("drops an atom that sits inside removed syntax", () => {
    const source = "[link](https://x.com/ @sam) after";
    const at = source.indexOf("@sam");
    const result = stripMarkdown(source, [{ start: at, end: at + 4 }]);
    expect(result.text).toBe("link after");
    expect(result.atoms).toEqual([]);
  });

  it("ends a link's target at the parenthesis that balances its opener", () => {
    expect(strip("See [the dish](https://en.wikipedia.org/wiki/Fish_(food)) today")).toBe("See the dish today");
    expect(strip("See [a](https://x.com/\\)) and [b](https://x.com/\\() now")).toBe("See a and b now");
    expect(strip("See [a](b (c) now")).toBe("See [a](b (c) now");
  });

  it("keeps an indented code block exactly", () => {
    expect(strip("Run this:\n\n    notify **@sam** now\n\n\tand *this*\nthen **stop**")).toBe(
      "Run this:\n\nnotify **@sam** now\n\nand *this*\nthen stop",
    );
    // An indented line inside a paragraph continues it.
    expect(strip("text\n    more **words**")).toBe("text\nmore words");
  });

  // The shapes that make Markdown parsers slow, at 50,000 characters. A strip
  // that rereads text would take seconds on several of them.
  const rep = (unit: string, size: number) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  const SHAPES: Record<string, string> = {
    nestedBrackets: rep("[", 25_000) + rep("]", 25_000),
    linkClosers: rep("a]", 50_000),
    linkOpeners: rep("[a](", 50_000),
    balancedTargets: rep("[a](", 25_000) + rep(")", 25_000),
    parens: rep("(", 25_000) + rep(")", 25_000),
    unclosedDestinations: rep("[a](b", 50_000),
    unclosedDestinationLines: rep("[a](b\n", 50_000),
    definitionLines: rep("[a\n", 50_000),
    emphasisOpeners: rep("*a ", 50_000),
    emphasisClosers: rep("a* ", 50_000),
    nestedEmphasis: rep("*a **a ", 25_000) + rep(" a** a*", 25_000),
    mismatched: rep("*a_ ", 50_000),
    strike: rep("~~a ", 25_000) + rep("a~~ ", 25_000),
    backtickRuns: Array.from({ length: 320 }, (_, size) => `e${"`".repeat(size + 1)}`).join("").slice(0, 50_000),
    singleTicks: rep("` ", 50_000),
    angles: rep("<", 50_000),
    autolinkOpeners: rep("<a:", 50_000),
    entities: rep("&#", 50_000),
    escapes: rep("\\", 50_000),
    tableCells: `a|b\n-|-\n${rep("|", 49_990)}`,
    quotes: rep("> ", 50_000),
    lists: rep("- ", 50_000),
    flatList: rep("- a\n", 50_000),
    fences: rep("```\na\n", 50_000),
    headings: rep("# a\n", 50_000),
  };

  it("stays linear on every slow shape", () => {
    stripMarkdown(SHAPES.flatList!);
    for (const [name, source] of Object.entries(SHAPES)) {
      const started = performance.now();
      stripMarkdown(source, [{ start: 10, end: 14 }]);
      const took = performance.now() - started;
      expect({ name, slow: took > 100 }).toEqual({ name, slow: false });
    }
  });
});
