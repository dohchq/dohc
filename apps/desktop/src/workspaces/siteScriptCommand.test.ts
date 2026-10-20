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

  it("preserves forwarded args and npm's documented -- separator, so npm forwards them instead of consuming them", () => {
    const site = packageSite({
      configuredScripts: { dev: "npm run dev -- --port 3000" },
    });

    // Without the "--", npm's own CLI parser would consume --port itself
    // instead of forwarding it to the script.
    expect(commandForSiteScript(site, "dev")).toEqual({
      command: "npm",
      args: ["run", "dev", "--", "--port", "3000"],
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

describe("commandForSiteScript loopback defaults", () => {
  it.each([
    ["npm", ["run", "dev", "--", "--hostname", "localhost"]],
    ["pnpm", ["dev", "--hostname", "localhost"]],
    ["yarn", ["dev", "--hostname", "localhost"]],
    ["bun", ["run", "dev", "--hostname", "localhost"]],
  ] as const)("starts a package.json next dev script on loopback through %s", (manager, args) => {
    const site = packageSite({
      packageManager: manager,
      configuredScripts: {},
      scripts: { dev: "next dev --turbopack", predev: "node prepare.mjs" },
    });

    expect(commandForSiteScript(site, "dev")).toEqual({ command: manager, args: [...args] });
  });

  it("starts next start on loopback when the app has only a start script", () => {
    const site = packageSite({ configuredScripts: {}, scripts: { start: "next start -p 4000" } });

    expect(commandForSiteScript(site, "start")).toEqual({
      command: "npm",
      args: ["run", "start", "--", "--hostname", "localhost"],
    });
  });

  it.each(["next dev -H 127.0.0.1", "next dev --hostname=localhost", "next dev --hostname ::1"])(
    "leaves %s on the loopback host it chose",
    (dev) => {
      const site = packageSite({ configuredScripts: {}, scripts: { dev } });

      expect(commandForSiteScript(site, "dev")).toEqual({ command: "npm", args: ["run", "dev"] });
    },
  );

  it("appends the host after args a configured npm run forwards", () => {
    const site = packageSite({
      configuredScripts: { dev: "npm run --silent dev -- --port 4000" },
      scripts: { dev: "next dev" },
    });

    expect(commandForSiteScript(site, "dev")).toEqual({
      command: "npm",
      args: ["run", "dev", "--silent", "--", "--port", "4000", "--hostname", "localhost"],
    });
  });

  it("leaves a host that a configured npm run forwards", () => {
    const site = packageSite({
      configuredScripts: { dev: "npm run dev -- -H 127.0.0.1" },
      scripts: { dev: "next dev" },
    });

    expect(commandForSiteScript(site, "dev")).toEqual({
      command: "npm",
      args: ["run", "dev", "--", "-H", "127.0.0.1"],
    });
  });

  it("resolves the script a configured wrapper names, not the preview script", () => {
    const site = packageSite({
      packageManager: "pnpm",
      configuredScripts: { dev: "pnpm run serve" },
      scripts: { serve: "next dev", dev: "node server.mjs" },
    });

    expect(commandForSiteScript(site, "dev")).toEqual({
      command: "pnpm",
      args: ["serve", "--hostname", "localhost"],
    });
  });

  it.each([
    ["vite", ["run", "dev", "--", "--host", "localhost"]],
    ["vite --port 5174", ["run", "dev", "--", "--host", "localhost"]],
    ["vite preview", ["run", "dev", "--", "--host", "localhost"]],
    ["vite --host 127.0.0.1", ["run", "dev"]],
    ["vite build --watch", ["run", "dev"]],
  ])("handles a %s dev script", (dev, args) => {
    const site = packageSite({ configuredScripts: {}, scripts: { dev } });

    expect(commandForSiteScript(site, "dev")).toEqual({ command: "npm", args });
  });

  it.each(["npm", "pnpm", "yarn", "bun"] as const)(
    "sets HOST for react-scripts start run through %s",
    (manager) => {
      const site = packageSite({
        packageManager: manager,
        configuredScripts: {},
        scripts: { start: "react-scripts start" },
      });

      const command = commandForSiteScript(site, "start");
      expect(command.env).toEqual({ HOST: "localhost" });
      expect(command.args).not.toContain("--host");
    },
  );

  it("leaves a react-scripts start script that sets its own HOST", () => {
    const site = packageSite({
      configuredScripts: {},
      scripts: { start: "HOST=localhost react-scripts start" },
    });

    expect(commandForSiteScript(site, "start").env).toBeUndefined();
  });

  it("starts a configured literal command on loopback", () => {
    expect(commandForSiteScript(packageSite({ configuredScripts: { dev: "next dev" } }), "dev")).toEqual({
      command: "next",
      args: ["dev", "--hostname", "localhost"],
    });
    expect(
      commandForSiteScript(packageSite({ configuredScripts: { dev: "react-scripts start" } }), "dev").env,
    ).toEqual({ HOST: "localhost" });
  });

  it.each(["next dev && node notify.mjs", "node server.mjs", "next lint", "nextjs dev", "react-scripts test"])(
    "does not change a %s script it does not recognize",
    (dev) => {
      const site = packageSite({ configuredScripts: {}, scripts: { dev } });

      expect(commandForSiteScript(site, "dev")).toEqual({ command: "npm", args: ["run", "dev"] });
    },
  );

  it("does not change build commands", () => {
    const site = packageSite({
      configuredScripts: { build: "vite build" },
      scripts: { dev: "next dev", build: "next build" },
    });

    expect(commandForSiteScript(site, "build")).toEqual({ command: "vite", args: ["build"] });
    expect(commandForSiteScript({ ...site, configuredScripts: {} }, "build")).toEqual({
      command: "npm",
      args: ["run", "build"],
    });
  });
});
