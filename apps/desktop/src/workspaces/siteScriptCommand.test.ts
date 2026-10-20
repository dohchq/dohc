import { spawnSync } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSpawnCommand } from "../process/windowsSpawn";
import type { SitePackageInfo } from "./sitePackage";
import { siteCommandEnvironment } from "./siteRunner";
import { commandForSiteScript } from "./siteScriptCommand";
import { createTestScratch } from "./testTemp";

// A relative PATH entry (a test runner's node_modules/.bin) would resolve
// pnpm against the test's cwd and then run it from the app's.
function parentEnvironment(): NodeJS.ProcessEnv {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const path = (process.env[pathKey] ?? "")
    .split(delimiter)
    .map((entry) => (entry && !isAbsolute(entry) ? resolve(entry) : entry))
    .join(delimiter);
  return { ...process.env, [pathKey]: path };
}

function pnpmAvailable(): boolean {
  const env = parentEnvironment();
  const spec = resolveSpawnCommand("pnpm", ["--version"], { env, cwd: process.cwd() });
  const result = spawnSync(spec.command, spec.args, {
    env,
    windowsVerbatimArguments: spec.windowsVerbatimArguments,
  });
  return result.status === 0;
}

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
    ["npm", ["run", "dev", "--", "--hostname", "127.0.0.1"]],
    ["pnpm", ["dev", "--hostname", "127.0.0.1"]],
    ["yarn", ["dev", "--hostname", "127.0.0.1"]],
    ["bun", ["run", "dev", "--hostname", "127.0.0.1"]],
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
      args: ["run", "start", "--", "--hostname", "127.0.0.1"],
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
      args: ["run", "dev", "--silent", "--", "--port", "4000", "--hostname", "127.0.0.1"],
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
      args: ["serve", "--hostname", "127.0.0.1"],
    });
  });

  it.each([
    ["vite", ["run", "dev", "--", "--host", "127.0.0.1"]],
    ["vite --port 5174", ["run", "dev", "--", "--host", "127.0.0.1"]],
    ["vite preview", ["run", "dev", "--", "--host", "127.0.0.1"]],
    ["vite --mode build", ["run", "dev", "--", "--host", "127.0.0.1"]],
    ["vite --mode build --port 5174", ["run", "dev", "--", "--host", "127.0.0.1"]],
    ["vite --host localhost", ["run", "dev"]],
    ["vite build", ["run", "dev"]],
    ["vite build --watch", ["run", "dev"]],
    ["vite optimize", ["run", "dev"]],
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
      expect(command.env).toEqual({ HOST: "127.0.0.1" });
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
      args: ["dev", "--hostname", "127.0.0.1"],
    });
    expect(
      commandForSiteScript(packageSite({ configuredScripts: { dev: "react-scripts start" } }), "dev").env,
    ).toEqual({ HOST: "127.0.0.1" });
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

  it.each([
    ["vite --", "vite", ["--host", "127.0.0.1", "--"]],
    ["vite -- --host 127.0.0.1", "vite", ["--host", "127.0.0.1", "--", "--host", "127.0.0.1"]],
    ["next dev -- ./app", "next", ["dev", "--hostname", "127.0.0.1", "--", "./app"]],
  ])("puts the host before the server's own -- in the literal command %s", (dev, command, args) => {
    expect(commandForSiteScript(packageSite({ configuredScripts: { dev } }), "dev")).toEqual({ command, args });
  });

  it("puts the host before the server's own -- in args a configured npm run forwards", () => {
    const site = packageSite({
      configuredScripts: { dev: "npm run dev -- -- --open" },
      scripts: { dev: "vite" },
    });

    expect(commandForSiteScript(site, "dev")).toEqual({
      command: "npm",
      args: ["run", "dev", "--", "--host", "127.0.0.1", "--", "--open"],
    });
  });

  it.each([
    "vite --",
    "next dev -- ./app",
    "next dev;",
    "next dev ;  ",
    "next dev &",
    "next dev &&",
    "next dev ||",
    "next dev |",
    "next dev\n",
    "next dev \\",
    "next dev # local only",
  ])("does not change the package script %j, whose appended args would miss the server", (dev) => {
    const site = packageSite({ configuredScripts: {}, scripts: { dev } });

    expect(commandForSiteScript(site, "dev")).toEqual({ command: "npm", args: ["run", "dev"] });
  });

  it.each(["react-scripts start;", "react-scripts start &", "react-scripts start # local", "react-scripts start --"])(
    "still gives the package script %j HOST, which reaches the server wherever the script ends",
    (start) => {
      const site = packageSite({ configuredScripts: {}, scripts: { start } });

      expect(commandForSiteScript(site, "start")).toEqual({
        command: "npm",
        args: ["run", "start"],
        env: { HOST: "127.0.0.1" },
      });
    },
  );
});

// Runs the real pnpm with fixture `next` and `react-scripts` bins that print
// the argv and HOST they receive, as the hooks around them do.
describe.skipIf(!pnpmAvailable())("commandForSiteScript loopback defaults through pnpm", () => {
  const PRINT = "console.log(JSON.stringify({ argv: process.argv.slice(2), host: process.env.HOST ?? null }));\n";

  async function pnpmApp(scripts: Record<string, string>): Promise<string> {
    const root = await realpath(await createTestScratch("site-script-pnpm-"));
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "probe", private: true, scripts }));
    await writeFile(join(root, "print.cjs"), PRINT);
    await mkdir(join(root, "node_modules", ".bin"), { recursive: true });
    for (const name of ["next", "react-scripts"]) {
      const bin = join(root, "node_modules", ".bin", name);
      await writeFile(`${bin}.cmd`, `@node "%~dp0\\..\\..\\print.cjs" %*\r\n`);
      await writeFile(bin, `#!/bin/sh\nexec node "$(dirname "$0")/../../print.cjs" "$@"\n`, { mode: 0o755 });
    }
    return root;
  }

  function run(root: string, command: ReturnType<typeof commandForSiteScript>) {
    const env = siteCommandEnvironment(parentEnvironment(), command.env);
    const spec = resolveSpawnCommand(command.command, command.args, { env, cwd: root });
    const result = spawnSync(spec.command, spec.args, {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 60_000,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as { argv: string[]; host: string | null });
  }

  it("passes the host flag to next dev and not to its hooks", async () => {
    const scripts = { predev: "node print.cjs predev", dev: "next dev", postdev: "node print.cjs postdev" };
    const root = await pnpmApp(scripts);
    const site = packageSite({ packageManager: "pnpm", configuredScripts: {}, scripts });

    expect(run(root, commandForSiteScript(site, "dev"))).toEqual([
      { argv: ["predev"], host: null },
      { argv: ["dev", "--hostname", "127.0.0.1"], host: null },
      { argv: ["postdev"], host: null },
    ]);
  }, 60_000);

  it("gives react-scripts start HOST and no flag", async () => {
    const scripts = {
      prestart: "node print.cjs prestart",
      start: "react-scripts start",
      poststart: "node print.cjs poststart",
    };
    const root = await pnpmApp(scripts);
    const site = packageSite({ packageManager: "pnpm", configuredScripts: {}, scripts });

    expect(run(root, commandForSiteScript(site, "start"))).toEqual([
      { argv: ["prestart"], host: "127.0.0.1" },
      { argv: ["start"], host: "127.0.0.1" },
      { argv: ["poststart"], host: "127.0.0.1" },
    ]);
  }, 60_000);
});
