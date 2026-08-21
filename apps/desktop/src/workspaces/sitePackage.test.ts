import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestScratch } from "./testTemp";
import {
  getSitePackage,
  listSitePackages,
  sharedStaticEntryRelativeToSite,
  shareMountRootForSite,
  staticPreviewTargetForSite,
} from "./sitePackage";
import { startStaticSitePreview } from "./siteRunner";

let root: string;

function manifestOf(site: Awaited<ReturnType<typeof listSitePackages>>[number] | undefined) {
  return site?.shareManifest.ok ? site.shareManifest.manifest : null;
}

beforeEach(async () => {
  root = await createTestScratch("dohc-site-packages-");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("shareMountRootForSite", () => {
  it("identifies the containing collaboration mount without narrowing to the site", () => {
    expect(shareMountRootForSite("shared-with-me/alex/portal")).toBe(
      "shared-with-me/alex",
    );
    expect(shareMountRootForSite("shared-with-me/alex")).toBe("shared-with-me/alex");
    expect(shareMountRootForSite("Shared-With-Me./alex/portal")).toBe(
      "shared-with-me/alex",
    );
    expect(shareMountRootForSite("sites/shared-with-me/alex")).toBeNull();
    expect(shareMountRootForSite("shared-with-me")).toBeNull();
    expect(shareMountRootForSite(".")).toBeNull();
  });

  it("selects a built artifact rather than a package source entry for shared sites", async () => {
    await mkdir(join(root, "shared-with-me", "alex", "portal", "dist", "assets"), {
      recursive: true,
    });
    await writeFile(
      join(root, "shared-with-me", "alex", "portal", "package.json"),
      JSON.stringify({ scripts: { build: "vite build" }, dependencies: { vite: "latest" } }),
    );
    await writeFile(
      join(root, "shared-with-me", "alex", "portal", "index.html"),
      '<script type="module" src="/src.ts"></script>',
    );
    await writeFile(
      join(root, "shared-with-me", "alex", "portal", "dist", "index.html"),
      '<script src="/assets/main.js"></script>',
    );
    await writeFile(
      join(root, "shared-with-me", "alex", "portal", "dist", "assets", "main.js"),
      'import "./chunk.js"; window.built = true;',
    );
    await writeFile(
      join(root, "shared-with-me", "alex", "portal", "dist", "assets", "chunk.js"),
      "window.chunk = true;",
    );
    await writeFile(
      join(root, "shared-with-me", "alex", "portal", "dist", "assets", "unused.js"),
      "window.unused = true;",
    );
    await writeFile(
      join(root, "shared-with-me", "alex", "portal", "dist", "assets", "main.js.map"),
      "{}",
    );
    await writeFile(
      join(root, "shared-with-me", "alex", "portal", "dist", "alternate.html"),
      "<h1>Alternate</h1>",
    );

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "shared-with-me/alex/portal",
    );
    expect(site).toBeDefined();
    expect(manifestOf(site)).toEqual({
      entryPath: "shared-with-me/alex/portal/dist/index.html",
      assets: [
        "shared-with-me/alex/portal/dist/assets/chunk.js",
        "shared-with-me/alex/portal/dist/assets/main.js",
      ],
    });
    expect(manifestOf(site)?.assets).not.toContain(
      "shared-with-me/alex/portal/dist/assets/unused.js",
    );
    expect(manifestOf(site)?.assets).not.toContain(
      "shared-with-me/alex/portal/dist/assets/main.js.map",
    );
    expect(manifestOf(site)?.assets).not.toContain(
      "shared-with-me/alex/portal/dist/alternate.html",
    );
    expect(sharedStaticEntryRelativeToSite(site!)).toBe("dist/index.html");
    expect(staticPreviewTargetForSite(site!)).toEqual({
      root: "shared-with-me/alex/portal/dist",
      entry: "index.html",
    });
    const sharedViewSite = {
      ...site!,
      root: "portal",
      entryPath: "portal/index.html",
      packagePath: "portal/package.json",
      sourceFiles: site!.sourceFiles.map((path) =>
        path.replace("shared-with-me/alex/portal", "portal"),
      ),
      authority: { kind: "workspace" as const },
    };
    expect(staticPreviewTargetForSite(sharedViewSite)).toEqual({
      root: "portal",
      entry: "index.html",
    });
    expect(staticPreviewTargetForSite(sharedViewSite, { sharedView: true })).toEqual({
      root: "portal/dist",
      entry: "index.html",
    });
    const target = staticPreviewTargetForSite(site!);
    const preview = await startStaticSitePreview(root, target.root, {
      entry: target.entry ?? undefined,
    });
    try {
      await expect(
        fetch(new URL("/assets/main.js", preview.url)).then((response) => response.text()),
      ).resolves.toContain("window.built = true");
    } finally {
      await preview.stop();
    }
    expect(
      sharedStaticEntryRelativeToSite({
        ...site!,
        sourceFiles: site!.sourceFiles.filter((path) => !path.endsWith("dist/index.html")),
      }),
    ).toBeNull();
  });

  it("keeps a dependency-only static package shareable without a build", async () => {
    await mkdir(join(root, "shared-with-me", "alex", "plain"), { recursive: true });
    await writeFile(
      join(root, "shared-with-me", "alex", "plain", "index.html"),
      '<script type="module" src="./app.js"></script>',
    );
    await writeFile(
      join(root, "shared-with-me", "alex", "plain", "package.json"),
      JSON.stringify({ dependencies: { "@dohc/sdk": "file:vendor/dohc-sdk" } }),
    );

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "shared-with-me/alex/plain",
    );
    expect(site?.packagePath).toBe("shared-with-me/alex/plain/package.json");
    expect(manifestOf(site)).toEqual({
      entryPath: "shared-with-me/alex/plain/index.html",
      assets: [],
    });
    expect(sharedStaticEntryRelativeToSite(site!)).toBe("index.html");
    expect(staticPreviewTargetForSite(site!)).toEqual({
      root: "shared-with-me/alex/plain",
      entry: "index.html",
    });
  });
});

describe("listSitePackages", () => {
  it("returns static and package sites with inferred scripts and manager", async () => {
    await mkdir(join(root, "report"), { recursive: true });
    await writeFile(join(root, "report", "index.html"), "<h1>Report</h1>");
    await mkdir(join(root, "dash"), { recursive: true });
    await writeFile(
      join(root, "dash", "package.json"),
      JSON.stringify({ scripts: { dev: "vite", build: "vite build" } }),
    );
    await writeFile(join(root, "dash", "pnpm-lock.yaml"), "");

    const sites = await listSitePackages(root);
    expect(sites.map((site) => [site.root, site.kind, site.title])).toEqual([
      ["dash", "package", "Dash"],
      ["report", "static", "Report"],
    ]);
    expect(sites.find((site) => site.root === "dash")).toMatchObject({
      packageManager: "pnpm",
      scripts: { dev: "vite", build: "vite build" },
      shareManifest: { ok: false, reason: "no-runnable-artifact" },
    });
    expect(manifestOf(sites.find((site) => site.root === "report"))).toEqual({
      entryPath: "report/index.html",
      assets: [],
    });
  });

  it("does not invent a site entry for an incomplete output folder", async () => {
    await mkdir(join(root, "orphan", "dist"), { recursive: true });
    await writeFile(join(root, "orphan", "dist", "README.md"), "not a build");

    const sites = await listSitePackages(root);

    expect(sites.find((site) => site.root === "orphan")).toBeUndefined();
  });

  it("includes referenced browser files without filtering by extension", async () => {
    await mkdir(join(root, "media"), { recursive: true });
    await writeFile(
      join(root, "media", "index.html"),
      '<video src="./intro.mp4"></video>',
    );
    await writeFile(join(root, "media", "intro.mp4"), "video");

    const site = (await listSitePackages(root)).find((candidate) => candidate.root === "media");

    expect(manifestOf(site)?.assets).toContain("media/intro.mp4");
  });

  it("does not invent extensions for browser references", async () => {
    await mkdir(join(root, "extensionless"), { recursive: true });
    await writeFile(
      join(root, "extensionless", "index.html"),
      '<script src="app"></script><script src="exact"></script>',
    );
    await writeFile(join(root, "extensionless", "app.js"), "window.unrelated = true;");
    await writeFile(join(root, "extensionless", "exact"), "window.exact = true;");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "extensionless",
    );

    expect(manifestOf(site)?.assets).not.toContain("extensionless/app.js");
    expect(manifestOf(site)?.assets).toContain("extensionless/exact");
  });

  it("resolves relative references from the document base href", async () => {
    await mkdir(join(root, "manual", "docs"), { recursive: true });
    await writeFile(
      join(root, "manual", "index.html"),
      '<base href="/docs/"><script src="app.js"></script>',
    );
    await writeFile(join(root, "manual", "docs", "app.js"), "window.ready = true;");

    const site = (await listSitePackages(root)).find((candidate) => candidate.root === "manual");

    expect(manifestOf(site)?.assets).toContain("manual/docs/app.js");
  });

  it("does not resolve relative references against an external document base", async () => {
    await mkdir(join(root, "external-base"), { recursive: true });
    await writeFile(
      join(root, "external-base", "index.html"),
      [
        '<base href="https://cdn.example/">',
        '<script src="app.js"></script>',
        '<script src="/private.js"></script>',
      ].join(""),
    );
    await writeFile(join(root, "external-base", "app.js"), "window.localSecret = true;");
    await writeFile(
      join(root, "external-base", "private.js"),
      "window.private = true;",
    );
    await mkdir(join(root, "no-base"), { recursive: true });
    await writeFile(
      join(root, "no-base", "index.html"),
      '<script src="app.js"></script>',
    );
    await writeFile(join(root, "no-base", "app.js"), "window.local = true;");

    const sites = await listSitePackages(root);

    expect(
      manifestOf(sites.find((candidate) => candidate.root === "external-base"))
        ?.assets,
    ).not.toContain("external-base/app.js");
    expect(
      manifestOf(sites.find((candidate) => candidate.root === "external-base"))
        ?.assets,
    ).not.toContain("external-base/private.js");
    expect(
      manifestOf(sites.find((candidate) => candidate.root === "no-base"))?.assets,
    ).toContain("no-base/app.js");
  });

  it("emits exact approved static browser files instead of a recursive site root", async () => {
    await mkdir(join(root, "report", "assets"), { recursive: true });
    await mkdir(join(root, "report", "data"), { recursive: true });
    await mkdir(join(root, "report", "private"), { recursive: true });
    await mkdir(join(root, "report", "vendor", "dohc-sdk"), { recursive: true });
    await writeFile(
      join(root, "report", "index.html"),
      [
        '<link rel="icon" href="./assets/logo.png">',
        '<link rel="manifest" href="./site.webmanifest">',
        '<img src="./assets/hero.avif">',
        '<script src="./vendor/dohc-sdk/index.js"></script>',
        '<script src=./app.js></script>',
      ].join(""),
    );
    await writeFile(
      join(root, "report", "app.js"),
      `const label = "secret.json"; window.ready = label; // export ${"x".repeat(5_000)} "secret.json"`,
    );
    await writeFile(join(root, "report", "assets", "hero.avif"), "image");
    await writeFile(join(root, "report", "assets", "icon-192.png"), "image");
    await writeFile(join(root, "report", "assets", "logo.png"), "image");
    await writeFile(join(root, "report", "assets", "shortcut.png"), "image");
    await writeFile(join(root, "report", "assets", "screenshot.png"), "image");
    await writeFile(
      join(root, "report", "site.webmanifest"),
      JSON.stringify({
        start_url: "./start.html",
        icons: [{ src: "./assets/icon-192.png" }],
        screenshots: [{ src: "./assets/screenshot.png" }],
        shortcuts: [
          { url: "./shortcut.html", icons: [{ src: "./assets/shortcut.png" }] },
        ],
      }),
    );
    await writeFile(join(root, "report", "shortcut.html"), "<h1>Shortcut</h1>");
    await writeFile(
      join(root, "report", "start.html"),
      '<script src="./start.js"></script>',
    );
    await writeFile(join(root, "report", "start.js"), "window.started = true;");
    await writeFile(join(root, "report", "data", "customers.json"), "[]");
    await writeFile(join(root, "report", "vendor", "dohc-sdk", "index.js"), "sdk");
    await writeFile(join(root, "report", "private", "secret.json"), "{}");
    await writeFile(join(root, "report", "secret.json"), "{}");
    await writeFile(join(root, "report", "notes.txt"), "private notes");
    await writeFile(join(root, "report", "notes.md"), "private notes");
    await writeFile(join(root, "report", "alternate.html"), "<h1>Alternate</h1>");

    const site = (await listSitePackages(root)).find((candidate) => candidate.root === "report");
    expect(manifestOf(site)).toEqual({
      entryPath: "report/index.html",
      assets: [
        "report/app.js",
        "report/assets/hero.avif",
        "report/assets/icon-192.png",
        "report/assets/logo.png",
        "report/assets/screenshot.png",
        "report/assets/shortcut.png",
        "report/shortcut.html",
        "report/site.webmanifest",
        "report/start.html",
        "report/start.js",
        "report/vendor/dohc-sdk/index.js",
      ],
    });
    expect(manifestOf(site)?.assets).not.toContain("report/private/secret.json");
    expect(manifestOf(site)?.assets).not.toContain("report/secret.json");
    expect(manifestOf(site)?.assets).not.toContain("report/data/customers.json");
    expect(manifestOf(site)?.assets).not.toContain("report/notes.txt");
    expect(manifestOf(site)?.assets).not.toContain("report/notes.md");
    expect(manifestOf(site)?.assets).not.toContain("report/alternate.html");
  });

  it("fails closed when an exact share manifest would exceed the relay selector cap", async () => {
    await mkdir(join(root, "crowded", "assets"), { recursive: true });
    await writeFile(
      join(root, "crowded", "index.html"),
      Array.from(
        { length: 100 },
        (_, index) => `<script src="./assets/${index}.js"></script>`,
      ).join(""),
    );
    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        writeFile(join(root, "crowded", "assets", `${index}.js`), ""),
      ),
    );

    const site = (await listSitePackages(root)).find((candidate) => candidate.root === "crowded");
    expect(site?.shareManifest).toEqual({
      ok: false,
      reason: "file-count",
      limitFiles: 100,
      observedFiles: 101,
    });
  });

  it("reports the byte budget and observed bytes when scanning exceeds it", async () => {
    await mkdir(join(root, "large"), { recursive: true });
    const html = '<script src="./app.js"></script>';
    const script = "x".repeat(4 * 1024 * 1024);
    await writeFile(join(root, "large", "index.html"), html);
    await writeFile(join(root, "large", "app.js"), script);

    const site = (await listSitePackages(root)).find((candidate) => candidate.root === "large");

    expect(site?.shareManifest).toEqual({
      ok: false,
      reason: "byte-budget",
      limitBytes: 4 * 1024 * 1024,
      observedBytes: Buffer.byteLength(html) + Buffer.byteLength(script),
    });
  });

  it("marks mounted sites with share authority and keeps owned sites unrestricted", async () => {
    await mkdir(join(root, "owned"), { recursive: true });
    await writeFile(join(root, "owned", "index.html"), "owned");
    await mkdir(join(root, "shared-with-me", "alex", "portal"), { recursive: true });
    await writeFile(
      join(root, "shared-with-me", "alex", "portal", "index.html"),
      "shared",
    );

    const sites = await listSitePackages(root);
    expect(sites.find((site) => site.root === "owned")?.authority).toEqual({
      kind: "workspace",
    });
    expect(
      sites.find((site) => site.root === "shared-with-me/alex/portal")?.authority,
    ).toEqual({ kind: "share", mountRoot: "shared-with-me/alex" });
  });

  it("uses dohc.json title and surfaces invalid config diagnostics", async () => {
    await mkdir(join(root, "client"), { recursive: true });
    await writeFile(join(root, "client", "index.html"), "");
    await writeFile(join(root, "client", "dohc.json"), JSON.stringify({ title: "Client Portal" }));
    await mkdir(join(root, "broken"), { recursive: true });
    await writeFile(join(root, "broken", "dohc.json"), "{ nope");

    const sites = await listSitePackages(root);
    expect(sites.find((site) => site.root === "client")).toMatchObject({
      kind: "configured",
      title: "Client Portal",
      configuredScripts: {},
      diagnostics: [],
    });
    expect(sites.find((site) => site.root === "broken")?.diagnostics).toEqual([
      expect.objectContaining({ code: "invalid-json" }),
    ]);
  });

  it("reports configured preview commands that cannot run", async () => {
    for (const mode of ["static", "build"] as const) {
      const folder = `${mode}-site`;
      await mkdir(join(root, folder), { recursive: true });
      await writeFile(
        join(root, folder, "package.json"),
        JSON.stringify({ scripts: { dev: "vite" } }),
      );
      await writeFile(
        join(root, folder, "dohc.json"),
        JSON.stringify({
          type: "site",
          title: folder,
          preview: { mode, command: `node /tmp/${folder}.js --host 127.0.0.1` },
        }),
      );
    }

    const sites = await listSitePackages(root);
    for (const mode of ["static", "build"] as const) {
      const folder = `${mode}-site`;
      const site = sites.find((entry) => entry.root === folder);
      expect(site?.configuredScripts).not.toHaveProperty("preview");
      expect(site?.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "unsupported-preview-command-mode",
            message: expect.stringContaining("only in dev mode"),
          }),
        ]),
      );
    }
  });

  it("maps dev and mode-less configured preview commands to dev", async () => {
    for (const [folder, mode] of [
      ["dev-site", "dev"],
      ["default-site", undefined],
    ] as const) {
      await mkdir(join(root, folder), { recursive: true });
      await writeFile(
        join(root, folder, "package.json"),
        JSON.stringify({ scripts: { dev: "vite" } }),
      );
      await writeFile(
        join(root, folder, "dohc.json"),
        JSON.stringify({
          type: "site",
          title: folder,
          preview: {
            ...(mode ? { mode } : {}),
            command: `node /tmp/${folder}.js --host 127.0.0.1`,
          },
        }),
      );
    }

    const sites = await listSitePackages(root);
    for (const folder of ["dev-site", "default-site"]) {
      expect(
        sites.find((entry) => entry.root === folder)?.configuredScripts,
      ).toEqual({
        dev: `node /tmp/${folder}.js --host 127.0.0.1`,
      });
    }
  });

  it("drops configured preview commands that explicitly bind outside loopback", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const cases = [
        ["loopback-dev", "dev", "vite --host 127.0.0.1", "dev"],
        ["default-dev", "dev", "npm run dev", "dev"],
        ["lan-dev", "dev", "vite --host 192.168.1.1", null],
        ["all-interfaces-dev", "dev", "vite --host", null],
        ["domain-dev", "dev", "next dev -H mysite.local", null],
      ] as const;
      const blockedCases = cases.filter((entry) => entry[3] === null);

      for (const [folder, mode, command] of cases) {
        await mkdir(join(root, folder), { recursive: true });
        await writeFile(
          join(root, folder, "package.json"),
          JSON.stringify({ scripts: { dev: "vite" } }),
        );
        await writeFile(
          join(root, folder, "dohc.json"),
          JSON.stringify({
            type: "site",
            preview: { mode, command },
          }),
        );
      }

      const sites = await listSitePackages(root);
      for (const [folder, , command, slot] of cases) {
        const site = sites.find((entry) => entry.root === folder);
        if (slot) {
          expect(site?.configuredScripts).toMatchObject({ [slot]: command });
        } else {
          expect(site?.configuredScripts).toEqual({});
        }
      }
      expect(warn).toHaveBeenCalledTimes(blockedCases.length);
      for (const [folder, , command] of blockedCases) {
        const warning = warn.mock.calls.find((call) => {
          const detail = call[1] as { configPath?: string } | undefined;
          return (
            call[0] === "[desktop] ignoring configured site command" &&
            detail?.configPath === `${folder}/dohc.json`
          );
        });
        expect(warning, `missing warning for ${command}`).toBeDefined();
        const detail = warning?.[1] as { error?: unknown } | undefined;
        expect(String(detail?.error)).toContain(command);
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("accepts dohc.json config paths with dot runs inside normal folder names", async () => {
    await mkdir(join(root, "client..portal"), { recursive: true });
    await writeFile(join(root, "client..portal", "index.html"), "");
    await writeFile(
      join(root, "client..portal", "dohc.json"),
      JSON.stringify({
        type: "site",
        preview: { mode: "dev", command: "npm run dev" },
      }),
    );

    const sites = await listSitePackages(root);
    expect(sites.find((site) => site.root === "client..portal")).toMatchObject({
      configuredScripts: { dev: "npm run dev" },
    });
  });

  it("finds the deepest containing site for a path", async () => {
    await mkdir(join(root, "clients", "acme", "site", "src"), { recursive: true });
    await writeFile(
      join(root, "clients", "acme", "site", "package.json"),
      JSON.stringify({ scripts: { dev: "vite" } }),
    );
    await writeFile(join(root, "clients", "acme", "site", "src", "App.tsx"), "");

    const site = await getSitePackage(root, "clients/acme/site/src/App.tsx");
    expect(site?.root).toBe("clients/acme/site");
  });
});
