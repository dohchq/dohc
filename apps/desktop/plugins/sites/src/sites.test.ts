import { describe, expect, it } from "vitest";
import {
  availableModes,
  discoverSites,
  hasReservedSegment,
  heuristicMode,
  parsePreviewInstanceKey,
  previewInstanceKey,
  shouldRetryWatchSubscription,
  watchSubscriptionFailed,
  watchSubscriptionSucceeded,
} from "../ui/sites.js";

function siteAt(root: string, sources: Array<string | { path: string; body?: string }>) {
  return discoverSites(sources).find((site) => site.root === root);
}

describe("discoverSites", () => {
  it("finds a static site from its page", () => {
    const sites = discoverSites(["marketing/index.html", "marketing/style.css"]);
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({
      root: "marketing",
      title: "Marketing",
      kind: "static",
      confidence: "high",
      entry: "index.html",
      shared: false,
      hasPackage: false,
    });
  });

  it("reads a package site's scripts and package manager", () => {
    const site = siteAt("app", [
      { path: "app/package.json", body: JSON.stringify({
        name: "@acme/app",
        scripts: { dev: "vite", build: "vite build" },
        dependencies: { react: "18.0.0" },
      }) },
      "app/pnpm-lock.yaml",
    ]);
    expect(site).toMatchObject({
      kind: "package",
      confidence: "medium",
      title: "App",
      packageManager: "pnpm",
      hasPackage: true,
      scripts: { dev: "vite", build: "vite build" },
    });
    // Package scripts are not dohc.json commands: dohc runs them through the
    // package manager, so they must not appear as configured command lines.
    expect(site?.configuredScripts).toEqual({});
  });

  it("keeps a dohc.json command apart from a package script", () => {
    const site = siteAt("docs", [
      { path: "docs/dohc.json", body: JSON.stringify({
        type: "site",
        title: "The Docs",
        preview: { mode: "dev", command: "node serve.mjs" },
        build: { command: "node build.mjs", output: "public" },
      }) },
      "docs/index.html",
    ]);
    expect(site?.title).toBe("The Docs");
    expect(site?.kind).toBe("configured");
    expect(site?.confidence).toBe("high");
    expect(site?.configuredScripts).toEqual({
      dev: "node serve.mjs",
      build: "node build.mjs",
    });
    expect(site?.buildOutputs).toContain("public");
  });

  it("reports a broken dohc.json instead of dropping the site", () => {
    const site = siteAt("broken", [
      { path: "broken/dohc.json", body: "{ not json" },
      "broken/index.html",
    ]);
    expect(site?.diagnostics[0]).toMatchObject({
      severity: "error",
      code: "invalid-json",
      path: "broken/dohc.json",
    });
  });

  it("treats a build output as its parent's artifact, never its own site", () => {
    const sites = discoverSites(["app/index.html", "app/dist/index.html"]);
    expect(sites.map((site) => site.root)).toEqual(["app"]);
    expect(sites[0]?.buildOutputs).toEqual(["dist"]);
  });

  it("never promotes plugin source or workspace internals to a site", () => {
    const sites = discoverSites([
      "plugins/sites/ui/index.html",
      ".dohc/cache/index.html",
      "node_modules/thing/index.html",
      "app/index.html",
    ]);
    expect(sites.map((site) => site.root)).toEqual(["app"]);
  });

  it("marks a site inside a share mount as shared", () => {
    const site = siteAt("shared-with-me/alice/deck", [
      "shared-with-me/alice/deck/index.html",
    ]);
    expect(site?.shared).toBe(true);
  });
});

describe("hasReservedSegment", () => {
  it("refuses the plugins tree, workspace internals, and their Windows aliases", () => {
    expect(hasReservedSegment("plugins/sites/ui/index.html")).toBe(true);
    expect(hasReservedSegment("plugins./sites/ui/index.html")).toBe(true);
    expect(hasReservedSegment("app/.dohc/engine.db")).toBe(true);
    expect(hasReservedSegment("app/node_modules/x")).toBe(true);
    expect(hasReservedSegment("app/.next/cache/x")).toBe(true);
    expect(hasReservedSegment("app/assets/logo.png")).toBe(false);
    // A folder that merely starts with a reserved name is not reserved.
    expect(hasReservedSegment("app/node_modules_backup/x")).toBe(false);
  });
});

describe("availableModes", () => {
  const base = {
    root: "app",
    title: "App",
    kind: /** @type {const} */ ("package"),
    confidence: "high",
    scripts: {},
    configuredScripts: {},
    hasPackage: true,
    buildOutputs: [],
    shared: false,
    diagnostics: [],
  } as unknown as Parameters<typeof availableModes>[0];

  it("offers static only when there is a page to serve", () => {
    expect(availableModes({ ...base })).toEqual([]);
    expect(availableModes({ ...base, entry: "index.html" })).toEqual(["static"]);
  });

  it("offers dev for a dev or a start script", () => {
    expect(availableModes({ ...base, scripts: { dev: "vite" } })).toEqual(["dev"]);
    expect(availableModes({ ...base, scripts: { start: "serve" } })).toEqual(["dev"]);
  });

  it("offers build for a build script or an existing output", () => {
    expect(availableModes({ ...base, scripts: { build: "vite build" } })).toEqual(["build"]);
    expect(availableModes({ ...base, buildOutputs: ["dist"] })).toEqual(["build"]);
  });

  it("runs nothing from a share mount", () => {
    const shared = {
      ...base,
      shared: true,
      entry: "index.html",
      scripts: { dev: "vite", build: "vite build" },
    };
    expect(availableModes(shared)).toEqual(["static"]);
    expect(availableModes({ ...shared, entry: undefined })).toEqual([]);
  });
});

describe("heuristicMode", () => {
  const site = (over: Record<string, unknown>) =>
    ({
      root: "app",
      title: "App",
      kind: "package",
      confidence: "high",
      scripts: {},
      configuredScripts: {},
      hasPackage: true,
      buildOutputs: [],
      shared: false,
      diagnostics: [],
      ...over,
    }) as unknown as Parameters<typeof heuristicMode>[0];

  it("prefers dev, then build for anything but a plain static site", () => {
    expect(heuristicMode(site({}), ["static", "dev", "build"])).toBe("dev");
    expect(heuristicMode(site({}), ["static", "build"])).toBe("build");
    expect(heuristicMode(site({ kind: "static" }), ["static", "build"])).toBe("static");
    expect(heuristicMode(site({}), [])).toBeNull();
  });

  it("keeps a shared site static", () => {
    expect(heuristicMode(site({ shared: true }), ["static"])).toBe("static");
  });
});

describe("preview instance keys", () => {
  it("round trips a root and the mode it was opened in", () => {
    for (const mode of ["auto", "static", "dev", "build"] as const) {
      for (const root of ["", "app", "apps/web", "shared-with-me/alice/deck"]) {
        expect(parsePreviewInstanceKey(previewInstanceKey(root, mode))).toEqual({ root, mode });
      }
    }
  });

  it("keeps a root that contains a colon intact", () => {
    const key = previewInstanceKey("odd:name", "dev");
    expect(parsePreviewInstanceKey(key)).toEqual({ root: "odd:name", mode: "dev" });
  });

  it("refuses a key that names no mode", () => {
    expect(() => parsePreviewInstanceKey("app")).toThrow(/names its mode first/);
    expect(() => parsePreviewInstanceKey("weird:app")).toThrow(/names its mode first/);
  });

  it("stays inside the 512-character limit dohc puts on an instance key", () => {
    const root = "a".repeat(500);
    expect(previewInstanceKey(root, "static").length).toBeLessThanOrEqual(512);
  });
});

describe("watch subscription recovery", () => {
  it("latches a failure until a watch subscription succeeds", () => {
    const failed = watchSubscriptionFailed("files.watch failed");
    expect(failed).toEqual({ failed: true, message: "files.watch failed" });
    expect(shouldRetryWatchSubscription(failed)).toBe(true);

    const stillFailed = watchSubscriptionFailed("files.watch failed again");
    expect(shouldRetryWatchSubscription(stillFailed)).toBe(true);

    const watching = watchSubscriptionSucceeded();
    expect(watching).toEqual({ failed: false, message: null });
    expect(shouldRetryWatchSubscription(watching)).toBe(false);
  });
});
