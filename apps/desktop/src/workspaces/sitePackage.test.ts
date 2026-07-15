import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeTmpdir } from "./testTemp";
import {
  discoverSiteRoots,
  getSitePackage,
  listSitePackages,
  sharedStaticEntryRelativeToSite,
  shareMountRootForSite,
  staticPreviewTargetForSite,
} from "./sitePackage";
import { SHARED_WITH_ME_FOLDER } from "./createWorkspaceFolder";
import { startStaticSitePreview } from "./siteRunner";
import type { WorkspaceFileEntry } from "../ipc/bridgeContract";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(nativeTmpdir(), "dohc-site-packages-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function file(path: string): WorkspaceFileEntry {
  return { path, kind: "file" };
}

describe("discoverSiteRoots", () => {
  it("detects normal website roots from standard web signals", () => {
    expect(
      discoverSiteRoots(
        [
          file("report/index.html"),
          file("dash/package.json"),
          file("dash/vite.config.ts"),
          file("portal/vite.config.ts"),
          file(`${SHARED_WITH_ME_FOLDER}/alex/portal/index.html`),
          file("notes/today.md"),
          file("dohc.json"),
        ],
        ["built/dist", "plain"],
      ),
    ).toEqual([
      ".",
      "built",
      "dash",
      "portal",
      "report",
      `${SHARED_WITH_ME_FOLDER}/alex/portal`,
    ]);
  });
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
      "window.built = true;",
    );

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "shared-with-me/alex/portal",
    );
    expect(site).toBeDefined();
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

  it("keeps dohc.json preview commands separate from package scripts", async () => {
    const cases = [
      ["dev-site", "dev", "dev"],
      ["static-site", "static", "preview"],
      ["build-site", "build", "preview"],
    ] as const;
    for (const [folder, mode, slot] of cases) {
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
    for (const [folder, , slot] of cases) {
      const site = sites.find((entry) => entry.root === folder);
      expect(site?.configuredScripts).toMatchObject({
        [slot]: `node /tmp/${folder}.js --host 127.0.0.1`,
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
        ["public-static", "static", "serve dist --host=0.0.0.0", null],
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
