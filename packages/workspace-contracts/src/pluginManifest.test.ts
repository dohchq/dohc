import { describe, expect, it } from "vitest";
import { DohcPluginManifest } from "./pluginManifest";

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
    ["over 214 characters", "a".repeat(215)],
  ])("rejects a name with %s", (_case, name) => {
    expect(DohcPluginManifest.safeParse({ ...minimalManifest, name }).success).toBe(false);
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
});
