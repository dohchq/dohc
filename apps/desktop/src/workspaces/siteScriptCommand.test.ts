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

  it("refuses an npm run command it cannot recognize as a script-run wrapper, rather than falling through unvalidated", () => {
    const site = packageSite({
      configuredScripts: { dev: "npm run dev --port 3000" },
    });

    // `--port 3000` is neither a documented npm run option nor npm's `--
    // <forwardedArgs>` form — a known package manager in an unrecognized
    // shape is refused, never executed uninspected.
    expect(() => commandForSiteScript(site, "dev")).toThrow(
      /does not recognize as a script-run wrapper/,
    );
  });

  it("recognizes npm run's documented boolean options between run and the script name, and after it, and preserves them in the argv", () => {
    const site = packageSite({
      configuredScripts: { dev: "npm run --if-present dev --silent" },
    });

    expect(commandForSiteScript(site, "dev")).toEqual({
      command: "npm",
      args: ["run", "dev", "--if-present", "--silent"],
    });
  });

  it("preserves --ignore-scripts in the rewritten command instead of silently running the hooks it suppresses", () => {
    const site = packageSite({
      configuredScripts: { dev: "npm run dev --ignore-scripts" },
    });

    expect(commandForSiteScript(site, "dev")).toEqual({
      command: "npm",
      args: ["run", "dev", "--ignore-scripts"],
    });
  });

  it("still falls through to the literal command when it isn't a package manager at all, validated for loopback", () => {
    const site = packageSite({
      configuredScripts: { dev: "vite --host 127.0.0.1" },
    });

    expect(commandForSiteScript(site, "dev")).toEqual({
      command: "vite",
      args: ["--host", "127.0.0.1"],
    });

    const hostile = packageSite({
      configuredScripts: { dev: "vite --host 0.0.0.0" },
    });
    expect(() => commandForSiteScript(hostile, "dev")).toThrow(/loopback/);
  });

  it("validates a literal configured build command for loopback, not only dev/start", () => {
    const site = packageSite({
      configuredScripts: { build: "vite build --host 0.0.0.0" },
    });

    expect(() => commandForSiteScript(site, "build")).toThrow(/loopback/);
  });

  it("validates a package.json build script and its hooks for loopback, not only dev/start", () => {
    const site = packageSite({
      scripts: {
        dev: "vite --host 127.0.0.1",
        build: "vite build",
        prebuild: "vite --host 0.0.0.0",
      },
    });

    expect(() => commandForSiteScript(site, "build")).toThrow(/loopback/);
  });

  it("refuses a configured npm build wrapper in a shape it cannot validate, rather than falling through", () => {
    const site = packageSite({
      configuredScripts: { build: "npm run build --port 3000" },
    });

    expect(() => commandForSiteScript(site, "build")).toThrow(
      /does not recognize as a script-run wrapper/,
    );
  });

  it("refuses npm run dev --if-present with a hostile predev, rather than executing it unvalidated", () => {
    const site = packageSite({
      configuredScripts: { dev: "npm run dev --if-present" },
      scripts: {
        dev: "vite --host 127.0.0.1",
        predev: "vite --host 0.0.0.0",
      },
    });

    expect(() => commandForSiteScript(site, "dev")).toThrow(/loopback/);
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
