import { describe, expect, it } from "vitest";
import {
  applyFrontmatter,
  displayFrontmatterValue,
  frontmatterEntries,
  orderFrontmatter,
  parseFrontmatter,
} from "./frontmatter";

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
      ["---", "status: active", "---", "---", "just a divider", "---", "# Body"].join(
        "\n",
      ),
    );
  });

  it("treats empty and comment-only frontmatter as an empty map", () => {
    const markdown = ["---", "# dohc metadata", "", "---", "# Body"].join("\n");

    expect(parseFrontmatter(markdown)).toEqual({ meta: {}, body: "# Body" });
    expect(applyFrontmatter(markdown, { status: "active" })).toBe(
      ["---", "status: active", "---", "# Body"].join("\n"),
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

  it("keeps a structured value separate from its editable display text", () => {
    const entries = frontmatterEntries(
      "---\ntags:\n  - a\n  - b\n---\n\n# Plan\n",
    );

    expect(entries[0]).toMatchObject({
      key: "tags",
      value: "- a\n- b",
      rawValue: ["a", "b"],
    });
    expect(displayFrontmatterValue({ pinned: true })).toBe("pinned: true");
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
