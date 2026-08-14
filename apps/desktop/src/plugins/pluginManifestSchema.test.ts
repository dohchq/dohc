import { describe, expect, it } from "vitest";
import { DohcPluginManifest } from "./pluginManifestSchema";

const minimalManifest = {
  version: 1,
  name: "@dohc/example-plugin",
  entry: "dist/index.js",
} as const;

describe("DohcPluginManifest", () => {
  it("parses a valid minimal manifest", () => {
    expect(DohcPluginManifest.parse(minimalManifest)).toEqual(minimalManifest);
  });

  it("parses panels and commands and normalizes their paths", () => {
    expect(DohcPluginManifest.parse({
      ...minimalManifest,
      entry: "dist\\index.js",
      panels: [
        { id: "main", title: "Main", entry: "panel/./index.html" },
        { id: "tools", title: "Tools", entry: "panel\\tools\\index.html" },
      ],
      commands: [{ id: "open", title: "Open plugin" }],
    })).toEqual({
      ...minimalManifest,
      panels: [
        { id: "main", title: "Main", entry: "panel/index.html" },
        { id: "tools", title: "Tools", entry: "panel/tools/index.html" },
      ],
      commands: [{ id: "open", title: "Open plugin" }],
    });
  });

  it.each([
    ["missing", { name: "example", entry: "index.js" }],
    ["future", { ...minimalManifest, version: 2 }],
    ["string", { ...minimalManifest, version: "1" }],
  ])("rejects a %s version", (_case, manifest) => {
    expect(DohcPluginManifest.safeParse(manifest).success).toBe(false);
  });

  it.each([
    ["POSIX absolute path", "/index.js"],
    ["Windows drive path", "C:\\index.js"],
    ["parent segment", "dist/../index.js"],
    ["empty path", ""],
  ])("rejects an entry with a %s", (_case, entry) => {
    expect(DohcPluginManifest.safeParse({ ...minimalManifest, entry }).success).toBe(false);
  });

  it("rejects an entry over 1024 characters", () => {
    const result = DohcPluginManifest.safeParse({
      ...minimalManifest,
      entry: "a".repeat(1025),
    });

    if (result.success) throw new Error("expected the entry limit to reject the manifest");
    expect(result.error.issues).toContainEqual(expect.objectContaining({
      message: "must be 1024 characters or fewer",
    }));
  });

  it("rejects unknown top-level fields", () => {
    expect(DohcPluginManifest.safeParse({
      ...minimalManifest,
      unsupported: true,
    }).success).toBe(false);
  });

  it.each([
    ["panel", {
      panels: [{ id: "main", title: "Main", entry: "panel.html", unsupported: true }],
    }],
    ["command", {
      commands: [{ id: "open", title: "Open", unsupported: true }],
    }],
  ])("rejects unknown fields in a %s", (_case, fields) => {
    expect(DohcPluginManifest.safeParse({ ...minimalManifest, ...fields }).success).toBe(false);
  });

  it.each([
    ["uppercase", "Example"],
    ["spaces", "example plugin"],
  ])("rejects a name with %s", (_case, name) => {
    expect(DohcPluginManifest.safeParse({ ...minimalManifest, name }).success).toBe(false);
  });

  it("accepts a 214-character name and reports the limit for 215 characters", () => {
    expect(DohcPluginManifest.safeParse({
      ...minimalManifest,
      name: "a".repeat(214),
    }).success).toBe(true);

    const result = DohcPluginManifest.safeParse({
      ...minimalManifest,
      name: "a".repeat(215),
    });
    if (result.success) throw new Error("expected the name limit to reject the manifest");
    expect(result.error.issues.map((issue) => issue.message).join("; ")).toContain("214");
  });

  it("rejects duplicate panel ids", () => {
    expect(DohcPluginManifest.safeParse({
      ...minimalManifest,
      panels: [
        { id: "main", title: "Main", entry: "main.html" },
        { id: "main", title: "Other", entry: "other.html" },
      ],
    }).success).toBe(false);
  });

  it("rejects a panel id containing the authority-key delimiter", () => {
    expect(DohcPluginManifest.safeParse({
      ...minimalManifest,
      panels: [
        { id: "main\0alias", title: "Main", entry: "main.html" },
      ],
    }).success).toBe(false);
  });

  it("rejects more than 100 panels", () => {
    const result = DohcPluginManifest.safeParse({
      ...minimalManifest,
      panels: Array.from({ length: 101 }, (_, index) => ({
        id: `p${index}`,
        title: `P${index}`,
        entry: `p${index}.html`,
      })),
    });

    if (result.success) throw new Error("expected the panel limit to reject the manifest");
    expect(result.error.issues).toContainEqual(expect.objectContaining({
      message: "panels: at most 100 entries allowed",
    }));
  });

  it("rejects duplicate command ids", () => {
    expect(DohcPluginManifest.safeParse({
      ...minimalManifest,
      commands: [
        { id: "open", title: "Open" },
        { id: "open", title: "Open another" },
      ],
    }).success).toBe(false);
  });

  it("accepts a web app contribution and parses it", () => {
    const result = DohcPluginManifest.safeParse({
      ...minimalManifest,
      webApps: [{ id: "app", title: "T3 Code" }],
    });
    if (!result.success) throw new Error(result.error.message);
    expect(result.data.webApps).toEqual([{ id: "app", title: "T3 Code" }]);
  });

  it("rejects duplicate web app ids", () => {
    const result = DohcPluginManifest.safeParse({
      ...minimalManifest,
      webApps: [
        { id: "app", title: "One" },
        { id: "app", title: "Two" },
      ],
    });
    if (result.success) throw new Error("expected duplicate web app ids to reject");
    expect(result.error.issues).toContainEqual(expect.objectContaining({
      message: 'web app id "app" must be unique within webApps',
    }));
  });

  it("rejects more than 100 web apps", () => {
    const result = DohcPluginManifest.safeParse({
      ...minimalManifest,
      webApps: Array.from({ length: 101 }, (_, index) => ({
        id: `a${index}`,
        title: `A${index}`,
      })),
    });
    if (result.success) throw new Error("expected the web app limit to reject the manifest");
    expect(result.error.issues).toContainEqual(expect.objectContaining({
      message: "webApps: at most 100 entries allowed",
    }));
  });

  it("rejects a web app with unknown keys or an entry path", () => {
    expect(DohcPluginManifest.safeParse({
      ...minimalManifest,
      webApps: [{ id: "app", title: "T3 Code", entry: "index.html" }],
    }).success).toBe(false);
  });

  it("rejects more than 200 commands", () => {
    const result = DohcPluginManifest.safeParse({
      ...minimalManifest,
      commands: Array.from({ length: 201 }, (_, index) => ({
        id: `c${index}`,
        title: `C${index}`,
      })),
    });

    if (result.success) throw new Error("expected the command limit to reject the manifest");
    expect(result.error.issues).toContainEqual(expect.objectContaining({
      message: "commands: at most 200 entries allowed",
    }));
  });
});
