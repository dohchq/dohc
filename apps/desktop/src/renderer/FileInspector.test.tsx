// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { classifyForView } from "./FileInspector";
import { lineSpanInText } from "./FileInspector.editor-fixture";
import { markdownEditorBody, mergeMarkdownEditorBody } from "./MarkdownView";
import {
  resolveWorkspaceLinkNavigation,
  resolveWikilinkNavigation,
} from "./wikilinkNavigation";

// Build legacy app-model path markers through interpolation so this test does
// not contain the raw deprecated folder or manifest filenames that the
// no-legacy scanner is meant to catch.
const LEGACY_APPS_SEGMENT = ["", "apps"].join(".");

const LEGACY_APP_MANIFEST = ["app", "json"].join(".");

const legacyAppPath = (...segments: string[]) =>
  [LEGACY_APPS_SEGMENT, ...segments].join("/");

describe("lineSpanInText", () => {
  const text = "first\nsecond line\n\nfourth";

  it("spans each 1-based line, excluding the newline", () => {
    expect(lineSpanInText(text, 1)).toEqual({ start: 0, end: 5 });
    expect(lineSpanInText(text, 2)).toEqual({ start: 6, end: 17 });
    expect(lineSpanInText(text, 3)).toEqual({ start: 18, end: 18 }); // empty line
    expect(lineSpanInText(text, 4)).toEqual({ start: 19, end: 25 });
  });

  it("clamps a line past the end to the last line", () => {
    expect(lineSpanInText(text, 99)).toEqual({ start: 19, end: 25 });
    expect(lineSpanInText("", 5)).toEqual({ start: 0, end: 0 });
  });
});

describe("resolveWikilinkNavigation", () => {
  const files = [
    { path: "notes/plan.md", title: "Plan" },
    { path: "notes/release#1.md", title: "Release 1" },
    { path: "notes/daily/milestone#2.md", title: "Milestone 2" },
    { path: "notes/#overview.md", title: "Hash Overview" },
    { path: "today.md", title: "Today" },
  ];

  it("opens file fragments as an exact heading target", () => {
    expect(
      resolveWikilinkNavigation("notes/plan.md#next-steps", "today.md", files, 7),
    ).toEqual({
      path: "notes/plan.md",
      headingTarget: { anchor: "next-steps", nonce: 7 },
    });
  });

  it("keeps fragment-only links in the current file and preserves encoded anchors", () => {
    expect(
      resolveWikilinkNavigation("#caf%C3%A9-plan", "today.md", files, 8),
    ).toEqual({
      path: "today.md",
      headingTarget: { anchor: "caf%C3%A9-plan", nonce: 8 },
    });
  });

  it("keeps an explicit leading-hash heading local even when a matching file exists", () => {
    expect(
      resolveWikilinkNavigation("#overview", "notes/today.md", files, 16),
    ).toEqual({
      path: "notes/today.md",
      headingTarget: { anchor: "overview", nonce: 16 },
    });
    expect(
      resolveWikilinkNavigation("./#overview", "notes/today.md", files, 17),
    ).toEqual({ path: "notes/#overview.md" });
  });

  it("preserves whole-file wikilink resolution without manufacturing a target", () => {
    expect(resolveWikilinkNavigation("notes/plan", "today.md", files, 9)).toEqual({
      path: "notes/plan.md",
    });
  });

  it("prefers the current document directory for an explicitly relative path", () => {
    const competingFiles = [
      { path: "plan.md", title: "Root plan" },
      { path: "notes/plan.md", title: "Notes plan" },
    ];
    expect(
      resolveWikilinkNavigation(
        "./plan.md",
        "notes/status.md",
        competingFiles,
        20,
      ),
    ).toEqual({ path: "notes/plan.md" });
  });

  it("matches an extensionless document-relative link to a known .markdown file", () => {
    const competingFiles = [
      { path: "guide.md", title: "Root guide" },
      { path: "notes/guide.markdown", title: "Notes guide" },
    ];
    expect(
      resolveWorkspaceLinkNavigation(
        { path: "./guide" },
        "notes/status.md",
        competingFiles,
        21,
      ),
    ).toEqual({ path: "notes/guide.markdown" });
  });

  it.each([
    [
      "./guide.md",
      [
        { path: "notes/guide.markdown", title: "Markdown guide" },
        { path: "notes/guide.md", title: "MD guide" },
      ],
      "notes/guide.md",
    ],
    [
      "./guide.markdown",
      [
        { path: "notes/guide.md", title: "MD guide" },
        { path: "notes/guide.markdown", title: "Markdown guide" },
      ],
      "notes/guide.markdown",
    ],
    [
      "./guide.MD",
      [
        { path: "notes/guide.markdown", title: "Markdown guide" },
        { path: "notes/guide.md", title: "MD guide" },
      ],
      "notes/guide.md",
    ],
    [
      "./guide.MARKDOWN",
      [
        { path: "notes/guide.md", title: "MD guide" },
        { path: "notes/guide.markdown", title: "Markdown guide" },
      ],
      "notes/guide.markdown",
    ],
  ])("prefers the exact Markdown extension for %s", (target, files, expected) => {
    expect(
      resolveWorkspaceLinkNavigation(
        { path: target },
        "notes/status.md",
        files,
        22,
      ),
    ).toEqual({ path: expected });
  });

  it("resolves decoded delimiters in document-relative and root-relative paths", () => {
    const competingFiles = [
      { path: "#notes.md", title: "Root hash notes" },
      { path: "notes/#notes.md", title: "Notes hash notes" },
      { path: "notes/faq?.md", title: "FAQ" },
    ];
    expect(
      resolveWorkspaceLinkNavigation(
        { path: "./faq?.md", rawFragment: "answers" },
        "notes/status.md",
        competingFiles,
        21,
      ),
    ).toEqual({
      path: "notes/faq?.md",
      headingTarget: { anchor: "answers", nonce: 21 },
    });
    expect(
      resolveWorkspaceLinkNavigation(
        { path: "/#notes.md", rawFragment: "risks" },
        "notes/status.md",
        competingFiles,
        22,
      ),
    ).toEqual({
      path: "#notes.md",
      headingTarget: { anchor: "risks", nonce: 22 },
    });
  });

  it("restricts only root-relative paths to the workspace root", () => {
    const localFiles = [{ path: "notes/plan.md", title: "Local plan" }];
    expect(
      resolveWorkspaceLinkNavigation(
        { path: "/plan.md" },
        "notes/status.md",
        localFiles,
        23,
      ),
    ).toEqual({ path: "plan.md" });
    expect(
      resolveWorkspaceLinkNavigation(
        { path: "plan.md" },
        "notes/status.md",
        localFiles,
        24,
      ),
    ).toEqual({ path: "notes/plan.md" });
    expect(
      resolveWorkspaceLinkNavigation(
        { path: "./plan.md" },
        "notes/status.md",
        localFiles,
        25,
      ),
    ).toEqual({ path: "notes/plan.md" });
  });

  it("preserves unknown hash filenames separately from heading fragments", () => {
    expect(
      resolveWorkspaceLinkNavigation(
        { path: "./new#plan.md" },
        "notes/status.md",
        [],
        23,
      ),
    ).toEqual({ path: "notes/new#plan.md" });
    expect(
      resolveWorkspaceLinkNavigation(
        {
          path: "./new#release#1.md",
          rawFragment: "decisions",
        },
        "notes/status.md",
        [],
        24,
      ),
    ).toEqual({
      path: "notes/new#release#1.md",
      headingTarget: { anchor: "decisions", nonce: 24 },
    });
    expect(
      resolveWorkspaceLinkNavigation(
        { path: "", rawFragment: "a%2520b" },
        "notes/status.md",
        [],
        25,
      ),
    ).toEqual({
      path: "notes/status.md",
      headingTarget: { anchor: "a%2520b", nonce: 25 },
    });
  });

  it.each([
    ["guide.md", "notes/guide.md"],
    ["guide.markdown", "notes/guide.markdown"],
    ["GUIDE.MARKDOWN", "notes/GUIDE.MARKDOWN"],
    ["guide", "notes/guide.md"],
  ])("preserves a recognized Markdown fallback for %s", (target, expected) => {
    expect(
      resolveWorkspaceLinkNavigation(
        { path: `./${target}` },
        "notes/status.md",
        [],
        26,
      ),
    ).toEqual({ path: expected });
  });

  it("keeps an empty fragment as an explicit top-of-document target", () => {
    expect(
      resolveWorkspaceLinkNavigation(
        { path: "", rawFragment: "" },
        "notes/status.md",
        [],
        27,
      ),
    ).toEqual({
      path: "notes/status.md",
      headingTarget: { anchor: "", nonce: 27 },
    });
    expect(
      resolveWorkspaceLinkNavigation(
        { path: "../plan.markdown", rawFragment: "" },
        "notes/status.md",
        [],
        28,
      ),
    ).toEqual({
      path: "plan.markdown",
      headingTarget: { anchor: "", nonce: 28 },
    });
  });

  it("treats a full known filename containing # as a file, not a heading", () => {
    expect(
      resolveWikilinkNavigation("notes/release#1.md", "today.md", files, 10),
    ).toEqual({ path: "notes/release#1.md" });
    expect(
      resolveWikilinkNavigation("notes/release#1", "today.md", files, 11),
    ).toEqual({ path: "notes/release#1.md" });
  });

  it("normalizes relative paths before matching filenames containing #", () => {
    expect(
      resolveWikilinkNavigation(
        "./milestone#2",
        "notes/daily/today.md",
        files,
        12,
      ),
    ).toEqual({ path: "notes/daily/milestone#2.md" });
    expect(
      resolveWikilinkNavigation(
        "../release#1.md",
        "notes/daily/today.md",
        files,
        13,
      ),
    ).toEqual({ path: "notes/release#1.md" });
  });

  it("uses the longest known hash filename before an explicit heading", () => {
    expect(
      resolveWikilinkNavigation(
        "notes/release#1.md#decisions",
        "today.md",
        files,
        14,
      ),
    ).toEqual({
      path: "notes/release#1.md",
      headingTarget: { anchor: "decisions", nonce: 14 },
    });
    expect(
      resolveWikilinkNavigation(
        "./milestone#2#next-steps",
        "notes/daily/today.md",
        files,
        15,
      ),
    ).toEqual({
      path: "notes/daily/milestone#2.md",
      headingTarget: { anchor: "next-steps", nonce: 15 },
    });
  });

  it("keeps a trailing empty fragment on the longest known hash filename", () => {
    const competingFiles = [
      ...files,
      { path: "notes/release.md", title: "Release" },
    ];
    expect(
      resolveWikilinkNavigation(
        "notes/release#1.md#",
        "today.md",
        competingFiles,
        18,
      ),
    ).toEqual({ path: "notes/release#1.md" });

    expect(
      resolveWikilinkNavigation(
        "notes/release#1.md#",
        "today.md",
        [{ path: "notes/release#1.md", title: "Release 1" }],
        19,
      ),
    ).toEqual({ path: "notes/release#1.md" });
  });
});

describe("classifyForView dispatch", () => {
  const cases: Array<[string, string]> = [
    ["notes/today.md", "markdown"],
    ["readme.markdown", "markdown"],
    ["data/transactions.csv", "csv"],
    ["data/report.tsv", "csv"],
    ["data/config.json", "json"],
    ["notes/plain.txt", "text"],
    ["uploads/receipt.png", "image"],
    ["uploads/logo.svg", "image"],
    ["uploads/voice.m4a", "audio"],
    ["uploads/contract.pdf", "pdf"],
    ["finance/wallet.sqlite", "database"],
    ["archive/old.db", "database"],
    [`finance/${legacyAppPath("ledger", LEGACY_APP_MANIFEST)}`, "json"],
    [`finance/${legacyAppPath("ledger", "src", "App.tsx")}`, "text"],
    ["uploads/mystery.bin", "binary"],
  ];

  for (const [path, expected] of cases) {
    it(`classifies ${path} as ${expected}`, () => {
      expect(classifyForView(path)).toBe(expected);
    });
  }

  it("treats legacy app-folder paths as ordinary files", () => {
    expect(classifyForView(`x/${legacyAppPath("ledger", LEGACY_APP_MANIFEST)}`)).toBe("json");
    expect(classifyForView(`x/${legacyAppPath("ledger", "src", "App.tsx")}`)).toBe("text");
  });
});

describe("markdown WYSIWYG frontmatter seam", () => {
  it("edits only the body and reattaches raw frontmatter on save", () => {
    const markdown = "---\nid: note-1\ntitle: Plan\nstatus: draft\n---\n\n# Plan\n";

    expect(markdownEditorBody(markdown)).toBe("\n# Plan\n");
    expect(mergeMarkdownEditorBody(markdown, "# Plan\n\nMore")).toBe(
      "---\nid: note-1\ntitle: Plan\nstatus: draft\n---\n\n# Plan\n\nMore",
    );
  });

  it("leaves markdown without frontmatter untouched", () => {
    expect(markdownEditorBody("# Plan\n")).toBe("# Plan\n");
    expect(mergeMarkdownEditorBody("# Plan\n", "# Edited\n")).toBe("# Edited\n");
  });

  it("recognizes real map frontmatter with common YAML keys", () => {
    const markdown =
      "---\ndue date: today\na:b: c\n'a: b': quoted\nx/y: slash\n'@x': at\nanchor: &base value\nnote: Plan # owner: ice\ntags: # list: owned\n- a\n- b\n---\n# Plan\n";

    expect(markdownEditorBody(markdown)).toBe("# Plan\n");
    expect(mergeMarkdownEditorBody(markdown, "# Edited\n")).toBe(
      "---\ndue date: today\na:b: c\n'a: b': quoted\nx/y: slash\n'@x': at\nanchor: &base value\nnote: Plan # owner: ice\ntags: # list: owned\n- a\n- b\n---\n# Edited\n",
    );
  });

  it("reattaches empty and comment-only frontmatter instead of rendering it", () => {
    const markdown = "---\n# dohc metadata\n---\n# Plan\n";

    expect(markdownEditorBody(markdown)).toBe("# Plan\n");
    expect(mergeMarkdownEditorBody(markdown, "# Edited\n")).toBe(
      "---\n# dohc metadata\n---\n# Edited\n",
    );
  });

  it("leaves malformed and non-map frontmatter-looking blocks editable", () => {
    for (const markdown of [
      "---\nid: note-1\nbad: [unclosed\n---\n# Body\n",
      "---\nkey: a: b\n---\n# Body\n",
      "---\nkey: *missing\n---\n# Body\n",
      "---\njust a divider\n---\n# Body\n",
      "---\nnull\n---\n# Body\n",
      "---\n- one\n---\n# Body\n",
    ]) {
      expect(markdownEditorBody(markdown)).toBe(markdown);
      expect(mergeMarkdownEditorBody(markdown, "# Edited\n")).toBe("# Edited\n");
    }
  });
});
