import { frontmatterMapValues } from "@dohc/ydoc-projection/frontmatter-map";
import { describe, expect, it } from "vitest";
import {
  applyFrontmatter,
  displayFrontmatterValue,
  frontmatterEntries,
  frontmatterEntriesFromPairs,
  listItems,
  orderFrontmatter,
  parseFrontmatter,
} from "./frontmatter";
import { EDGE_DISPLAY, EDGE_MARKDOWN, receivedYDoc } from "./frontmatter.edge-fixture";

describe("markdown frontmatter helpers", () => {
  it("keeps malformed frontmatter visible as body text", () => {
    const markdown = ["---", "title: Broken", "tags: [", "---", "# Body"].join(
      "\n",
    );

    expect(parseFrontmatter(markdown)).toEqual({ meta: {}, body: markdown });
    expect(frontmatterEntries(markdown)).toEqual([]);
  });

  it("keeps non-map frontmatter-looking blocks visible as body text", () => {
    const scalar = ["---", "just a divider", "---", "# Body"].join("\n");
    const explicitNull = ["---", "null", "---", "# Body"].join("\n");
    const array = ["---", "- a", "- b", "---", "# Body"].join("\n");

    expect(parseFrontmatter(scalar)).toEqual({ meta: {}, body: scalar });
    expect(parseFrontmatter(explicitNull)).toEqual({
      meta: {},
      body: explicitNull,
    });
    expect(parseFrontmatter(array)).toEqual({ meta: {}, body: array });
    expect(applyFrontmatter(scalar, { status: "active" })).toBe(
      ["---", "status: active", "---", "", "---", "just a divider", "---", "# Body"].join(
        "\n",
      ),
    );
  });

  it("treats empty and comment-only frontmatter as an empty map and keeps its comments", () => {
    const markdown = ["---", "# dohc metadata", "", "---", "# Body"].join("\n");

    expect(parseFrontmatter(markdown)).toEqual({ meta: {}, body: "# Body" });
    expect(applyFrontmatter(markdown, { status: "active" })).toBe(
      ["---", "# dohc metadata", "", "status: active", "---", "# Body"].join("\n"),
    );
  });

  it("reads values the settle keeps as text and writes back only the changed key", () => {
    const markdown = [
      "---", "count: !custom 7", "flag: !!bool yes", "id: 99999999999999999999", "title: Draft", "---", "", "Body",
    ].join("\n");

    expect(parseFrontmatter(markdown).meta).toEqual({
      count: "7", flag: "yes", id: "99999999999999999999", title: "Draft",
    });
    expect(applyFrontmatter(markdown, { ...parseFrontmatter(markdown).meta, title: "Plan" })).toBe(
      markdown.replace("title: Draft", "title: Plan"),
    );
  });

  it("applies properties while preserving the markdown body", () => {
    const markdown = "---\nid: note-1\ntitle: Plan\n---\n\n# Plan\n";

    expect(
      applyFrontmatter(markdown, {
        id: "note-1",
        title: "Plan",
        status: "active",
      }),
    ).toBe("---\nid: note-1\ntitle: Plan\nstatus: active\n---\n\n# Plan\n");
  });

  it("shows a list of text as its items, apart from the list it holds", () => {
    const entries = frontmatterEntries(
      "---\ntags:\n  - a\n  - b\nyears: ['2026', 'yes', 'null']\nnone: []\n---\n\n# Plan\n",
    );

    expect(entries).toEqual([
      { key: "tags", value: "a, b", list: true, sourceKey: "tags", sourceValue: "a, b", rawValue: ["a", "b"] },
      {
        key: "years",
        value: "2026, yes, null",
        list: true,
        sourceKey: "years",
        sourceValue: "2026, yes, null",
        rawValue: ["2026", "yes", "null"],
      },
      { key: "none", value: "", list: true, sourceKey: "none", sourceValue: "", rawValue: [] },
    ]);
    expect(displayFrontmatterValue({ pinned: true })).toBe("pinned: true");
  });

  it("shows any other list or map on one line, with why it can't be edited", () => {
    const entries = frontmatterEntries([
      "---",
      "places: [\"Kyoto, Japan\", Osaka]",
      "days: [1, 2]",
      "spaced: [' a', b]",
      "blank: ['', b]",
      "broken: [\"a\\nb\"]",
      "where: {lat: 35.5, lng: 135.7}",
      "---",
      "",
    ].join("\n"));
    const reason = (problem: string) => `dohc can't edit this list because ${problem}. Change it in another app, or ask an agent.`;

    expect(entries.map(({ key, value, list, readOnly }) => ({ key, value, list, readOnly }))).toEqual([
      { key: "places", value: "['Kyoto, Japan', Osaka]", list: undefined, readOnly: reason("an item has a comma") },
      { key: "days", value: "[1, 2]", list: undefined, readOnly: reason("some items aren't text") },
      {
        key: "spaced",
        value: "[' a', b]",
        list: undefined,
        readOnly: reason("an item is blank or starts or ends with a space"),
      },
      {
        key: "blank",
        value: "['', b]",
        list: undefined,
        readOnly: reason("an item is blank or starts or ends with a space"),
      },
      { key: "broken", value: "[\"a\\nb\"]", list: undefined, readOnly: reason("an item has a line break") },
      {
        key: "where",
        value: "{lat: 35.5, lng: 135.7}",
        list: undefined,
        readOnly: "dohc can't edit a value with named fields. Change it in another app, or ask an agent.",
      },
    ]);
  });

  it("reads a list's text as its items, trimmed, with blank items dropped", () => {
    expect(listItems("kyoto, food")).toEqual(["kyoto", "food"]);
    expect(listItems("kyoto,food, ")).toEqual(["kyoto", "food"]);
    expect(listItems("  kyoto  ,, food ,")).toEqual(["kyoto", "food"]);
    expect(listItems(" , ,")).toEqual([]);
    expect(listItems("")).toEqual([]);
  });

  it("shows exact integers and hostile keys as the YAML the file holds", () => {
    const doc = receivedYDoc(EDGE_MARKDOWN);
    try {
      const fromFile = frontmatterEntries(EDGE_MARKDOWN);
      const fromDocument = frontmatterEntriesFromPairs(Object.entries(frontmatterMapValues(doc.getMap("frontmatter"))));
      for (const entries of [fromFile, fromDocument]) {
        expect(Object.fromEntries(entries.map((entry) => [entry.key, entry.value]))).toEqual(EDGE_DISPLAY);
      }
    } finally {
      doc.destroy();
    }
    expect(displayFrontmatterValue([9007199254740993n])).toBe("- 9007199254740993");
  });

  it("writes back only the edited key beside hostile keys and exact integers", () => {
    const { meta } = parseFrontmatter(EDGE_MARKDOWN);

    expect(applyFrontmatter(EDGE_MARKDOWN, { ...meta, status: "ready" })).toBe(
      EDGE_MARKDOWN.replace("status: draft", "status: ready"),
    );
  });

  it("orders system keys before user properties", () => {
    expect(
      Object.keys(
        orderFrontmatter({
          zeta: 1,
          icon: "dot",
          title: "T",
          alpha: 2,
          id: "id-1",
        }),
      ),
    ).toEqual(["id", "title", "icon", "alpha", "zeta"]);
  });
});
