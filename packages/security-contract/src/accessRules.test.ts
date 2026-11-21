import { describe, expect, it } from "vitest";
import {
  type AccessRule,
  type AccessRuleSet,
  type ReachViewer,
  accessRuleSet,
  fileLevel,
  folderLevel,
  formatAccessRule,
  isAccessRulePath,
  isAccessRuleRelatedPath,
  parseAccessRule,
} from "./accessRules";
import vectors from "./accessRules.vectors.json";

type VectorRule = {
  members: AccessRule["members"];
  people: Record<string, NonNullable<AccessRule["members"]>>;
} | null;
const plain = (parsed: AccessRule | null): VectorRule =>
  parsed && {
    members: parsed.members,
    people: Object.fromEntries([...parsed.people].sort(([a], [b]) => (a < b ? -1 : 1))),
  };

// The engine's twin (crates/dohc-engine-files/src/access_rules.rs) reads the same vectors.
describe("shared vectors", () => {
  it.each(vectors.parsed)("parses $name", ({ text, rule: expected }) => {
    expect(plain(parseAccessRule(text))).toEqual(expected);
  });
});

const rule = (text: string): AccessRule => {
  const parsed = parseAccessRule(text);
  if (!parsed) throw new Error(`unreadable: ${text}`);
  return parsed;
};
const rules = (entries: Record<string, string | null>): AccessRuleSet =>
  accessRuleSet(
    Object.entries(entries).map(
      ([folder, text]) => [folder, text === null ? null : rule(text)] as const,
    ),
  );
const member = (
  level: "view" | "comment" | "edit",
  verifiedEmail: string | null = null,
): ReachViewer => ({ role: "member", level, verifiedEmail });

// The engine reads the same cases: its merge order planner where no folder
// names fold together, and its tests' copy of folderLevel everywhere. The
// relay's rule index reads the ruleFiles cases, which start from rule files.
describe("shared reach vectors", () => {
  it.each(vectors.reach)("reaches $name", ({ rules: entries, folder, email, level }) => {
    const set = rules(entries as Record<string, string | null>);
    for (const memberLevel of ["view", "comment", "edit"] as const) {
      expect(folderLevel(set, member(memberLevel, email), folder)).toBe(
        level === "member" ? memberLevel : level,
      );
    }
  });
});

describe("parseAccessRule", () => {
  it("reads members and people, normalizing emails", () => {
    const parsed = rule(
      "# Drafts\nmembers: view   # everyone reads\npeople:\n  Sam@Example.com: edit\n  'ana@example.com': \"comment\"\n",
    );
    expect(parsed.members).toBe("view");
    expect([...parsed.people]).toEqual([
      ["sam@example.com", "edit"],
      ["ana@example.com", "comment"],
    ]);
  });

  it("reads an empty rule as covering nobody", () => {
    expect(rule("")).toEqual({ members: null, people: new Map() });
    expect(rule("# Team only\n\npeople:\n")).toEqual({ members: null, people: new Map() });
  });

  it.each([
    ["an unknown key", "members: view\nadmins: edit\n"],
    ["a level word that isn't exact", "members: View\n"],
    ["a missing level", "members:\n"],
    ["a repeated key", "members: view\nmembers: edit\n"],
    ["a person outside people", "sam@example.com: edit\n"],
    ["a key that isn't an email", "people:\n  sam: edit\n"],
    ["two keys that are one email", "people:\n  sam@example.com: edit\n  SAM@example.com: view\n"],
    ["uneven indentation", "people:\n  sam@example.com: edit\n    ana@example.com: view\n"],
    ["a tab", "people:\n\tsam@example.com: edit\n"],
    ["an anchor", "members: &level view\n"],
    ["an alias", "members: *level\n"],
    ["a tag", "members: !!str view\n"],
    ["a flow mapping", "people: {sam@example.com: edit}\n"],
    ["a document marker", "---\nmembers: view\n"],
    ["an escape in a quoted string", 'people:\n  "sam\\u0040example.com": edit\n'],
    ["a NUL byte", "members: view\0\n"],
    ["a list", "people:\n  - sam@example.com\n"],
  ])("refuses %s", (_name, text) => {
    expect(parseAccessRule(text)).toBeNull();
  });

  it("refuses a rule over the size cap", () => {
    expect(parseAccessRule(`members: view\n#${"x".repeat(64 * 1024)}\n`)).toBeNull();
  });

  it("reads back what it formats, quoting a key that would read as something else", () => {
    const parsed = rule("people:\n  sam@example.com: edit\nmembers: comment\n");
    expect(parseAccessRule(formatAccessRule(parsed)!)).toEqual(parsed);
    expect(formatAccessRule(rule(""))).toBe("");
    // Written plain, the first would be a comment and the rest unreadable.
    const tricky = rule(
      "members: edit\npeople:\n  \"#sam@example.com\": view\n  'a:b@example.com': view\n  '&x@example.com': view\n" +
        '  "o\'neil@example.com": view\n  a\'b"c@example.com: view\n',
    );
    expect(parseAccessRule(formatAccessRule(tricky)!)).toEqual(tricky);
    for (const text of vectors.parsed
      .map(({ text }) => parseAccessRule(text))
      .filter((r): r is AccessRule => r !== null)) {
      expect(parseAccessRule(formatAccessRule(text)!)).toEqual(text);
    }
  });

  it("formats nothing for a rule no text can hold", () => {
    expect(
      formatAccessRule({ members: null, people: new Map([["sam: x@example.com", "view"]]) }),
    ).toBeNull();
    expect(
      formatAccessRule({ members: null, people: new Map([["'\"@example.com", "view"]]) }),
    ).toBeNull();
  });
});

describe("folderLevel and fileLevel", () => {
  // The plan's four examples.
  const set = rules({
    Team: "",
    Drafts: "members: view\npeople:\n  sam@example.com: edit\n",
    Reader: "members: edit\npeople:\n  sam@example.com: view\n",
    "Team/Open": "members: edit\n",
  });

  it("leaves members out of a folder with an empty rule, and everything in it", () => {
    expect(folderLevel(set, member("edit"), "Team")).toBeNull();
    // A rule further down never shows a folder inside one they can't reach.
    expect(folderLevel(set, member("edit"), "Team/Open")).toBeNull();
    expect(fileLevel(set, member("edit"), "Team/plan.md")).toBeNull();
  });

  it("lets a person's own entry win over Members, in both directions", () => {
    expect(folderLevel(set, member("comment", "sam@example.com"), "Drafts")).toBe("edit");
    expect(folderLevel(set, member("comment", "ana@example.com"), "Drafts")).toBe("view");
    expect(folderLevel(set, member("comment", "sam@example.com"), "Reader")).toBe("view");
    expect(folderLevel(set, member("view", "ana@example.com"), "Reader")).toBe("edit");
  });

  it("uses the member level where no rule applies, and inherits a rule below its folder", () => {
    expect(folderLevel(set, member("comment"), "Elsewhere/deep")).toBe("comment");
    expect(fileLevel(set, member("comment", "sam@example.com"), "Drafts/a/b.md")).toBe("edit");
  });

  it("hides a folder whose twin spelling is hidden, but never widens one through it", () => {
    // On a disk that ignores case, "TEAM" is the hidden "Team".
    expect(folderLevel(set, member("edit"), "TEAM")).toBeNull();
    expect(fileLevel(set, member("edit"), "team/plan.md")).toBeNull();
    // An unruled "drafts" beside "Drafts" keeps the level above it.
    expect(folderLevel(set, member("comment", "sam@example.com"), "drafts")).toBe("comment");
    const twins = rules({ "": "members: view\n", Open: "members: edit\n" });
    expect(folderLevel(twins, member("edit"), "open")).toBe("view");
    expect(folderLevel(twins, member("edit"), "Open")).toBe("edit");
  });

  it("hides a folder whose rule couldn't be read", () => {
    expect(folderLevel(rules({ Broken: null }), member("edit"), "Broken/x")).toBeNull();
  });

  it("applies a rule at the root to the whole workspace", () => {
    expect(fileLevel(rules({ "": "members: view\n" }), member("edit"), "a/b.md")).toBe("view");
  });

  it("gives a member with no verified email the Members level, whatever entry names their address", () => {
    expect(folderLevel(set, member("comment"), "Drafts")).toBe("view");
    expect(folderLevel(set, member("view"), "Reader")).toBe("edit");
  });

  it("never limits owners and admins", () => {
    expect(folderLevel(set, { role: "admin" }, "Team")).toBe("edit");
    expect(fileLevel(set, { role: "owner" }, "Team/access.yaml")).toBe("edit");
  });

  it("hides rule files and their copies from members", () => {
    expect(fileLevel(set, member("edit"), "Elsewhere/access.yaml")).toBeNull();
    expect(fileLevel(set, member("edit"), "Elsewhere/Access.YAML")).toBeNull();
    expect(fileLevel(set, member("edit"), "Elsewhere/access.yaml~")).toBeNull();
    expect(fileLevel(set, member("edit"), "Elsewhere/.access.yaml.swp")).toBeNull();
    expect(fileLevel(set, member("edit"), "Elsewhere/notes.md")).toBe("edit");
  });
});

describe("rule file names", () => {
  it("knows a rule however it is spelled, and its copies", () => {
    expect(isAccessRulePath("a/ACCESS.yaml")).toBe(true);
    expect(isAccessRulePath("a/access.yaml~")).toBe(false);
    expect(isAccessRuleRelatedPath("a/#access.yaml#")).toBe(true);
    expect(isAccessRuleRelatedPath("a/access.yml")).toBe(false);
  });
});
