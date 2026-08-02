import { describe, expect, it } from "vitest";
import {
  parseFilesPolicy,
  parseVisibilityPolicy,
  policyGlobMatches,
  resolveEffectivePolicy,
  validatePolicyGlob,
  type FilesPolicyRule,
  type PolicyParseResult,
  type VisibilityPolicyRule,
} from "./effectivePolicy";
import { classifyEngineFilePath } from "./enginePathFloor";

function expectReject(result: PolicyParseResult<unknown>, pattern?: RegExp): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.errors.length).toBeGreaterThan(0);
    if (pattern) expect(result.errors.join("\n")).toMatch(pattern);
  }
}

describe("workspace engine effective policy parsing", () => {
  it("accepts well-formed files and visibility policy files", () => {
    expect(
      parseFilesPolicy(`
        [[rule]]
        path = "drafts/**"
        tracked = false
        searchable = false

        [[rule]]
        path = "docs/*.md"
        searchable = true
      `),
    ).toEqual({
      ok: true,
      rules: [
        { path: "drafts/**", tracked: false, searchable: false },
        { path: "docs/*.md", searchable: true },
      ],
    });

    expect(
      parseVisibilityPolicy(`
        [[rule]]
        path = "private/**"
        visibility = "hidden"
        export = "redacted"
      `),
    ).toEqual({
      ok: true,
      rules: [{ path: "private/**", visibility: "hidden", export: "redacted" }],
    });
  });

  it("rejects malformed files policy shapes without partial application", () => {
    const cases: Array<[string, RegExp]> = [
      ["[[rule]\npath = \"x.md\"\n", /invalid TOML/],
      ["version = true\n[[rule]]\npath = \"x.md\"\n", /unknown top-level key/],
      ["rule = \"not-array\"\n", /array/],
      ["[[rule]]\ntracked = false\n", /path is required/],
      ["[[rule]]\npath = \"x.md\"\nmode = true\n", /unknown key/],
      ["[[rule]]\npath = \"x.md\"\ntracked = \"false\"\n", /tracked must be a boolean/],
      ["[[rule]]\npath = \"bad/**/x.md\"\ntracked = false\n", /invalid path glob/],
      [
        "[[rule]]\npath = \"ok.md\"\ntracked = false\n[[rule]]\npath = \"bad[\"\n",
        /invalid path glob/,
      ],
    ];
    for (const [text, pattern] of cases) {
      expectReject(parseFilesPolicy(text), pattern);
    }
  });

  it("rejects malformed visibility policy shapes without partial application", () => {
    const cases: Array<[string, RegExp]> = [
      ["other = true\n[[rule]]\npath = \"x.md\"\n", /unknown top-level key/],
      ["rule = \"not-array\"\n", /array/],
      ["[[rule]]\nexport = \"included\"\n", /path is required/],
      ["[[rule]]\npath = \"x.md\"\ntracked = true\n", /unknown key/],
      ["[[rule]]\npath = \"x.md\"\nvisibility = true\n", /visibility/],
      ["[[rule]]\npath = \"x.md\"\nexport = \"public\"\n", /export/],
      ["[[rule]]\npath = \"../x.md\"\nvisibility = \"hidden\"\n", /invalid path glob/],
      [
        "[[rule]]\npath = \"ok.md\"\nvisibility = \"hidden\"\n[[rule]]\npath = \"bad?\"\n",
        /invalid path glob/,
      ],
    ];
    for (const [text, pattern] of cases) {
      expectReject(parseVisibilityPolicy(text), pattern);
    }
  });
});

describe("workspace engine policy globs", () => {
  it.each([
    ["notes/today.md", "notes/today.md", true],
    ["notes/today.md", "notes/other.md", false],
    ["notes/*.md", "notes/a.md", true],
    ["notes/*.md", "notes/sub/a.md", false],
    ["notes/*.md", "notes/.md", true],
    ["secrets/**", "secrets/x.md", true],
    ["secrets/**", "secrets/sub/y.md", true],
    ["secrets/**", "secrets", false],
    ["**", "anything/deep.md", true],
    ["**", ".dohc/files.toml", true],
    // `*` matches zero or more characters, never fewer than zero: a pattern
    // whose prefix and suffix overlap in the candidate must not match.
    ["draft*draft.md", "draftdraft.md", true],
    ["draft*draft.md", "draft-1-draft.md", true],
    ["draft*draft.md", "draft.md", false],
  ])("matches %s against %s as %s", (pattern, path, shouldMatch) => {
    expect(validatePolicyGlob(pattern)).toEqual({ ok: true });
    expect(policyGlobMatches(pattern, path)).toBe(shouldMatch);
  });

  it.each([
    ["bad[abc]", /classes|braces|\?/],
    ["bad{a,b}", /classes|braces|\?/],
    ["bad?", /classes|braces|\?/],
    ["a/**/b", /final/],
    ["!private/**", /negation/],
    ["/rooted", /leading slash/],
    ["../outside", /\.\./],
    ["dir//file.md", /empty/],
    ["foo**", /complete final segment/],
    ["a*b*c", /one \*/],
  ])("rejects unsupported glob %s", (pattern, reason) => {
    const result = validatePolicyGlob(pattern);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(reason);
  });
});

describe("workspace engine effective policy precedence", () => {
  it("applies floor before policy before defaults", () => {
    const filesPolicy: FilesPolicyRule[] = [
      { path: "**", tracked: true, searchable: true },
      { path: "docs/**", searchable: false },
      { path: "docs/private.md", tracked: false },
    ];
    const visibilityPolicy: VisibilityPolicyRule[] = [
      { path: "**", visibility: "visible", export: "included" },
      { path: "docs/**", visibility: "hidden", export: "redacted" },
    ];

    expect(
      resolveEffectivePolicy({
        path: ".env",
        filesPolicy,
        visibilityPolicy,
      }),
    ).toMatchObject({
      floor: "secret",
      tracked: false,
      searchable: false,
      visibility: "hidden",
      export: "excluded",
    });
    expect(
      resolveEffectivePolicy({
        path: ".dohc/files.toml",
        filesPolicy,
        visibilityPolicy,
      }),
    ).toMatchObject({
      floor: "ignored",
      tracked: false,
      searchable: false,
      visibility: "hidden",
      export: "excluded",
    });
    expect(
      resolveEffectivePolicy({
        path: "docs/guide.md",
        filesPolicy,
        visibilityPolicy,
      }),
    ).toMatchObject({
      floor: "tracked",
      tracked: true,
      searchable: false,
      visibility: "hidden",
      export: "redacted",
    });
    expect(
      resolveEffectivePolicy({
        path: "docs/private.md",
        filesPolicy,
        visibilityPolicy,
      }),
    ).toMatchObject({
      floor: "tracked",
      tracked: false,
      versioned: false,
      captureOwned: false,
      searchable: false,
    });
    expect(resolveEffectivePolicy({ path: "notes/public.md" })).toMatchObject({
      floor: "tracked",
      tracked: true,
      searchable: true,
      visibility: "visible",
      export: "included",
    });
  });

  it("lets later matching rules win per explicitly set field only", () => {
    const result = resolveEffectivePolicy({
      path: "docs/a.md",
      filesPolicy: [
        { path: "docs/**", tracked: false, searchable: false },
        { path: "docs/a.md", tracked: true },
      ],
      visibilityPolicy: [
        { path: "docs/**", visibility: "hidden", export: "redacted" },
        { path: "docs/a.md", export: "included" },
      ],
    });
    expect(result).toMatchObject({
      tracked: true,
      searchable: false,
      visibility: "hidden",
      export: "included",
    });
  });

  it("denies policy escalation across ignored and secret floors", () => {
    const filesPolicy: FilesPolicyRule[] = [
      { path: "config/*", tracked: true, searchable: true },
      { path: ".dohc/**", tracked: true, searchable: true },
    ];
    const visibilityPolicy: VisibilityPolicyRule[] = [
      { path: "config/*", visibility: "visible", export: "included" },
      { path: ".dohc/**", visibility: "visible", export: "included" },
    ];

    expect(
      resolveEffectivePolicy({
        path: "config/app.md",
        filesPolicy: [{ path: "config/*", tracked: false, searchable: false }],
        visibilityPolicy: [{ path: "config/*", visibility: "hidden" }],
      }),
    ).toMatchObject({
      floor: "tracked",
      tracked: false,
      searchable: false,
      visibility: "hidden",
    });

    expect(policyGlobMatches("config/*", "config/.env")).toBe(true);
    expect(classifyEngineFilePath("config/.env")).toEqual({ kind: "secret" });
    expect(
      resolveEffectivePolicy({
        path: "config/.env",
        filesPolicy,
        visibilityPolicy,
      }),
    ).toMatchObject({
      floor: "secret",
      tracked: false,
      searchable: false,
      visibility: "hidden",
      export: "excluded",
    });

    expect(policyGlobMatches(".dohc/**", ".dohc/files.toml")).toBe(true);
    expect(classifyEngineFilePath(".dohc/files.toml")).toEqual({ kind: "ignored" });
    expect(
      resolveEffectivePolicy({
        path: ".dohc/files.toml",
        filesPolicy,
        visibilityPolicy,
      }),
    ).toMatchObject({
      floor: "ignored",
      tracked: false,
      searchable: false,
      visibility: "hidden",
      export: "excluded",
    });
  });

  it.each([
    "notes/today.md",
    ".env",
    "config/.env",
    ".dohc/x",
    "node_modules/x",
    ".git/x",
  ])("keeps no-policy tracked default identical to classifyEngineFilePath for %s", (path) => {
    expect(
      resolveEffectivePolicy({
        path,
        filesPolicy: null,
        visibilityPolicy: null,
      }).tracked,
    ).toBe(classifyEngineFilePath(path).kind === "tracked");
  });
});
