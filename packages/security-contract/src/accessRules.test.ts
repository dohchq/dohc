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
  lowerRule,
  parseAccessRule,
  ruleOnlyNarrows,
} from "./accessRules";

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
  unverifiedEmail: string | null = null,
): ReachViewer => ({ role: "member", level, verifiedEmail, unverifiedEmail });

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

  it("reads back what it formats", () => {
    const parsed = rule("people:\n  sam@example.com: edit\nmembers: comment\n");
    expect(parseAccessRule(formatAccessRule(parsed))).toEqual(parsed);
    expect(formatAccessRule(rule(""))).toBe("");
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

  it("lets an unverified email narrow but never widen", () => {
    expect(folderLevel(set, member("comment", null, "sam@example.com"), "Drafts")).toBe("view");
    expect(folderLevel(set, member("view", null, "sam@example.com"), "Reader")).toBe("view");
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

describe("lowerRule and ruleOnlyNarrows", () => {
  const admin = rule("members: edit\npeople:\n  sam@example.com: view\n");
  const owner = rule("members: view\npeople:\n  ana@example.com: edit\n");

  it("gives everyone the lower of the two", () => {
    const merged = lowerRule(admin, owner);
    const viewer = (email: string) => member("comment", email);
    const set = (r: AccessRule) => accessRuleSet([["", r]]);
    for (const email of ["sam@example.com", "ana@example.com", "bea@example.com"]) {
      const a = folderLevel(set(admin), viewer(email), "");
      const b = folderLevel(set(owner), viewer(email), "");
      const m = folderLevel(set(merged), viewer(email), "");
      expect(m).toBe(a === "view" || b === "view" ? "view" : a);
    }
  });

  it("leaves out anyone either rule leaves out", () => {
    const merged = lowerRule(rule("members: view\n"), rule("people:\n  sam@example.com: edit\n"));
    expect(merged.members).toBeNull();
    expect([...merged.people]).toEqual([["sam@example.com", "view"]]);
  });

  it("tells a narrowing change from a widening one", () => {
    expect(ruleOnlyNarrows(rule("members: edit\n"), rule("members: view\n"))).toBe(true);
    expect(ruleOnlyNarrows(rule("members: view\n"), rule("members: edit\n"))).toBe(false);
    expect(ruleOnlyNarrows(rule(""), rule("people:\n  sam@example.com: view\n"))).toBe(false);
    expect(ruleOnlyNarrows(rule("people:\n  sam@example.com: view\n"), rule(""))).toBe(true);
    // A half-written rule that drops Sam's lower entry raises Sam.
    expect(
      ruleOnlyNarrows(
        rule("members: edit\npeople:\n  sam@example.com: view\n"),
        rule("members: edit\n"),
      ),
    ).toBe(false);
  });
});
