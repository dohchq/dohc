import { describe, expect, it } from "vitest";
import type { SitePackageInfo } from "./sitePackage";
import { commandForSiteScript } from "./siteScriptCommand";

function packageSite(overrides: Partial<SitePackageInfo> = {}): SitePackageInfo {
  return {
    root: ".",
    title: "Configured site",
    kind: "configured",
    confidence: "high",
    entryPath: "index.html",
    configPath: "dohc.json",
    packagePath: "package.json",
    packageManager: "npm",
    scripts: { dev: "vite --host 127.0.0.1" },
    configuredScripts: { dev: "npm run dev" },
    configuredPreviewMode: "dev",
    configuredBuildOutput: null,
    buildOutputs: [],
    sourceFiles: ["dohc.json", "index.html", "package.json"],
    shareManifest: { ok: false, reason: "no-runnable-artifact" },
    diagnostics: [],
    authority: { kind: "workspace" },
    ...overrides,
  };
}

describe("commandForSiteScript", () => {
  it("validates lifecycle hooks behind a configured npm run wrapper", () => {
    const site = packageSite({
      scripts: {
        dev: "vite --host 127.0.0.1",
        predev: "vite --host 0.0.0.0",
      },
    });

    expect(() => commandForSiteScript(site, "dev")).toThrow(/loopback/);
  });

  it("keeps a benign configured npm run wrapper runnable", () => {
    expect(commandForSiteScript(packageSite(), "dev")).toEqual({
      command: "npm",
      args: ["run", "dev"],
    });
  });

  it("validates lifecycle hooks behind a configured pnpm shorthand wrapper", () => {
    const site = packageSite({
      packageManager: "pnpm",
      configuredScripts: { dev: "pnpm dev" },
      scripts: {
        dev: "vite --host 127.0.0.1",
        postdev: "vite --host 192.168.1.20",
      },
    });

    expect(() => commandForSiteScript(site, "dev")).toThrow(/loopback/);
  });

  it("preserves forwarded args after npm's documented -- separator", () => {
    const site = packageSite({
      configuredScripts: { dev: "npm run dev -- --port 3000" },
    });

    expect(commandForSiteScript(site, "dev")).toEqual({
      command: "npm",
      args: ["run", "dev", "--port", "3000"],
    });
  });

  it("validates a forwarded arg that binds outside loopback, not just the configured script", () => {
    const site = packageSite({
      configuredScripts: { dev: "npm run dev -- --host 0.0.0.0" },
    });

    expect(() => commandForSiteScript(site, "dev")).toThrow(/loopback/);
  });

  it("does not treat npm args after run <script> as a recognized wrapper unless they start with --", () => {
    const site = packageSite({
      configuredScripts: { dev: "npm run dev --port 3000" },
    });

    // Falls through to the uninspected literal command rather than being
    // misread as npm's `-- <forwardedArgs>` form.
    expect(commandForSiteScript(site, "dev")).toEqual({
      command: "npm",
      args: ["run", "dev", "--port", "3000"],
    });
  });

  it.each(["bun run dev", "bun dev"])(
    "validates lifecycle hooks behind the configured %s wrapper",
    (configuredCommand) => {
      const site = packageSite({
        packageManager: "bun",
        configuredScripts: { dev: configuredCommand },
        scripts: {
          dev: "vite --host 127.0.0.1",
          predev: "vite --host 0.0.0.0",
        },
      });

      expect(() => commandForSiteScript(site, "dev")).toThrow(/loopback/);
    },
  );
});
