import { describe, expect, it } from "vitest";
import {
  detectSitePackageManager,
  discoverSites,
  frameworkConfigName,
  hasWebDependency,
  inferSiteScripts,
  needsBuiltArtifact,
  packageManagerFromFiles,
  parseDohcSiteConfig,
  preferredBuildOutput,
  presentBuildOutput,
} from "./sites";

describe("site package derived facts", () => {
  const base = {
    buildOutputs: ["dist"],
    scripts: {},
    configuredScripts: {},
  };

  it("finds present build output for root and nested sites", () => {
    expect(
      presentBuildOutput({
        ...base,
        root: ".",
        sourceFiles: ["dist/index.html"],
      }),
    ).toBe("dist");
    expect(
      presentBuildOutput({
        ...base,
        root: "sites/report",
        sourceFiles: ["sites/report/dist/index.html"],
      }),
    ).toBe("dist");
  });

  it("identifies sites that need a built artifact", () => {
    expect(
      needsBuiltArtifact({
        ...base,
        root: ".",
        sourceFiles: [],
        buildOutputs: [],
        configuredScripts: { dev: "serve ." },
      }),
    ).toBe(true);
    expect(
      needsBuiltArtifact({
        ...base,
        root: ".",
        sourceFiles: [],
        buildOutputs: [],
      }),
    ).toBe(false);
  });
});

describe("discoverSites", () => {
  it("discovers a plain static website from index.html", () => {
    expect(
      discoverSites([
        "report/index.html",
        "report/styles.css",
        "report/script.js",
        "notes/today.md",
      ]),
    ).toEqual([
      {
        root: "report",
        title: "Report",
        kind: "static",
        confidence: "high",
        entry: "index.html",
        scripts: {},
        buildOutputs: [],
        diagnostics: [],
      },
    ]);
  });

  it("discovers package websites from scripts, dependencies, and lockfiles", () => {
    const [site] = discoverSites([
      {
        path: "client-dashboard/package.json",
        body: JSON.stringify({
          name: "@acme/client-dashboard",
          scripts: {
            predev: "node verify-host.mjs",
            dev: "vite --host 127.0.0.1",
            postdev: "node announce-ready.mjs",
            build: "vite build",
            preview: "vite preview",
          },
          dependencies: { "@vitejs/plugin-react": "^5.0.0", react: "^19.0.0" },
        }),
      },
      "client-dashboard/pnpm-lock.yaml",
      "client-dashboard/src/App.tsx",
    ]);

    expect(site).toMatchObject({
      root: "client-dashboard",
      title: "Client Dashboard",
      kind: "package",
      confidence: "medium",
      packageManager: "pnpm",
      scripts: {
        predev: "node verify-host.mjs",
        dev: "vite --host 127.0.0.1",
        postdev: "node announce-ready.mjs",
        build: "vite build",
      },
      diagnostics: [],
    });
  });

  it("discovers configured framework sites without dohc-specific files", () => {
    expect(
      discoverSites([
        {
          path: "portal/package.json",
          body: JSON.stringify({ scripts: { dev: "next dev" }, dependencies: { next: "^15.0.0" } }),
        },
        "portal/next.config.mjs",
        "portal/app/page.tsx",
      ]),
    ).toEqual([
      {
        root: "portal",
        title: "Portal",
        kind: "configured",
        confidence: "high",
        configPath: "portal/next.config.mjs",
        scripts: { dev: "next dev" },
        buildOutputs: [],
        diagnostics: [],
      },
    ]);
  });

  it("recognizes TanStack-style app.config files as site config", () => {
    expect(discoverSites(["agent-console/app.config.ts", "agent-console/src/router.tsx"])).toEqual([
      {
        root: "agent-console",
        title: "Agent Console",
        kind: "configured",
        confidence: "high",
        configPath: "agent-console/app.config.ts",
        scripts: {},
        buildOutputs: [],
        diagnostics: [],
      },
    ]);
  });

  it("prefers dohc.json title, commands, entry, and build output when present", () => {
    const [site] = discoverSites([
      {
        path: "research/site/dohc.json",
        body: JSON.stringify({
          type: "site",
          title: "Research Portal",
          preview: { mode: "dev", command: "pnpm dev", entry: "./index.html" },
          build: { command: "pnpm build", output: "public/./dist" },
        }),
      },
      {
        path: "research/site/package.json",
        body: JSON.stringify({
          name: "less-good-title",
          scripts: { dev: "vite", build: "vite build" },
          devDependencies: { vite: "^7.0.0" },
        }),
      },
      "research/site/bun.lockb",
      "research/site/index.html",
    ]);

    expect(site).toMatchObject({
      root: "research/site",
      title: "Research Portal",
      kind: "configured",
      confidence: "high",
      entry: "index.html",
      packageManager: "bun",
      configPath: "research/site/dohc.json",
      scripts: { dev: "pnpm dev", build: "pnpm build" },
      configuredPreviewMode: "dev",
      configuredBuildOutput: "public/dist",
      buildOutputs: [],
      diagnostics: [],
    });
  });

  it("keeps configured build output separate from inferred output order", () => {
    const [site] = discoverSites([
      {
        path: "portal/dohc.json",
        body: JSON.stringify({
          type: "site",
          build: { command: "vite build", output: "dist" },
        }),
      },
      "portal/build/index.html",
      "portal/dist/index.html",
    ]);

    expect(site).toMatchObject({
      configuredBuildOutput: "dist",
      buildOutputs: ["build", "dist"],
    });
    expect(preferredBuildOutput(site)).toBe("dist");
    expect(
      presentBuildOutput({
        root: site.root,
        configuredBuildOutput: site.configuredBuildOutput,
        buildOutputs: site.buildOutputs,
        sourceFiles: ["portal/build/index.html", "portal/dist/index.html"],
        scripts: site.scripts,
        configuredScripts: {},
      }),
    ).toBe("dist");
  });

  it("surfaces invalid dohc.json diagnostics without hiding the site", () => {
    const [site] = discoverSites([
      "broken/index.html",
      { path: "broken/dohc.json", body: "{ nope" },
    ]);

    expect(site).toMatchObject({
      root: "broken",
      kind: "configured",
      configPath: "broken/dohc.json",
      entry: "index.html",
    });
    expect(site.diagnostics).toHaveLength(1);
    expect(site.diagnostics[0]).toMatchObject({
      path: "broken/dohc.json",
      severity: "error",
      code: "invalid-json",
    });
  });

  it("detects built websites from common output folders", () => {
    expect(discoverSites(["snapshot/dist/index.html", "snapshot/dist/assets/app.js"])).toEqual([
      {
        root: "snapshot",
        title: "Snapshot",
        kind: "static",
        confidence: "medium",
        entry: "dist/index.html",
        scripts: {},
        buildOutputs: ["dist"],
        diagnostics: [],
      },
    ]);
  });

  it("does not count an output folder without its root index", () => {
    const [site] = discoverSites([
      {
        path: "portal/package.json",
        body: JSON.stringify({
          scripts: { dev: "vite" },
          dependencies: { vite: "latest" },
        }),
      },
      "portal/build/README.md",
    ]);

    expect(site?.buildOutputs).toEqual([]);
  });

  it("ignores workspace internals, package caches, and build cache internals", () => {
    expect(
      discoverSites([
        ".dohc/cache/sites/hidden/index.html",
        "node_modules/demo/index.html",
        ".git/worktrees/site/index.html",
        "pkg/.yarn/cache/example/index.html",
        "pkg/.next/cache/index.html",
        "pkg/.next. /cache. /index.html",
      ]),
    ).toEqual([]);
  });

  it("does not discover sites under plugins folders", () => {
    expect(
      discoverSites(["plugins/some-plugin/index.html", "ordinary-site/index.html"]),
    ).toEqual([
      {
        root: "ordinary-site",
        title: "Ordinary Site",
        kind: "static",
        confidence: "high",
        entry: "index.html",
        scripts: {},
        buildOutputs: [],
        diagnostics: [],
      },
    ]);
  });

  it("keeps a site's internal plugins directory while excluding the root plugin tree", () => {
    expect(
      discoverSites([
        "customer-portal/plugins/index.html",
        "customer-portal/plugins/chart.js",
        "plugins/hello-plugin/panel/index.html",
      ]),
    ).toEqual([
      {
        root: "customer-portal/plugins",
        title: "Plugins",
        kind: "static",
        confidence: "high",
        entry: "index.html",
        scripts: {},
        buildOutputs: [],
        diagnostics: [],
      },
    ]);
  });

  it("ignores site paths with Windows-aliased traversal segments", () => {
    expect(discoverSites(["evil/.. /index.html", "evil/... /index.html"])).toEqual([]);
  });

  it("keeps trailing dots in real path segments", () => {
    expect(discoverSites(["notes./index.html"])[0]?.root).toBe("notes.");
  });

  it("keeps broken package.json repairable when it looks like a site root", () => {
    const [site] = discoverSites([
      "repairable/index.html",
      { path: "repairable/package.json", body: "{ bad" },
    ]);

    expect(site.root).toBe("repairable");
    expect(site.diagnostics[0]).toMatchObject({
      path: "repairable/package.json",
      code: "invalid-package-json",
      severity: "error",
    });
  });

  it("does not classify diagnostics-only folders as sites", () => {
    expect(discoverSites([{ path: "not-a-site/package.json", body: "{ bad" }])).toEqual([]);
  });

  it("ignores non-site dohc.json unless website signals conflict", () => {
    const sites = discoverSites([
      { path: "workflow/dohc.json", body: JSON.stringify({ type: "workflow" }) },
      { path: "conflict/dohc.json", body: JSON.stringify({ type: "workflow" }) },
      "conflict/index.html",
    ]);

    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({ root: "conflict" });
    expect(sites[0]?.diagnostics).toEqual([
      expect.objectContaining({ code: "unexpected_dohc_type" }),
    ]);
  });
});

describe("parseDohcSiteConfig", () => {
  it("parses optional site metadata and commands", () => {
    expect(
      parseDohcSiteConfig(
        JSON.stringify({
          type: "site",
          title: "Client Dashboard",
          preview: { mode: "build", command: "pnpm preview", entry: "dist/index.html" },
          build: { command: "pnpm build", output: "dist" },
        }),
        "client-dashboard/dohc.json",
      ),
    ).toEqual({
      config: {
        type: "site",
        title: "Client Dashboard",
        preview: { mode: "build", command: "pnpm preview", entry: "dist/index.html" },
        build: { command: "pnpm build", output: "dist" },
      },
      declaredType: "site",
      diagnostics: [
        expect.objectContaining({
          path: "client-dashboard/dohc.json",
          severity: "warning",
          code: "unsupported-preview-command-mode",
          message: expect.stringContaining("only in dev mode"),
        }),
      ],
    });
  });

  it("returns repairable diagnostics for invalid fields", () => {
    const parsed = parseDohcSiteConfig(
      JSON.stringify({
        type: 42,
        title: "",
        preview: { mode: "server", command: "", entry: "/index.html" },
        build: { output: "../dist" },
      }),
    );

    expect(parsed.config).toEqual({});
    expect(parsed.diagnostics.map((d) => d.code)).toEqual([
      "invalid-type",
      "invalid-title",
      "invalid-preview-mode",
      "invalid-preview-command",
      "invalid-preview-entry",
      "invalid-build-output",
    ]);
  });

  it("keeps a non-site type as a declared type without an invalid-type diagnostic", () => {
    const parsed = parseDohcSiteConfig(JSON.stringify({ type: "workflow" }));

    expect(parsed.config).toEqual({});
    expect(parsed.declaredType).toBe("workflow");
    expect(parsed.diagnostics).toEqual([]);
  });

  it("explains config paths that normalize to the current directory", () => {
    const parsed = parseDohcSiteConfig(
      JSON.stringify({
        preview: { entry: "." },
        build: { output: "./" },
      }),
      "site/dohc.json",
    );

    expect(parsed.diagnostics).toEqual([
      expect.objectContaining({
        code: "invalid-preview-entry",
        message: expect.stringContaining("not '.', './', or an empty path"),
      }),
      expect.objectContaining({
        code: "invalid-build-output",
        message: expect.stringContaining("not '.', './', or an empty path"),
      }),
    ]);
  });
});

describe("package helpers", () => {
  it("detects package managers from lockfiles before package metadata", () => {
    expect(
      detectSitePackageManager(new Set(["yarn.lock"]), { packageManager: "npm@10.0.0" }),
    ).toBe("yarn");
    expect(detectSitePackageManager(new Set(), { packageManager: "pnpm@10.0.0" })).toBe("pnpm");
  });

  it("infers site scripts and lets dohc.json commands override package defaults", () => {
    expect(
      inferSiteScripts(
        { scripts: { dev: "vite", start: "vite --host", build: "vite build" } },
        {
          type: "site",
          preview: { mode: "dev", command: "pnpm dev" },
          build: { command: "pnpm build" },
        },
      ),
    ).toEqual({
      dev: "pnpm dev",
      start: "vite --host",
      build: "pnpm build",
    });
  });
});

describe("MCP-facing site helpers", () => {
  it("detects web dependencies", () => {
    expect(hasWebDependency({ dependencies: { react: "^19.0.0" } })).toBe(true);
    expect(hasWebDependency({ devDependencies: { vite: "^7.0.0" } })).toBe(true);
    expect(hasWebDependency({ dependencies: { lodash: "^4.0.0" } })).toBe(false);
    expect(hasWebDependency(undefined)).toBe(false);
  });

  it("finds framework config names", () => {
    expect(frameworkConfigName(new Set(["next.config.mjs", "README.md"]))).toBe(
      "next.config.mjs",
    );
    expect(frameworkConfigName(new Set(["package.json"]))).toBeUndefined();
  });

  it("keeps package-manager detection available without the desktop alias", () => {
    expect(
      packageManagerFromFiles(new Set(["yarn.lock"]), {
        packageManager: "npm@10.0.0",
      }),
    ).toBe("yarn");
    expect(
      packageManagerFromFiles(new Set(), { packageManager: "pnpm@10.0.0" }),
    ).toBe("pnpm");
  });
});
