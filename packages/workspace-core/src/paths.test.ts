import { describe, expect, it } from "vitest";
import {
  classifyPath,
  mediaTypeForPath,
  defaultWorkspaceRoot,
  isReservedPath,
  validateAttachedFolder,
  validateWorkspaceRootChoice,
  validateUserWritePath,
  hasIgnoredSegment,
  isSiteSourcePath,
} from "./paths";

describe("workspace roots", () => {
  it("suggests ~/dohc as the default root", () => {
    expect(defaultWorkspaceRoot("/home/ice")).toBe("/home/ice/dohc");
  });

  it("allows attaching arbitrary absolute folders", () => {
    expect(validateAttachedFolder("/home/ice/projects/notes").ok).toBe(true);
    expect(validateAttachedFolder("/mnt/data/research").ok).toBe(true);
  });

  it("allows Windows absolute folders (drive and UNC)", () => {
    expect(validateAttachedFolder("C:\\Users\\ice\\dohc").ok).toBe(true);
    expect(validateAttachedFolder("C:/Users/ice/dohc").ok).toBe(true);
    expect(validateAttachedFolder("\\\\server\\share\\dohc").ok).toBe(true);
  });

  it("rejects relative paths as attached folders", () => {
    expect(validateAttachedFolder("projects/notes").ok).toBe(false);
  });
});

describe("reserved paths", () => {
  it("reserves .dohc/manifest.json and the .dohc subtree", () => {
    expect(isReservedPath(".dohc/manifest.json")).toBe(true);
    expect(isReservedPath(".dohc/history/0001.json")).toBe(true);
    expect(isReservedPath("notes/today.md")).toBe(false);
  });

  it("reserves a nested .dohc at ANY depth, not just the first segment", () => {
    expect(isReservedPath("notes/.dohc/x")).toBe(true);
    expect(isReservedPath("a/b/.DOHC/x")).toBe(true);
    const result = validateUserWritePath("notes/.dohc/secret");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("reserved");
  });

  it("reserves case-insensitive .dohc variants (case-insensitive filesystems)", () => {
    expect(isReservedPath(".DOHC/manifest.json")).toBe(true);
    const result = validateUserWritePath(".DoHc/manifest.json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("reserved");
  });

  it("rejects user writes into reserved space", () => {
    const result = validateUserWritePath(".dohc/manifest.json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("reserved");
  });
});

describe("path traversal", () => {
  const traversals = [
    "../escape.md",
    "notes/../../etc/passwd",
    "%2e%2e/sneak.md",
    "..\\windows\\system32",
    "a/%2E%2E/b",
    "%252e%252e/double-encoded.md",
    "..%2fescape.md",
    "..%5cwindows",
  ];

  for (const candidate of traversals) {
    it(`rejects traversal: ${JSON.stringify(candidate)}`, () => {
      const result = validateUserWritePath(candidate);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("traversal");
    });
  }

  it("rejects absolute paths inside a workspace", () => {
    const result = validateUserWritePath("/etc/passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("absolute");
  });

  it("rejects Windows drive-qualified and UNC write paths", () => {
    for (const candidate of [
      "C:\\Users\\ice\\secret.md",
      "C:/Users/ice/secret.md",
      "\\\\server\\share\\secret.md",
    ]) {
      const result = validateUserWritePath(candidate);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("absolute");
    }
  });

  it("rejects encoded-slash absolute paths", () => {
    const result = validateUserWritePath("%2fetc/passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("absolute");
  });

  it("rejects null bytes", () => {
    const result = validateUserWritePath("notes/a\0b.md");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid");
  });

  it("accepts and normalizes ordinary nested paths", () => {
    const result = validateUserWritePath("finance/./reports/q1.md");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.normalized).toBe("finance/reports/q1.md");
  });
});

describe("workspace root choice", () => {
  it("accepts ordinary folders, including outside the default root", () => {
    expect(
      validateWorkspaceRootChoice("/home/ice/dohc/personal", "/home/ice").ok,
    ).toBe(true);
    expect(
      validateWorkspaceRootChoice("/mnt/data/research", "/home/ice").ok,
    ).toBe(true);
  });

  it("rejects the filesystem root and the home directory itself", () => {
    for (const dangerous of ["/", "/home/ice", "/home/ice/", "C:\\", "C:/"]) {
      const result = validateWorkspaceRootChoice(dangerous, "/home/ice");
      expect(result.ok).toBe(false);
    }
  });

  it("rejects dot-segment disguises of root and home", () => {
    for (const disguised of [
      "/.",
      "/..",
      "/home/ice/.",
      "/home/ice/x/..",
      "/home/./ice",
    ]) {
      const result = validateWorkspaceRootChoice(disguised, "/home/ice");
      expect(result.ok).toBe(false);
    }
  });

  it("rejects leading-double-slash and UNC disguises of root and home", () => {
    expect(validateWorkspaceRootChoice("//home/ice", "/home/ice").ok).toBe(false);
    expect(validateWorkspaceRootChoice("///", "/home/ice").ok).toBe(false);
    expect(validateWorkspaceRootChoice("//server", "/home/ice").ok).toBe(false);
    expect(validateWorkspaceRootChoice("//server/share", "/home/ice").ok).toBe(false);
  });

  it("rejects case variants of the home directory (case-insensitive filesystems)", () => {
    expect(validateWorkspaceRootChoice("/Home/Ice", "/home/ice").ok).toBe(false);
  });

  it("returns the normalized root so equality checks are canonical", () => {
    const result = validateWorkspaceRootChoice(
      "/home/ice/dohc//personal/.",
      "/home/ice",
    );
    expect(result).toEqual({ ok: true, normalized: "/home/ice/dohc/personal" });
  });

  it("rejects relative paths", () => {
    expect(validateWorkspaceRootChoice("notes", "/home/ice").ok).toBe(false);
  });
});

describe("path classification", () => {
  it("does not give sites paths any special core classification", () => {
    expect(classifyPath("finance/sites/ledger/index.html")).toEqual({ kind: "file" });
    expect(classifyPath("sites/tracker/src/App.tsx")).toEqual({ kind: "file" });
  });

  it("treats .sqlite, .sqlite3, and .db files as visible databases", () => {
    expect(classifyPath("finance/wallet.sqlite")).toEqual({ kind: "database" });
    expect(classifyPath("data/cache.sqlite3")).toEqual({ kind: "database" });
    expect(classifyPath("archive/old.db")).toEqual({ kind: "database" });
  });

  it("classifies everything else as a plain file", () => {
    expect(classifyPath("notes/today.md")).toEqual({ kind: "file" });
  });
});

describe("Windows trailing dot/space aliasing", () => {
  it("rejects .dohc disguised with trailing dots or spaces", () => {
    expect(validateUserWritePath(".dohc./x.md")).toEqual({ ok: false, reason: "reserved" });
    expect(validateUserWritePath(".dohc /x.md")).toEqual({ ok: false, reason: "reserved" });
    expect(validateUserWritePath(".DOHC./x.md")).toEqual({ ok: false, reason: "reserved" });
  });

  it("rejects traversal disguised with trailing dots or spaces", () => {
    expect(validateUserWritePath(".. /secret.md")).toEqual({ ok: false, reason: "traversal" });
    expect(validateUserWritePath("a/.. ./b.md").ok).toBe(false);
  });

  it("rejects segments that are only dots/spaces", () => {
    expect(validateUserWritePath("a/   /b.md")).toEqual({ ok: false, reason: "invalid" });
    expect(validateUserWritePath("a/..../b.md").ok).toBe(false);
  });

  it("still accepts ordinary names with inner dots", () => {
    expect(validateUserWritePath("notes/v1.2.draft.md").ok).toBe(true);
  });
});

describe("hasIgnoredSegment (shared tree/watcher ignore rule)", () => {
  it("ignores .dohc, .git, and node_modules at any depth", () => {
    expect(hasIgnoredSegment(".dohc/history/index.json")).toBe(true);
    expect(hasIgnoredSegment("sub/.dohc/manifest.json")).toBe(true);
    expect(hasIgnoredSegment(".git/objects/ab")).toBe(true);
    expect(hasIgnoredSegment("pkg/node_modules/x/index.js")).toBe(true);
    expect(hasIgnoredSegment("NODE_MODULES/x")).toBe(true);
  });

  it("does not ignore lookalike names", () => {
    expect(hasIgnoredSegment(".dohcrc")).toBe(false);
    expect(hasIgnoredSegment("notes/git/readme.md")).toBe(false);
    expect(hasIgnoredSegment("my-node_modules-notes.md")).toBe(false);
  });
});

describe("isSiteSourcePath", () => {
  it("treats source files under a sites path segment as site source", () => {
    expect(isSiteSourcePath("sites/workspace/src/App.tsx")).toBe(true);
    expect(isSiteSourcePath("sites/workspace/index.html")).toBe(true);
    expect(isSiteSourcePath("sites/workspace/index.htm")).toBe(true);
    expect(isSiteSourcePath("finance/sites/ledger/styles.css")).toBe(true);
    expect(isSiteSourcePath("finance/sites/ledger/theme.scss")).toBe(true);
    expect(isSiteSourcePath("finance\\sites\\ledger\\config.json")).toBe(true);
  });

  it("does not classify arbitrary source-looking files or lookalike folders", () => {
    expect(isSiteSourcePath("src/App.tsx")).toBe(false);
    expect(isSiteSourcePath("notes/config.json")).toBe(false);
    expect(isSiteSourcePath("notes/my-sites/idea.tsx")).toBe(false);
    expect(isSiteSourcePath("notes/workspace-sites/app.tsx")).toBe(false);
    expect(isSiteSourcePath("notes/sites-backup/index.html")).toBe(false);
  });

  it("matches the sites path segment case-insensitively", () => {
    expect(isSiteSourcePath("finance/Sites/ledger/theme.scss")).toBe(true);
  });
});

describe("mediaTypeForPath (shared extension -> media-type table)", () => {
  it("maps the known workspace file extensions case-insensitively", () => {
    expect(mediaTypeForPath("notes/plan.md")).toBe("text/markdown");
    expect(mediaTypeForPath("finance/Ledger.CSV")).toBe("text/csv");
    expect(mediaTypeForPath("data/rows.jsonl")).toBe("application/x-ndjson");
    expect(mediaTypeForPath("img/logo.PNG")).toBe("image/png");
    expect(mediaTypeForPath("audio/memo.m4a")).toBe("audio/mp4");
    expect(mediaTypeForPath("docs/spec.pdf")).toBe("application/pdf");
    expect(mediaTypeForPath("data/app.sqlite")).toBe("application/vnd.sqlite3");
    expect(mediaTypeForPath("data/app.db")).toBe("application/vnd.sqlite3");
  });

  it("returns null for unknown or missing extensions (fallback is the caller's)", () => {
    expect(mediaTypeForPath("bin/blob.xyz")).toBeNull();
    expect(mediaTypeForPath("Makefile")).toBeNull();
  });
});
