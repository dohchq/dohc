import { describe, expect, it } from "vitest";
import type { WorkspaceSite } from "../ui/sites.js";
import { devScript, resolveMode, siteCommand } from "./main";

function site(over: Partial<WorkspaceSite> = {}): WorkspaceSite {
  return {
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
  };
}

describe("resolveMode", () => {
  it("opens the mode the user named", () => {
    const runnable = site({ entry: "index.html", scripts: { dev: "vite" } });
    expect(resolveMode(runnable, "static", null, "auto")).toBe("static");
    expect(resolveMode(runnable, "dev", "static", "build")).toBe("dev");
  });

  it("refuses a mode this site does not have, and says what it has", () => {
    expect(() => resolveMode(site({ entry: "index.html" }), "dev", null, "auto")).toThrow(
      /cannot open in dev mode\. It opens in static/,
    );
  });

  it("prefers what the site last opened in, then the setting, then a guess", () => {
    const both = site({ entry: "index.html", scripts: { dev: "vite", build: "vite build" } });
    expect(resolveMode(both, "auto", "static", "build")).toBe("static");
    expect(resolveMode(both, "auto", null, "build")).toBe("build");
    expect(resolveMode(both, "auto", null, "auto")).toBe("dev");
  });

  it("ignores a remembered or configured mode the site no longer has", () => {
    const staticOnly = site({ entry: "index.html", kind: "static" });
    expect(resolveMode(staticOnly, "auto", "dev", "auto")).toBe("static");
    expect(resolveMode(staticOnly, "auto", null, "dev")).toBe("static");
  });

  it("refuses a site with nothing to preview", () => {
    expect(() => resolveMode(site(), "auto", null, "auto")).toThrow(/has nothing to preview/);
  });
});

describe("siteCommand", () => {
  it("runs a dohc.json command as written", () => {
    const configured = site({ configuredScripts: { dev: "node serve.mjs --port 4000" } });
    expect(siteCommand(configured, "dev")).toEqual({
      command: "node",
      args: ["serve.mjs", "--port", "4000"],
    });
  });

  it("prefers a dohc.json command over the package script of the same name", () => {
    const both = site({
      scripts: { dev: "vite" },
      configuredScripts: { dev: "node serve.mjs" },
      packageManager: "pnpm",
    });
    expect(siteCommand(both, "dev")).toEqual({ command: "node", args: ["serve.mjs"] });
  });

  it("runs a package script through the site's own package manager", () => {
    const pkg = site({ scripts: { build: "vite build" }, packageManager: "pnpm" });
    expect(siteCommand(pkg, "build")).toEqual({ command: "pnpm", args: ["build"] });
  });

  it("falls back to npm for a package with no lockfile to name a manager", () => {
    expect(siteCommand(site({ scripts: { dev: "vite" } }), "dev")).toEqual({
      command: "npm",
      args: ["run", "dev"],
    });
  });

  it("runs a script as a command line when there is no package to run it", () => {
    const bare = site({ hasPackage: false, scripts: { dev: "node serve.mjs" } });
    expect(siteCommand(bare, "dev")).toEqual({ command: "node", args: ["serve.mjs"] });
  });

  it("refuses a script the site does not have", () => {
    expect(() => siteCommand(site(), "build")).toThrow(/has no build script/);
  });
});

describe("devScript", () => {
  it("prefers dev, and falls back to start", () => {
    expect(devScript(site({ scripts: { dev: "vite" } }))).toBe("dev");
    expect(devScript(site({ configuredScripts: { dev: "node serve.mjs" } }))).toBe("dev");
    expect(devScript(site({ scripts: { start: "serve" } }))).toBe("start");
  });
});
