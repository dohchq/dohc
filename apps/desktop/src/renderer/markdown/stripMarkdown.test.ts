import { describe, expect, it } from "vitest";
import { stripMarkdown, takeStripStepsForTests } from "./stripMarkdown";

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
    const source = "[link](https://x.com/@sam) after";
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

  // The shapes that make Markdown parsers slow, each built at a given size. A
  // strip that rereads text takes far more steps per character on a larger
  // copy of one of them.
  const rep = (unit: string, size: number) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  const SHAPES: Record<string, (size: number) => string> = {
    nestedBrackets: (size) => rep("[", size / 2) + rep("]", size / 2),
    linkClosers: (size) => rep("a]", size),
    linkOpeners: (size) => rep("[a](", size),
    balancedTargets: (size) => rep("[a](", size / 2) + rep(")", size / 2),
    parens: (size) => rep("(", size / 2) + rep(")", size / 2),
    unclosedDestinations: (size) => rep("[a](b", size),
    unclosedDestinationLines: (size) => rep("[a](b\n", size),
    definitionLines: (size) => rep("[a\n", size),
    definedBrackets: (size) => "[a]: b\n" + rep("[".repeat(500) + "]".repeat(500), size),
    definedImages: (size) => "[a]: b\n" + rep("![".repeat(300) + "]".repeat(300), size),
    blankDefinitionAngles: (size) => "[]: b\n" + rep("![](<a ", size),
    blankDefinitionParens: (size) => "[ ]: b\n" + rep("![](a (", size),
    blankDefinitionBlanks: (size) => "[]: b\n" + rep("![](a(b c) ", size),
    emphasisOpeners: (size) => rep("*a ", size),
    emphasisClosers: (size) => rep("a* ", size),
    nestedEmphasis: (size) => rep("*a **a ", size / 2) + rep(" a** a*", size / 2),
    mismatched: (size) => rep("*a_ ", size),
    multipleOfThree: (size) => rep("a**", size / 2) + rep("a*", size / 2),
    mixedWidths: (size) => rep("***a ", size / 2) + rep(" a*", size / 2),
    intraword: (size) => rep("a*a**a_a__", size),
    emphasisInLinks: (size) => rep("[*a ", size / 2) + rep("a*](b) ", size / 2),
    linksInLinks: (size) => rep("[a [b](c) ", size),
    unclosedTitles: (size) => rep('[a](b "', size),
    unclosedParenTitles: (size) => rep("[a](b (", size),
    unclosedAngles: (size) => rep("[a](<b", size),
    strike: (size) => rep("~~a ", size / 2) + rep("a~~ ", size / 2),
    backtickRuns: (size) => Array.from({ length: 361 }, (_, run) => `e${"`".repeat(run + 1)}`).join("").slice(0, size),
    singleTicks: (size) => rep("` ", size),
    angles: (size) => rep("<", size),
    autolinkOpeners: (size) => rep("<a:", size),
    entities: (size) => rep("&#", size),
    escapes: (size) => rep("\\", size),
    tableCells: (size) => `a|b\n-|-\n${rep("|", size)}`,
    quotes: (size) => rep("> ", size),
    lists: (size) => rep("- ", size),
    flatList: (size) => rep("- a\n", size),
    fences: (size) => rep("```\na\n", size),
    headings: (size) => rep("# a\n", size),
  };

  // Steps count work, so the check holds on a busy machine. Eight times the
  // characters may cost at most 1.5 times the steps per character; a strip
  // that rereads text costs about eight times as many.
  it("takes steps in proportion to the body on every slow shape", () => {
    const stepsPerCharacter = (source: string) => {
      takeStripStepsForTests();
      stripMarkdown(source, [{ start: 10, end: 14 }]);
      return takeStripStepsForTests() / source.length;
    };
    for (const [name, shape] of Object.entries(SHAPES)) {
      const growth = stepsPerCharacter(shape(65_536)) / stepsPerCharacter(shape(8_192));
      expect(growth, name).toBeLessThan(1.5);
    }
  });
});
