import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestScratch } from "./testTemp";
import {
  getSitePackage,
  listSitePackages,
  sharedStaticEntryRelativeToSite,
  shareMountRootForSite,
  staticPreviewOwnerFiles,
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
    // isSharedWithMePath recognizes "Shared-With-Me." as the same reserved
    // segment (a case/Windows-alias variant), but the returned mount root
    // must stay a literal PREFIX of the original root string — a canonical
    // lowercase reconstruction would no longer prefix it, and downstream
    // authority validation checks root.startsWith(mountRoot).
    expect(shareMountRootForSite("Shared-With-Me./alex/portal")).toBe(
      "Shared-With-Me./alex",
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
      '<script type="module" src="/assets/main.js"></script>',
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
    const ownerFiles = staticPreviewOwnerFiles(site!, target);
    expect(ownerFiles.get("index.html")).toBe(
      "shared-with-me/alex/portal/dist/index.html",
    );
    expect(ownerFiles.has("recipient-only.js")).toBe(false);
    const preview = await startStaticSitePreview(root, target.root, {
        authority: site!.authority,
        entry: target.entry ?? undefined,
    });
    try {
      await expect(fetch(preview.url).then((response) => response.text()))
        .resolves.toContain("/assets/main.js");
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
  it("discovers sites only from an owner-provided file listing", async () => {
    await mkdir(join(root, "shared-with-me", "alex", "local-site"), {
      recursive: true,
    });
    await writeFile(
      join(root, "shared-with-me", "alex", "local-site", "package.json"),
      JSON.stringify({ scripts: { dev: "vite" } }),
    );

    expect(await listSitePackages(root, { files: [], folders: [] })).toEqual(
      [],
    );
  });

  it("serves a configured subdirectory entry from its containing directory", async () => {
    await mkdir(join(root, "public", "assets"), { recursive: true });
    await writeFile(
      join(root, "dohc.json"),
      JSON.stringify({
        type: "site",
        preview: { mode: "static", entry: "public/index.html" },
      }),
    );
    await writeFile(
      join(root, "public", "index.html"),
      '<script src="./assets/app.js"></script>',
    );
    await writeFile(
      join(root, "public", "assets", "app.js"),
      "window.ready = true;",
    );
    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === ".",
    );
    if (!site) throw new Error("Expected the configured root site.");
    const target = staticPreviewTargetForSite(site);
    const preview = await startStaticSitePreview(root, target.root, {
      authority: site.authority,
      entry: target.entry ?? undefined,
    });
    let assetStatus = 0;
    try {
      assetStatus = await fetch(
        new URL("/assets/app.js", preview.url),
      ).then((response) => response.status);
    } finally {
      await preview.stop();
    }

    expect.soft(target).toEqual({ root: "public", entry: "index.html" });
    expect.soft(assetStatus).toBe(200);
  });

  it("shares a subdirectory entry's root-relative asset from the same root the preview serves", async () => {
    await mkdir(join(root, "public", "assets"), { recursive: true });
    await writeFile(
      join(root, "dohc.json"),
      JSON.stringify({
        type: "site",
        preview: { mode: "static", entry: "public/index.html" },
      }),
    );
    await writeFile(
      join(root, "public", "index.html"),
      '<script src="/assets/app.js"></script>',
    );
    await writeFile(
      join(root, "public", "assets", "app.js"),
      "window.ready = true;",
    );
    // A same-named sibling outside public/ — the file the manifest would
    // incorrectly select if artifactRoot stayed at the site root instead of
    // shifting to public/, the same directory the preview server serves.
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "assets", "app.js"), "wrong file");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === ".",
    );

    expect(manifestOf(site)?.assets).toContain("public/assets/app.js");
    expect(manifestOf(site)?.assets).not.toContain("assets/app.js");
  });

  it("keeps a root-level static entry at the site root", async () => {
    await mkdir(join(root, "root-entry"), { recursive: true });
    await writeFile(
      join(root, "root-entry", "index.html"),
      "<h1>Root entry</h1>",
    );

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "root-entry",
    );
    if (!site) throw new Error("Expected the root-entry site.");

    expect(staticPreviewTargetForSite(site)).toEqual({
      root: "root-entry",
      entry: "index.html",
    });
  });

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

  it("does not treat a comma inside a data URL srcset as a local file", async () => {
    await mkdir(join(root, "data-srcset"), { recursive: true });
    await writeFile(
      join(root, "data-srcset", "index.html"),
      '<img srcset="data:text/plain,secret.txt">',
    );
    await writeFile(join(root, "data-srcset", "secret.txt"), "private");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "data-srcset",
    );

    expect(manifestOf(site)?.assets).toEqual([]);
  });

  it("includes every local candidate in a multi-candidate srcset", async () => {
    await mkdir(join(root, "responsive-srcset"), { recursive: true });
    await writeFile(
      join(root, "responsive-srcset", "index.html"),
      '<img srcset="a.png 1x, b.png 2x">',
    );
    await writeFile(join(root, "responsive-srcset", "a.png"), "one");
    await writeFile(join(root, "responsive-srcset", "b.png"), "two");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "responsive-srcset",
    );

    expect(manifestOf(site)?.assets).toEqual([
      "responsive-srcset/a.png",
      "responsive-srcset/b.png",
    ]);
  });

  it("keeps a local srcset candidate after a data URL without leaking its payload", async () => {
    await mkdir(join(root, "mixed-srcset"), { recursive: true });
    await writeFile(
      join(root, "mixed-srcset", "index.html"),
      '<img srcset="data:text/plain,x 1x, real.png 2x">',
    );
    await writeFile(join(root, "mixed-srcset", "x"), "private");
    await writeFile(join(root, "mixed-srcset", "real.png"), "public");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "mixed-srcset",
    );

    expect(manifestOf(site)?.assets).toEqual(["mixed-srcset/real.png"]);
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

  it("ignores every browser reference inside HTML comments", async () => {
    await mkdir(join(root, "commented"), { recursive: true });
    await writeFile(
      join(root, "commented", "index.html"),
      [
        '<!-- <img src="private.txt">',
        '<style>@import "commented.css";</style>',
        '<script type="module">import "./commented.js";</script>',
        "-->",
        '<img src="real.png">',
        '<!-- <img src="never-closed.txt">',
      ].join(""),
    );
    await writeFile(join(root, "commented", "private.txt"), "private");
    await writeFile(join(root, "commented", "commented.css"), "private");
    await writeFile(join(root, "commented", "commented.js"), "private");
    await writeFile(join(root, "commented", "never-closed.txt"), "private");
    await writeFile(join(root, "commented", "real.png"), "real");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "commented",
    );

    expect(manifestOf(site)?.assets).toEqual(["commented/real.png"]);
  });

  it("reads browser attributes only from real HTML tags", async () => {
    await mkdir(join(root, "attribute-context"), { recursive: true });
    await writeFile(
      join(root, "attribute-context", "index.html"),
      '<pre>src="private.txt"</pre><img src="real.png">',
    );
    await writeFile(join(root, "attribute-context", "private.txt"), "private");
    await writeFile(join(root, "attribute-context", "real.png"), "real");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "attribute-context",
    );

    expect(manifestOf(site)?.assets).toEqual(["attribute-context/real.png"]);
  });

  it("keeps inline module and style references without treating script strings as markup", async () => {
    await mkdir(join(root, "inline-context"), { recursive: true });
    await writeFile(
      join(root, "inline-context", "index.html"),
      [
        '<script type="module">',
        'import "./real.js";',
        'const html = \'<img src="fake.png">\';',
        "</script>",
        '<style>@import "real.css";</style>',
        '<img src="real.png">',
      ].join(""),
    );
    await writeFile(join(root, "inline-context", "real.js"), "export {};");
    await writeFile(join(root, "inline-context", "real.css"), "body {}");
    await writeFile(join(root, "inline-context", "real.png"), "real");
    await writeFile(join(root, "inline-context", "fake.png"), "private");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "inline-context",
    );

    expect(manifestOf(site)?.assets).toEqual([
      "inline-context/real.css",
      "inline-context/real.js",
      "inline-context/real.png",
    ]);
  });

  it("resolves a fetch-like reference from an external script against the document, not the script", async () => {
    await mkdir(join(root, "fetch-base", "js"), { recursive: true });
    await writeFile(
      join(root, "fetch-base", "index.html"),
      '<script src="js/app.js"></script>',
    );
    await writeFile(join(root, "fetch-base", "js", "app.js"), 'fetch("data.json");');
    // The real, document-relative file the browser actually requests.
    await writeFile(join(root, "fetch-base", "data.json"), "{}");
    // An unrelated same-named file where naive script-relative resolution
    // would incorrectly look instead.
    await writeFile(join(root, "fetch-base", "js", "data.json"), "wrong file");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "fetch-base",
    );

    expect(manifestOf(site)?.assets).toContain("fetch-base/data.json");
    expect(manifestOf(site)?.assets).not.toContain("fetch-base/js/data.json");
  });

  it("keeps a module import script-relative even when a fetch call in the same file is document-relative", async () => {
    await mkdir(join(root, "mixed-base", "js"), { recursive: true });
    await writeFile(
      join(root, "mixed-base", "index.html"),
      '<script type="module" src="js/app.js"></script>',
    );
    await writeFile(
      join(root, "mixed-base", "js", "app.js"),
      'import "./helper.js";\nfetch("data.json");',
    );
    await writeFile(join(root, "mixed-base", "js", "helper.js"), "export {};");
    await writeFile(join(root, "mixed-base", "data.json"), "{}");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "mixed-base",
    );

    expect(manifestOf(site)?.assets).toEqual(
      expect.arrayContaining(["mixed-base/js/helper.js", "mixed-base/data.json"]),
    );
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

  it("resolves an external script's fetch-like reference against its referring document's base href, not the artifact root", async () => {
    await mkdir(join(root, "doc-base", "docs"), { recursive: true });
    await writeFile(
      join(root, "doc-base", "index.html"),
      '<base href="/docs/"><script src="app.js"></script>',
    );
    await writeFile(join(root, "doc-base", "docs", "app.js"), 'fetch("data.json");');
    await writeFile(join(root, "doc-base", "docs", "data.json"), "{}");
    await writeFile(join(root, "doc-base", "data.json"), "wrong file");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "doc-base",
    );

    expect(manifestOf(site)?.assets).toContain("doc-base/docs/data.json");
    expect(manifestOf(site)?.assets).not.toContain("doc-base/data.json");
  });

  it("resolves a linked web manifest's own references against the manifest file, not the document", async () => {
    await mkdir(join(root, "manifest-base", "manifests"), { recursive: true });
    await writeFile(
      join(root, "manifest-base", "index.html"),
      '<link rel="manifest" href="manifests/site.webmanifest">',
    );
    await writeFile(
      join(root, "manifest-base", "manifests", "site.webmanifest"),
      JSON.stringify({ icons: [{ src: "icon.png" }] }),
    );
    await writeFile(join(root, "manifest-base", "manifests", "icon.png"), "image");
    await writeFile(join(root, "manifest-base", "icon.png"), "wrong file");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "manifest-base",
    );

    expect(manifestOf(site)?.assets).toContain("manifest-base/manifests/icon.png");
    expect(manifestOf(site)?.assets).not.toContain("manifest-base/icon.png");
  });

  it("only mints a reference from real script/style syntax, not JS/CSS-shaped prose in a text node", async () => {
    await mkdir(join(root, "prose"), { recursive: true });
    await writeFile(
      join(root, "prose", "index.html"),
      [
        "<pre>import \"./private.js\";</pre>",
        "<p>Try url(private.css) in your stylesheet.</p>",
        '<script type="module" src="app.js"></script>',
      ].join(""),
    );
    await writeFile(join(root, "prose", "app.js"), 'import "./real.js";');
    await writeFile(join(root, "prose", "real.js"), "export {};");
    await writeFile(join(root, "prose", "private.js"), "window.secret = true;");
    await writeFile(join(root, "prose", "private.css"), "body{color:red}");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "prose",
    );

    expect(manifestOf(site)?.assets).toContain("prose/real.js");
    expect(manifestOf(site)?.assets).not.toContain("prose/private.js");
    expect(manifestOf(site)?.assets).not.toContain("prose/private.css");
  });

  it("still finds a real src after an opening tag with a quoted `>` in an earlier attribute, and still blanks its body", async () => {
    await mkdir(join(root, "quoted-tag"), { recursive: true });
    await writeFile(
      join(root, "quoted-tag", "index.html"),
      '<script data-label=">" src="app.js">document.write("<img src=fake.png>");</script>',
    );
    await writeFile(join(root, "quoted-tag", "app.js"), "window.ready = true;");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "quoted-tag",
    );

    expect(manifestOf(site)?.assets).toContain("quoted-tag/app.js");
    expect(manifestOf(site)?.assets).not.toContain("quoted-tag/fake.png");
  });

  it("does not scan a script body the browser never executes (has its own src, or a non-JS type)", async () => {
    await mkdir(join(root, "inert-script"), { recursive: true });
    await writeFile(
      join(root, "inert-script", "index.html"),
      [
        '<script type="application/json">fetch("private.json")</script>',
        '<script src="app.js">fetch("also-private.json")</script>',
        '<script src="app.js"></script>',
      ].join(""),
    );
    await writeFile(join(root, "inert-script", "app.js"), "window.ready = true;");
    await writeFile(join(root, "inert-script", "private.json"), "{}");
    await writeFile(join(root, "inert-script", "also-private.json"), "{}");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "inert-script",
    );

    expect(manifestOf(site)?.assets).toContain("inert-script/app.js");
    expect(manifestOf(site)?.assets).not.toContain("inert-script/private.json");
    expect(manifestOf(site)?.assets).not.toContain("inert-script/also-private.json");
  });

  it("runs JS reference patterns over an inline event-handler attribute's value", async () => {
    await mkdir(join(root, "handler"), { recursive: true });
    await writeFile(
      join(root, "handler", "index.html"),
      '<button onclick="fetch(\'data.json\')"></button>',
    );
    await writeFile(join(root, "handler", "data.json"), "{}");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "handler",
    );

    expect(manifestOf(site)?.assets).toContain("handler/data.json");
  });

  it("resolves each document's own base for a document-relative reference in a script two documents share", async () => {
    await mkdir(join(root, "dedupe", "a"), { recursive: true });
    await mkdir(join(root, "dedupe", "b"), { recursive: true });
    await writeFile(
      join(root, "dedupe", "index.html"),
      '<iframe src="a/page.html"></iframe><iframe src="b/page.html"></iframe>',
    );
    await writeFile(join(root, "dedupe", "a", "page.html"), '<script src="/shared.js"></script>');
    await writeFile(join(root, "dedupe", "b", "page.html"), '<script src="/shared.js"></script>');
    await writeFile(join(root, "dedupe", "shared.js"), 'fetch("data.json");');
    await writeFile(join(root, "dedupe", "a", "data.json"), "{}");
    await writeFile(join(root, "dedupe", "b", "data.json"), "{}");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "dedupe",
    );

    expect(manifestOf(site)?.assets).toContain("dedupe/a/data.json");
    expect(manifestOf(site)?.assets).toContain("dedupe/b/data.json");
  });

  it("parses a <base> tag with a quoted `>` in an earlier attribute before reading its href", async () => {
    await mkdir(join(root, "based-quote", "docs"), { recursive: true });
    await writeFile(
      join(root, "based-quote", "index.html"),
      '<base data-label=">" href="/docs/"><script src="app.js"></script>',
    );
    await writeFile(join(root, "based-quote", "docs", "app.js"), "window.ready = true;");
    await writeFile(join(root, "based-quote", "app.js"), "wrong file");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "based-quote",
    );

    expect(manifestOf(site)?.assets).toContain("based-quote/docs/app.js");
    expect(manifestOf(site)?.assets).not.toContain("based-quote/app.js");
  });

  it("switches a Worker's own references to the worker script's directory, not the launching document's", async () => {
    await mkdir(join(root, "worker-base", "workers"), { recursive: true });
    await writeFile(
      join(root, "worker-base", "index.html"),
      '<script>new Worker("workers/job.js");</script>',
    );
    await writeFile(join(root, "worker-base", "workers", "job.js"), 'fetch("payload.json");');
    await writeFile(join(root, "worker-base", "workers", "payload.json"), "{}");
    await writeFile(join(root, "worker-base", "payload.json"), "wrong file");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "worker-base",
    );

    expect(manifestOf(site)?.assets).toContain("worker-base/workers/payload.json");
    expect(manifestOf(site)?.assets).not.toContain("worker-base/payload.json");
  });

  it("decodes an HTML character reference in an attribute value before resolving it", async () => {
    await mkdir(join(root, "entity-ref", "assets"), { recursive: true });
    await writeFile(
      join(root, "entity-ref", "index.html"),
      '<img src="assets&#x2f;hero.png">',
    );
    await writeFile(join(root, "entity-ref", "assets", "hero.png"), "image");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "entity-ref",
    );

    expect(manifestOf(site)?.assets).toContain("entity-ref/assets/hero.png");
  });

  it("only mints a URL-attribute reference on an element the HTML spec actually fires it from", async () => {
    await mkdir(join(root, "attr-elements"), { recursive: true });
    await writeFile(
      join(root, "attr-elements", "index.html"),
      '<div data="private.txt"></div><object data="app.pdf"></object>',
    );
    await writeFile(join(root, "attr-elements", "private.txt"), "private");
    await writeFile(join(root, "attr-elements", "app.pdf"), "pdf");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "attr-elements",
    );

    expect(manifestOf(site)?.assets).toContain("attr-elements/app.pdf");
    expect(manifestOf(site)?.assets).not.toContain("attr-elements/private.txt");
  });

  it("excludes a mounted share path from a workspace-authority site's own manifest", async () => {
    await mkdir(join(root, "shared-with-me", "alex"), { recursive: true });
    await writeFile(
      join(root, "dohc.json"),
      JSON.stringify({ type: "site", preview: { mode: "static", entry: "index.html" } }),
    );
    await writeFile(
      join(root, "index.html"),
      '<img src="/shared-with-me/alex/photo.png"><script src="./app.js"></script>',
    );
    await writeFile(join(root, "app.js"), "window.ready = true;");
    await writeFile(join(root, "shared-with-me", "alex", "photo.png"), "photo bytes");

    const site = (await listSitePackages(root)).find((candidate) => candidate.root === ".");

    expect(site?.shareManifest.ok).toBe(true);
    expect(manifestOf(site)?.assets).toContain("app.js");
    expect(manifestOf(site)?.assets).not.toContain("shared-with-me/alex/photo.png");
  });

  it("does not mint a reference from a hyphenated attribute name sharing a URL attribute's suffix", async () => {
    await mkdir(join(root, "hyphen-attr"), { recursive: true });
    await writeFile(
      join(root, "hyphen-attr", "index.html"),
      '<img data-src="private.txt"><img src="real.png">',
    );
    await writeFile(join(root, "hyphen-attr", "private.txt"), "private");
    await writeFile(join(root, "hyphen-attr", "real.png"), "image");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "hyphen-attr",
    );

    expect(manifestOf(site)?.assets).toContain("hyphen-attr/real.png");
    expect(manifestOf(site)?.assets).not.toContain("hyphen-attr/private.txt");
  });

  it("decodes an HTML character reference in an event-handler attribute before the JS scan", async () => {
    await mkdir(join(root, "handler-entity"), { recursive: true });
    await writeFile(
      join(root, "handler-entity", "index.html"),
      '<button onclick="fetch(&quot;data.json&quot;)"></button>',
    );
    await writeFile(join(root, "handler-entity", "data.json"), "{}");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "handler-entity",
    );

    expect(manifestOf(site)?.assets).toContain("handler-entity/data.json");
  });

  it("resolves an importScripts() argument in a worker file script-relative to that file", async () => {
    await mkdir(join(root, "worker-import", "workers"), { recursive: true });
    await writeFile(
      join(root, "worker-import", "index.html"),
      '<script>new Worker("workers/job.js");</script>',
    );
    await writeFile(
      join(root, "worker-import", "workers", "job.js"),
      'importScripts("helper.js");',
    );
    await writeFile(join(root, "worker-import", "workers", "helper.js"), "self.ready = true;");
    await writeFile(join(root, "worker-import", "helper.js"), "wrong file");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "worker-import",
    );

    expect(manifestOf(site)?.assets).toContain("worker-import/workers/helper.js");
    expect(manifestOf(site)?.assets).not.toContain("worker-import/helper.js");
  });

  it("only trusts a proven consumption shape (property assignment, setAttribute) for a provably DOM-producing receiver of a matching tag", async () => {
    await mkdir(join(root, "prop-assign"), { recursive: true });
    await writeFile(
      join(root, "prop-assign", "index.html"),
      '<script src="app.js"></script>',
    );
    await writeFile(
      join(root, "prop-assign", "app.js"),
      [
        // Provable, matching (tag, property), and actually INSERTED: img.src.
        'const img = document.createElement("img");',
        "document.body.appendChild(img);",
        'img.src = "img.png";',
        // Provable, matching (tag, property), and actually INSERTED: a.href
        // via setAttribute.
        'const link = document.createElement("a");',
        "document.body.appendChild(link);",
        'link.setAttribute("href", "linked.html");',
        // Provable receiver, WRONG property for the tag — div.src is an
        // inert expando, not a request (finding 2).
        'const div = document.createElement("div");',
        "document.body.appendChild(div);",
        'div.src = "wrong-tag.png";',
        // Provably a DOM element, but querySelector's tag is UNKNOWN — an
        // unknowable tag can never satisfy the (tag, property) check.
        'const queried = document.querySelector("a");',
        'queried.setAttribute("href", "queried.html");',
        // Not provable: no traceable DOM-producing origin at all.
        'const el = getElementFromSomewhere();',
        'el.src = "unproven.png";',
        // Not provable: a bare src/href-named variable is just a name.
        'const href = "private.html";',
      ].join("\n"),
    );
    await writeFile(join(root, "prop-assign", "img.png"), "image");
    await writeFile(join(root, "prop-assign", "linked.html"), "<h1>Linked</h1>");
    await writeFile(join(root, "prop-assign", "wrong-tag.png"), "image");
    await writeFile(join(root, "prop-assign", "queried.html"), "<h1>Queried</h1>");
    await writeFile(join(root, "prop-assign", "unproven.png"), "image");
    await writeFile(join(root, "prop-assign", "private.html"), "<h1>Private</h1>");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "prop-assign",
    );

    expect(manifestOf(site)?.assets).toContain("prop-assign/img.png");
    expect(manifestOf(site)?.assets).toContain("prop-assign/linked.html");
    expect(manifestOf(site)?.assets).not.toContain("prop-assign/wrong-tag.png");
    expect(manifestOf(site)?.assets).not.toContain("prop-assign/queried.html");
    expect(manifestOf(site)?.assets).not.toContain("prop-assign/unproven.png");
    expect(manifestOf(site)?.assets).not.toContain("prop-assign/private.html");
  });

  it("shares the same artifact a configured static preview serves, not a leftover build output", async () => {
    await mkdir(join(root, "static-share", "dist"), { recursive: true });
    await writeFile(
      join(root, "static-share", "dohc.json"),
      JSON.stringify({
        type: "site",
        preview: { mode: "static", entry: "index.html" },
        build: { output: "dist" },
      }),
    );
    await writeFile(
      join(root, "static-share", "index.html"),
      '<script src="./app.js"></script>',
    );
    await writeFile(join(root, "static-share", "app.js"), "window.ready = true;");
    // A leftover build output from an earlier build — must not be what gets
    // shared while preview is pinned to the configured static entry.
    await writeFile(
      join(root, "static-share", "dist", "index.html"),
      '<script src="./bundle.js"></script>',
    );
    await writeFile(join(root, "static-share", "dist", "bundle.js"), "window.built = true;");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "static-share",
    );

    expect(manifestOf(site)).toEqual({
      entryPath: "static-share/index.html",
      assets: ["static-share/app.js"],
    });
  });

  it("still shares the built output when preview is not pinned to static", async () => {
    await mkdir(join(root, "build-share", "dist"), { recursive: true });
    await writeFile(
      join(root, "build-share", "dohc.json"),
      JSON.stringify({
        type: "site",
        preview: { mode: "build" },
        build: { output: "dist" },
      }),
    );
    await writeFile(
      join(root, "build-share", "index.html"),
      '<script src="./app.js"></script>',
    );
    await writeFile(join(root, "build-share", "app.js"), "window.ready = true;");
    await writeFile(
      join(root, "build-share", "dist", "index.html"),
      '<script src="./bundle.js"></script>',
    );
    await writeFile(join(root, "build-share", "dist", "bundle.js"), "window.built = true;");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "build-share",
    );

    expect(manifestOf(site)).toEqual({
      entryPath: "build-share/dist/index.html",
      assets: ["build-share/dist/bundle.js"],
    });
  });

  it("only mints a <link href> reference for a rel value the browser actually fetches for", async () => {
    await mkdir(join(root, "link-rel"), { recursive: true });
    await writeFile(
      join(root, "link-rel", "index.html"),
      [
        '<link rel="stylesheet" href="style.css">',
        '<link rel="preload" href="preload-no-as.js">',
        '<link rel="preload" href="preload-with-as.js" as="script">',
        '<link rel="alternate" href="feed.xml">',
      ].join(""),
    );
    await writeFile(join(root, "link-rel", "style.css"), "body{}");
    await writeFile(join(root, "link-rel", "preload-no-as.js"), "window.a = true;");
    await writeFile(join(root, "link-rel", "preload-with-as.js"), "window.b = true;");
    await writeFile(join(root, "link-rel", "feed.xml"), "<rss></rss>");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "link-rel",
    );

    expect(manifestOf(site)?.assets).toContain("link-rel/style.css");
    expect(manifestOf(site)?.assets).toContain("link-rel/preload-with-as.js");
    expect(manifestOf(site)?.assets).not.toContain("link-rel/preload-no-as.js");
    expect(manifestOf(site)?.assets).not.toContain("link-rel/feed.xml");
  });

  it("does not scan an importScripts() call outside a worker's own context", async () => {
    await mkdir(join(root, "not-a-worker"), { recursive: true });
    await writeFile(
      join(root, "not-a-worker", "index.html"),
      '<script src="app.js"></script>',
    );
    await writeFile(
      join(root, "not-a-worker", "app.js"),
      'importScripts("helper.js");',
    );
    await writeFile(join(root, "not-a-worker", "helper.js"), "window.ready = true;");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "not-a-worker",
    );

    expect(manifestOf(site)?.assets).not.toContain("not-a-worker/helper.js");
  });

  it("ignores a reference inside a CSS comment", async () => {
    await mkdir(join(root, "css-comment"), { recursive: true });
    await writeFile(
      join(root, "css-comment", "index.html"),
      '<link rel="stylesheet" href="style.css">',
    );
    await writeFile(
      join(root, "css-comment", "style.css"),
      '/* url("private.txt") */ body { color: red; }',
    );
    await writeFile(join(root, "css-comment", "private.txt"), "private");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "css-comment",
    );

    expect(manifestOf(site)?.assets).toContain("css-comment/style.css");
    expect(manifestOf(site)?.assets).not.toContain("css-comment/private.txt");
  });

  it("does not trust a locally shadowed fetch identifier", async () => {
    await mkdir(join(root, "shadowed-fetch"), { recursive: true });
    await writeFile(
      join(root, "shadowed-fetch", "index.html"),
      '<script src="app.js"></script>',
    );
    await writeFile(
      join(root, "shadowed-fetch", "app.js"),
      'function fetch(path) { console.log(path); }\nfetch("private.txt");',
    );
    await writeFile(join(root, "shadowed-fetch", "private.txt"), "private");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "shadowed-fetch",
    );

    expect(manifestOf(site)?.assets).not.toContain("shadowed-fetch/private.txt");
  });

  it("switches a registered service worker's own references to its own directory, not the launching document's", async () => {
    await mkdir(join(root, "sw-context", "workers"), { recursive: true });
    await writeFile(
      join(root, "sw-context", "index.html"),
      '<script>navigator.serviceWorker.register("workers/sw.js");</script>',
    );
    await writeFile(
      join(root, "sw-context", "workers", "sw.js"),
      'importScripts("helper.js");\nfetch("payload.json");',
    );
    await writeFile(join(root, "sw-context", "workers", "helper.js"), "self.ready = true;");
    await writeFile(join(root, "sw-context", "workers", "payload.json"), "{}");
    await writeFile(join(root, "sw-context", "helper.js"), "wrong file");
    await writeFile(join(root, "sw-context", "payload.json"), "wrong file");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "sw-context",
    );

    expect(manifestOf(site)?.assets).toContain("sw-context/workers/helper.js");
    expect(manifestOf(site)?.assets).toContain("sw-context/workers/payload.json");
    expect(manifestOf(site)?.assets).not.toContain("sw-context/helper.js");
    expect(manifestOf(site)?.assets).not.toContain("sw-context/payload.json");
  });

  it("parses an inline event handler with function-body grammar, isolated from other handlers and scripts", async () => {
    await mkdir(join(root, "handler-body"), { recursive: true });
    await writeFile(
      join(root, "handler-body", "index.html"),
      [
        "<button onclick=\"fetch('data.json'); return false;\"></button>",
        '<script>fetch("script-data.json");</script>',
      ].join(""),
    );
    await writeFile(join(root, "handler-body", "data.json"), "{}");
    await writeFile(join(root, "handler-body", "script-data.json"), "{}");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "handler-body",
    );

    expect(manifestOf(site)?.assets).toContain("handler-body/data.json");
    expect(manifestOf(site)?.assets).toContain("handler-body/script-data.json");
  });

  it("includes a modulepreload link's target without requiring an as attribute", async () => {
    await mkdir(join(root, "modulepreload"), { recursive: true });
    await writeFile(
      join(root, "modulepreload", "index.html"),
      '<link rel="modulepreload" href="app.mjs">',
    );
    await writeFile(join(root, "modulepreload", "app.mjs"), "export {};");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "modulepreload",
    );

    expect(manifestOf(site)?.assets).toContain("modulepreload/app.mjs");
  });

  it("parses a modulepreload target as a module, not classic script grammar", async () => {
    await mkdir(join(root, "modulepreload-kind"), { recursive: true });
    await writeFile(
      join(root, "modulepreload-kind", "index.html"),
      '<link rel="modulepreload" href="dep.js">',
    );
    // `export` is only legal in module grammar — parsing this as classic
    // grammar would fail entirely and miss the fetch() reference below it.
    await writeFile(
      join(root, "modulepreload-kind", "dep.js"),
      'export {};\nfetch("./dep-target.txt");',
    );
    await writeFile(join(root, "modulepreload-kind", "dep-target.txt"), "data");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "modulepreload-kind",
    );

    expect(manifestOf(site)?.assets).toContain("modulepreload-kind/dep.js");
    expect(manifestOf(site)?.assets).toContain("modulepreload-kind/dep-target.txt");
  });

  it("does not parse a fetch()-only .js target as code — it shares as an asset but names no further references", async () => {
    await mkdir(join(root, "fetched-bytes"), { recursive: true });
    await writeFile(
      join(root, "fetched-bytes", "index.html"),
      '<script>fetch("payload.js");</script>',
    );
    // Real bytes a browser only ever fetches with this file — never runs as
    // a script — so the fetch("private.txt") text inside it is just data,
    // not a reference a real browser would ever follow.
    await writeFile(
      join(root, "fetched-bytes", "payload.js"),
      'fetch("private.txt");',
    );
    await writeFile(join(root, "fetched-bytes", "private.txt"), "private");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "fetched-bytes",
    );

    expect(manifestOf(site)?.assets).toContain("fetched-bytes/payload.js");
    expect(manifestOf(site)?.assets).not.toContain("fetched-bytes/private.txt");
  });

  it("still parses the same .js file as code when a LATER reference to it (same path/context/kind) is executable", async () => {
    // Both references to shared.js come from worker.js's own scan, sharing
    // the exact same documentBase/context/scriptKind — only executesAsCode
    // differs — and fetch() is discovered (and queued) BEFORE importScripts,
    // matching source order. Without executesAsCode in the dedupe key, the
    // first (non-executable) scan would "use up" shared.js's path and the
    // second (executable, importScripts) reference would be silently
    // skipped, missing real-target.txt entirely.
    await mkdir(join(root, "dual-executability"), { recursive: true });
    await writeFile(
      join(root, "dual-executability", "index.html"),
      '<script>new Worker("worker.js");</script>',
    );
    await writeFile(
      join(root, "dual-executability", "worker.js"),
      'fetch("shared.js");\nimportScripts("shared.js");',
    );
    await writeFile(
      join(root, "dual-executability", "shared.js"),
      'fetch("real-target.txt");',
    );
    await writeFile(join(root, "dual-executability", "real-target.txt"), "data");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "dual-executability",
    );

    expect(manifestOf(site)?.assets).toContain("dual-executability/worker.js");
    expect(manifestOf(site)?.assets).toContain("dual-executability/shared.js");
    expect(manifestOf(site)?.assets).toContain("dual-executability/real-target.txt");
  });

  it("follows a meta-refresh navigation target as a document-relative dependency", async () => {
    await mkdir(join(root, "meta-refresh"), { recursive: true });
    await writeFile(
      join(root, "meta-refresh", "index.html"),
      '<meta http-equiv="refresh" content="0;url=next.html">',
    );
    await writeFile(join(root, "meta-refresh", "next.html"), "<h1>Next</h1>");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "meta-refresh",
    );

    expect(manifestOf(site)?.assets).toContain("meta-refresh/next.html");
  });

  it("does not mint a meta-refresh reference from a bare delay with no url= part", async () => {
    await mkdir(join(root, "meta-refresh-bare"), { recursive: true });
    await writeFile(
      join(root, "meta-refresh-bare", "index.html"),
      '<meta http-equiv="refresh" content="5">',
    );

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "meta-refresh-bare",
    );

    expect(manifestOf(site)?.assets).toEqual([]);
  });

  it("iframe src yields to srcdoc when both are present", async () => {
    await mkdir(join(root, "srcdoc-wins"), { recursive: true });
    await writeFile(
      join(root, "srcdoc-wins", "index.html"),
      '<iframe srcdoc="<h1>Inline</h1>" src="private.html"></iframe>',
    );
    await writeFile(join(root, "srcdoc-wins", "private.html"), "<h1>Private</h1>");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "srcdoc-wins",
    );

    expect(manifestOf(site)?.assets).not.toContain("srcdoc-wins/private.html");
  });

  it("still fetches an iframe's src when srcdoc is absent", async () => {
    await mkdir(join(root, "src-alone"), { recursive: true });
    await writeFile(
      join(root, "src-alone", "index.html"),
      '<iframe src="framed.html"></iframe>',
    );
    await writeFile(join(root, "src-alone", "framed.html"), "<h1>Framed</h1>");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "src-alone",
    );

    expect(manifestOf(site)?.assets).toContain("src-alone/framed.html");
  });

  it("treats a substitution-free template literal as a static string reference", async () => {
    await mkdir(join(root, "template-literal"), { recursive: true });
    await writeFile(
      join(root, "template-literal", "index.html"),
      "<script>fetch(`data.json`); import(`./module.js`);</script>",
    );
    await writeFile(join(root, "template-literal", "data.json"), "{}");
    await writeFile(join(root, "template-literal", "module.js"), "export {};");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "template-literal",
    );

    expect(manifestOf(site)?.assets).toContain("template-literal/data.json");
    expect(manifestOf(site)?.assets).toContain("template-literal/module.js");
  });

  it("scans a JSON file linked as a web manifest regardless of its own file extension", async () => {
    await mkdir(join(root, "json-manifest"), { recursive: true });
    await writeFile(
      join(root, "json-manifest", "index.html"),
      '<link rel="manifest" href="manifest.json">',
    );
    await writeFile(
      join(root, "json-manifest", "manifest.json"),
      JSON.stringify({ icons: [{ src: "icon.png" }] }),
    );
    await writeFile(join(root, "json-manifest", "icon.png"), "image");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "json-manifest",
    );

    expect(manifestOf(site)?.assets).toContain("json-manifest/manifest.json");
    expect(manifestOf(site)?.assets).toContain("json-manifest/icon.png");
  });

  it("parses an external module script with surrounding whitespace in its type as a module, not classic", async () => {
    await mkdir(join(root, "module-type-whitespace"), { recursive: true });
    await writeFile(
      join(root, "module-type-whitespace", "index.html"),
      '<script type=" module " src="app.js"></script>',
    );
    // A static import is only valid MODULE grammar — parsed as classic
    // (the pre-fix, un-trimmed comparison's default), it's a syntax
    // error, the file fails to parse at all, and dep.js is never
    // discovered.
    await writeFile(join(root, "module-type-whitespace", "app.js"), 'import "./dep.js";');
    await writeFile(join(root, "module-type-whitespace", "dep.js"), "export {};");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "module-type-whitespace",
    );

    expect(manifestOf(site)?.assets).toContain("module-type-whitespace/app.js");
    expect(manifestOf(site)?.assets).toContain("module-type-whitespace/dep.js");
  });

  it("resolves a bare module specifier through an active import map, and excludes an unmapped one", async () => {
    await mkdir(join(root, "import-map"), { recursive: true });
    await writeFile(
      join(root, "import-map", "index.html"),
      [
        '<script type="importmap">{"imports": {"lib": "./public.js"}}</script>',
        '<script type="module">import "lib"; import "unmapped";</script>',
      ].join(""),
    );
    await writeFile(join(root, "import-map", "public.js"), "export {};");
    await writeFile(join(root, "import-map", "lib"), "private file literally named lib");
    await writeFile(join(root, "import-map", "unmapped"), "private file literally named unmapped");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "import-map",
    );

    expect(manifestOf(site)?.assets).toContain("import-map/public.js");
    expect(manifestOf(site)?.assets).not.toContain("import-map/lib");
    expect(manifestOf(site)?.assets).not.toContain("import-map/unmapped");
  });

  it("merges a second import map's new keys, but keeps an earlier map's own key when both declare it", async () => {
    await mkdir(join(root, "import-map-merge"), { recursive: true });
    await writeFile(
      join(root, "import-map-merge", "index.html"),
      [
        // Chromium/WebKit merge EVERY <script type="importmap"> into one
        // global map as each is parsed, in document order — a key an
        // earlier map already claims ("a") keeps its original value even
        // if a later map also declares it; a key only a later map
        // declares ("b") is still added.
        '<script type="importmap">{"imports": {"a": "./from-first.js"}}</script>',
        '<script type="importmap">{"imports": {"a": "./from-second.js", "b": "./from-second-b.js"}}</script>',
        '<script type="module">import "a"; import "b";</script>',
      ].join(""),
    );
    await writeFile(join(root, "import-map-merge", "from-first.js"), "export {};");
    await writeFile(join(root, "import-map-merge", "from-second.js"), "private file literally named from-second.js");
    await writeFile(join(root, "import-map-merge", "from-second-b.js"), "export {};");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "import-map-merge",
    );

    // "a" still resolves to the FIRST map's own value...
    expect(manifestOf(site)?.assets).toContain("import-map-merge/from-first.js");
    expect(manifestOf(site)?.assets).not.toContain("import-map-merge/from-second.js");
    // ...while "b", which only the SECOND map declares, is still merged in
    // and resolves — not lost because a first map already existed.
    expect(manifestOf(site)?.assets).toContain("import-map-merge/from-second-b.js");
  });

  it("does not apply an import map to a module script referenced earlier in document order", async () => {
    // "app.js" is referenced by src BEFORE the importmap tag — a real
    // browser has already started fetching it under NO import map by the
    // time the later <script type="importmap"> is even parsed, so "x"
    // inside app.js must stay unmapped: nothing imports public.js in this
    // document, so it must not appear in the manifest at all. (Filtering
    // against the document's FINAL resolved map instead would wrongly
    // resolve app.js's "x" to public.js and pull it in.)
    await mkdir(join(root, "import-map-order"), { recursive: true });
    await writeFile(
      join(root, "import-map-order", "index.html"),
      [
        '<script type="module" src="app.js"></script>',
        '<script type="importmap">{"imports": {"x": "./public.js"}}</script>',
      ].join(""),
    );
    await writeFile(join(root, "import-map-order", "app.js"), 'import "x";');
    await writeFile(join(root, "import-map-order", "public.js"), "export {};");
    await writeFile(join(root, "import-map-order", "x"), "private file literally named x");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "import-map-order",
    );

    expect(manifestOf(site)?.assets).toContain("import-map-order/app.js");
    expect(manifestOf(site)?.assets).not.toContain("import-map-order/public.js");
    expect(manifestOf(site)?.assets).not.toContain("import-map-order/x");
  });

  it("resolves a relative import-map key by matching the importer's normalized specifier, not just bare ones", async () => {
    await mkdir(join(root, "import-map-key"), { recursive: true });
    await writeFile(
      join(root, "import-map-key", "index.html"),
      [
        '<script type="importmap">{"imports": {"./lib.js": "./public.js"}}</script>',
        '<script type="module">import "./lib.js";</script>',
      ].join(""),
    );
    await writeFile(join(root, "import-map-key", "public.js"), "export {};");
    await writeFile(join(root, "import-map-key", "lib.js"), "private file literally named lib.js");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "import-map-key",
    );

    expect(manifestOf(site)?.assets).toContain("import-map-key/public.js");
    expect(manifestOf(site)?.assets).not.toContain("import-map-key/lib.js");
  });

  it("applies a trailing-slash import-map key as a prefix mapping to a URL-like specifier", async () => {
    await mkdir(join(root, "import-map-prefix", "vendor"), { recursive: true });
    await mkdir(join(root, "import-map-prefix", "lib"), { recursive: true });
    await writeFile(
      join(root, "import-map-prefix", "index.html"),
      [
        '<script type="importmap">{"imports": {"./lib/": "./vendor/"}}</script>',
        '<script type="module">import "./lib/widget.js";</script>',
      ].join(""),
    );
    await writeFile(join(root, "import-map-prefix", "vendor", "widget.js"), "export {};");
    await writeFile(join(root, "import-map-prefix", "lib", "widget.js"), "private");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "import-map-prefix",
    );

    expect(manifestOf(site)?.assets).toContain("import-map-prefix/vendor/widget.js");
    expect(manifestOf(site)?.assets).not.toContain("import-map-prefix/lib/widget.js");
  });

  it("carries module grammar into the queue for new Worker(lit, { type: \"module\" })", async () => {
    await mkdir(join(root, "worker-module-type"), { recursive: true });
    await writeFile(
      join(root, "worker-module-type", "index.html"),
      '<script>new Worker("worker.js", { type: "module" });</script>',
    );
    // `export` is only legal in module grammar — classic grammar would fail
    // to parse this entirely and miss the fetch() reference below it.
    await writeFile(
      join(root, "worker-module-type", "worker.js"),
      'export {};\nfetch("target.txt");',
    );
    await writeFile(join(root, "worker-module-type", "target.txt"), "data");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "worker-module-type",
    );

    expect(manifestOf(site)?.assets).toContain("worker-module-type/target.txt");
  });

  it("parses each inline <script> element separately — an earlier malformed one does not discard a later one's references", async () => {
    await mkdir(join(root, "per-script-parse"), { recursive: true });
    await writeFile(
      join(root, "per-script-parse", "index.html"),
      [
        "<script>this is not valid javascript (((</script>",
        '<script>fetch("target.txt");</script>',
      ].join(""),
    );
    await writeFile(join(root, "per-script-parse", "target.txt"), "data");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "per-script-parse",
    );

    expect(manifestOf(site)?.assets).toContain("per-script-parse/target.txt");
  });

  it("scans a shared module separately for each document's own import map", async () => {
    // Both pages, shared.js, and both targets sit in the SAME directory —
    // so documentBase, context, scriptKind, and executesAsCode are
    // IDENTICAL between the two references to shared.js. Only the active
    // import map differs, isolating that dimension of the dedupe key: with
    // separate subdirectories, documentBase alone would already force two
    // scans and this test would pass without exercising the fix at all.
    await mkdir(join(root, "import-map-identity"), { recursive: true });
    await writeFile(
      join(root, "import-map-identity", "page-a.html"),
      [
        '<script type="importmap">{"imports": {"lib": "./from-a.js"}}</script>',
        '<script type="module" src="shared.js"></script>',
      ].join(""),
    );
    await writeFile(
      join(root, "import-map-identity", "page-b.html"),
      [
        '<script type="importmap">{"imports": {"lib": "./from-b.js"}}</script>',
        '<script type="module" src="shared.js"></script>',
      ].join(""),
    );
    await writeFile(join(root, "import-map-identity", "shared.js"), 'import "lib";');
    await writeFile(join(root, "import-map-identity", "from-a.js"), "export {};");
    await writeFile(join(root, "import-map-identity", "from-b.js"), "export {};");
    await writeFile(
      join(root, "import-map-identity", "index.html"),
      [
        '<iframe src="page-a.html"></iframe>',
        '<iframe src="page-b.html"></iframe>',
      ].join(""),
    );

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "import-map-identity",
    );

    expect(manifestOf(site)?.assets).toContain("import-map-identity/from-a.js");
    expect(manifestOf(site)?.assets).toContain("import-map-identity/from-b.js");
  });

  it("treats a script type by its MIME essence, ignoring parameters like charset", async () => {
    await mkdir(join(root, "mime-essence"), { recursive: true });
    await writeFile(
      join(root, "mime-essence", "index.html"),
      '<script type="text/javascript; charset=utf-8">fetch("target.txt");</script>',
    );
    await writeFile(join(root, "mime-essence", "target.txt"), "data");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "mime-essence",
    );

    expect(manifestOf(site)?.assets).toContain("mime-essence/target.txt");
  });

  it("does not let an unrelated scope's non-DOM binding of the same name grant DOM provenance", async () => {
    await mkdir(join(root, "dom-scope"), { recursive: true });
    await writeFile(
      join(root, "dom-scope", "index.html"),
      '<script src="app.js"></script>',
    );
    await writeFile(
      join(root, "dom-scope", "app.js"),
      [
        "function real() {",
        '  const img = document.createElement("img");',
        '  img.src = "real.png";',
        "}",
        "function fake() {",
        "  const img = {};",
        '  img.src = "private.png";',
        "}",
      ].join("\n"),
    );
    await writeFile(join(root, "dom-scope", "real.png"), "image");
    await writeFile(join(root, "dom-scope", "private.png"), "image");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "dom-scope",
    );

    expect(manifestOf(site)?.assets).not.toContain("dom-scope/real.png");
    expect(manifestOf(site)?.assets).not.toContain("dom-scope/private.png");
  });

  it("normalizes a backslash in a reference as a path separator, the way a browser's URL parser does", async () => {
    await mkdir(join(root, "backslash-ref", "assets"), { recursive: true });
    await writeFile(
      join(root, "backslash-ref", "index.html"),
      '<script src="assets\\app.js"></script>',
    );
    await writeFile(join(root, "backslash-ref", "assets", "app.js"), "");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "backslash-ref",
    );

    expect(manifestOf(site)?.assets).toContain("backslash-ref/assets/app.js");
  });

  it("classifies a network-path <base href> (normalized from a leading double backslash) as external", async () => {
    await mkdir(join(root, "network-base"), { recursive: true });
    await writeFile(
      join(root, "network-base", "index.html"),
      [
        '<base href="\\\\host\\dir\\">',
        '<script src="app.js"></script>',
      ].join(""),
    );
    // A decoy at the LOCAL path the old (unnormalized) check would have
    // resolved "app.js" against — a browser never requests this file, it
    // requests it from the external host "host" instead.
    await mkdir(join(root, "network-base", "host", "dir"), { recursive: true });
    await writeFile(join(root, "network-base", "host", "dir", "app.js"), "decoy");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "network-base",
    );

    expect(manifestOf(site)?.assets).not.toContain("network-base/host/dir/app.js");
  });

  it("does not treat type=\"module;foo\" as executable — it is neither the exact module keyword nor a JS MIME essence", async () => {
    await mkdir(join(root, "module-param"), { recursive: true });
    await writeFile(
      join(root, "module-param", "index.html"),
      '<script type="module;foo" src="private.js"></script>',
    );
    await writeFile(join(root, "module-param", "private.js"), "");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "module-param",
    );

    expect(manifestOf(site)?.assets).not.toContain("module-param/private.js");
  });

  it("invalidates DOM provenance for a function parameter bound to the same name as a proven DOM variable", async () => {
    await mkdir(join(root, "dom-parameter"), { recursive: true });
    await writeFile(
      join(root, "dom-parameter", "index.html"),
      '<script src="app.js"></script>',
    );
    await writeFile(
      join(root, "dom-parameter", "app.js"),
      [
        'const img = document.createElement("img");',
        'img.src = "real.png";',
        "function f(img = {}) {",
        '  img.src = "private.png";',
        "}",
      ].join("\n"),
    );
    await writeFile(join(root, "dom-parameter", "real.png"), "image");
    await writeFile(join(root, "dom-parameter", "private.png"), "image");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "dom-parameter",
    );

    expect(manifestOf(site)?.assets).not.toContain("dom-parameter/real.png");
    expect(manifestOf(site)?.assets).not.toContain("dom-parameter/private.png");
  });

  it("recognizes a quoted worker option key (new Worker(lit, { \"type\": \"module\" }))", async () => {
    await mkdir(join(root, "worker-quoted-key"), { recursive: true });
    await writeFile(
      join(root, "worker-quoted-key", "index.html"),
      '<script>new Worker("worker.js", { "type": "module" });</script>',
    );
    await writeFile(
      join(root, "worker-quoted-key", "worker.js"),
      'export {};\nfetch("target.txt");',
    );
    await writeFile(join(root, "worker-quoted-key", "target.txt"), "data");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "worker-quoted-key",
    );

    expect(manifestOf(site)?.assets).toContain("worker-quoted-key/target.txt");
  });

  it("does not collide two different import maps into the same fingerprint via unescaped delimiters", async () => {
    // {"a": "/b,c=/d"} (one entry, value contains "," and "=") and
    // {"a": "/b", "c": "/d"} (two entries) both fingerprint as the literal
    // text "a=/b,c=/d" under the old delimiter-joined scheme. Both pages,
    // shared.js, and the ambiguous targets sit in the SAME directory so
    // only the import map differs between the two scans.
    await mkdir(join(root, "import-map-fingerprint"), { recursive: true });
    await writeFile(
      join(root, "import-map-fingerprint", "page-one-entry.html"),
      [
        '<script type="importmap">{"imports": {"a": "./b,c=/d"}}</script>',
        '<script type="module" src="shared.js"></script>',
      ].join(""),
    );
    await writeFile(
      join(root, "import-map-fingerprint", "page-two-entries.html"),
      [
        '<script type="importmap">{"imports": {"a": "./b", "c": "./d"}}</script>',
        '<script type="module" src="shared.js"></script>',
      ].join(""),
    );
    await writeFile(join(root, "import-map-fingerprint", "shared.js"), 'import "c";');
    // page-one's own map has no "c" key at all (its only mapping, "a", is
    // never imported), so its scan of shared.js correctly mints nothing —
    // this file exists only to prove page-two's DIFFERENT scan (mapping
    // "c" -> "./d") still runs and resolves it, rather than being deduped
    // away by the fingerprint collision.
    await writeFile(join(root, "import-map-fingerprint", "d"), "");
    await writeFile(
      join(root, "import-map-fingerprint", "index.html"),
      [
        '<iframe src="page-one-entry.html"></iframe>',
        '<iframe src="page-two-entries.html"></iframe>',
      ].join(""),
    );

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "import-map-fingerprint",
    );

    // The two-entries page's "c" -> "./d" mapping must survive its own
    // scan even though the one-entry page's map fingerprinted identically
    // under the old scheme.
    expect(manifestOf(site)?.assets).toContain("import-map-fingerprint/d");
  });

  it("does not fetch a preload link with an empty or invalid as destination", async () => {
    await mkdir(join(root, "preload-as"), { recursive: true });
    await writeFile(
      join(root, "preload-as", "index.html"),
      [
        '<link rel="preload" as="" href="empty-as.txt">',
        '<link rel="preload" as="not-a-real-destination" href="invalid-as.txt">',
        '<link rel="preload" as="script" href="valid-as.js">',
      ].join(""),
    );
    await writeFile(join(root, "preload-as", "empty-as.txt"), "private");
    await writeFile(join(root, "preload-as", "invalid-as.txt"), "private");
    await writeFile(join(root, "preload-as", "valid-as.js"), "");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "preload-as",
    );

    expect(manifestOf(site)?.assets).not.toContain("preload-as/empty-as.txt");
    expect(manifestOf(site)?.assets).not.toContain("preload-as/invalid-as.txt");
    expect(manifestOf(site)?.assets).toContain("preload-as/valid-as.js");
  });

  it("recognizes window.fetch and globalThis.fetch the same way as a bare fetch() call", async () => {
    await mkdir(join(root, "qualified-fetch"), { recursive: true });
    await writeFile(
      join(root, "qualified-fetch", "index.html"),
      '<script>window.fetch("a.json"); globalThis.fetch("b.json");</script>',
    );
    await writeFile(join(root, "qualified-fetch", "a.json"), "{}");
    await writeFile(join(root, "qualified-fetch", "b.json"), "{}");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "qualified-fetch",
    );

    expect(manifestOf(site)?.assets).toContain("qualified-fetch/a.json");
    expect(manifestOf(site)?.assets).toContain("qualified-fetch/b.json");
  });

  it("drops an empty package script name before it reaches the bridge, which requires a non-empty key", async () => {
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ scripts: { dev: "vite", "": "echo ignored" } }),
    );
    await writeFile(join(root, "index.html"), "<h1>Empty script name</h1>");

    const site = (await listSitePackages(root)).find((candidate) => candidate.root === ".");

    expect(site?.scripts).toEqual({ dev: "vite" });
    expect(site?.diagnostics).toContainEqual(
      expect.objectContaining({ code: "script-name-empty" }),
    );
  });

  it("follows a form's action and a submit control's formaction as navigation dependencies", async () => {
    await mkdir(join(root, "form-action"), { recursive: true });
    await writeFile(
      join(root, "form-action", "index.html"),
      [
        '<form action="thanks.html"><button type="submit">Go</button></form>',
        '<form><button type="submit" formaction="override.html">Go</button></form>',
      ].join(""),
    );
    await writeFile(join(root, "form-action", "thanks.html"), "<h1>Thanks</h1>");
    await writeFile(join(root, "form-action", "override.html"), "<h1>Override</h1>");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "form-action",
    );

    expect(manifestOf(site)?.assets).toContain("form-action/thanks.html");
    expect(manifestOf(site)?.assets).toContain("form-action/override.html");
  });

  it("does not follow formaction on a control the browser never treats as a submit control", async () => {
    await mkdir(join(root, "formaction-not-submit"), { recursive: true });
    await writeFile(
      join(root, "formaction-not-submit", "index.html"),
      [
        '<input type="text" formaction="private-text.html">',
        '<button type="button" formaction="private-button.html">Go</button>',
        '<form><input type="submit" formaction="real-submit.html"></form>',
      ].join(""),
    );
    await writeFile(join(root, "formaction-not-submit", "private-text.html"), "<h1>Private</h1>");
    await writeFile(join(root, "formaction-not-submit", "private-button.html"), "<h1>Private</h1>");
    await writeFile(join(root, "formaction-not-submit", "real-submit.html"), "<h1>Real</h1>");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "formaction-not-submit",
    );

    expect(manifestOf(site)?.assets).not.toContain("formaction-not-submit/private-text.html");
    expect(manifestOf(site)?.assets).not.toContain("formaction-not-submit/private-button.html");
    expect(manifestOf(site)?.assets).toContain("formaction-not-submit/real-submit.html");
  });

  it("accepts fetch as a valid preload as destination", async () => {
    await mkdir(join(root, "preload-fetch"), { recursive: true });
    await writeFile(
      join(root, "preload-fetch", "index.html"),
      '<link rel="preload" as="fetch" href="data.json">',
    );
    await writeFile(join(root, "preload-fetch", "data.json"), "{}");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "preload-fetch",
    );

    expect(manifestOf(site)?.assets).toContain("preload-fetch/data.json");
  });

  it("resolves a bare specifier through a scoped import-map entry", async () => {
    await mkdir(join(root, "import-map-scope", "feature"), { recursive: true });
    await writeFile(
      join(root, "import-map-scope", "index.html"),
      [
        '<script type="importmap">{"scopes": {"./feature/": {"lib": "./from-scope.js"}}}</script>',
        '<script type="module" src="feature/mod.js"></script>',
      ].join(""),
    );
    await writeFile(join(root, "import-map-scope", "feature", "mod.js"), 'import "lib";');
    // A scoped address resolves against the DECLARING document (the
    // import map's own base), not against the scope key's own directory —
    // "./from-scope.js" is next to index.html, not inside feature/.
    await writeFile(join(root, "import-map-scope", "from-scope.js"), "export {};");
    // A file literally named "lib" would only be approved if the bare
    // specifier fell through unmapped instead of resolving via the scope.
    await writeFile(join(root, "import-map-scope", "lib"), "private file literally named lib");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "import-map-scope",
    );

    expect(manifestOf(site)?.assets).toContain("import-map-scope/from-scope.js");
    expect(manifestOf(site)?.assets).not.toContain("import-map-scope/lib");
  });

  it("carries module grammar into a service worker registered with { type: \"module\" }", async () => {
    await mkdir(join(root, "sw-module-type"), { recursive: true });
    await writeFile(
      join(root, "sw-module-type", "index.html"),
      '<script>navigator.serviceWorker.register("sw.js", { type: "module" });</script>',
    );
    await writeFile(
      join(root, "sw-module-type", "sw.js"),
      'export {};\nfetch("target.txt");',
    );
    await writeFile(join(root, "sw-module-type", "target.txt"), "data");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "sw-module-type",
    );

    expect(manifestOf(site)?.assets).toContain("sw-module-type/target.txt");
  });

  it("only fetches source[src] under an audio/video parent, matching picture/audio/video semantics", async () => {
    await mkdir(join(root, "source-parent"), { recursive: true });
    await writeFile(
      join(root, "source-parent", "index.html"),
      [
        '<picture><source src="private-in-picture.png" srcset="real-srcset.png"><img src="fallback.png"></picture>',
        '<video><source src="real-video.mp4"></video>',
        '<source src="detached.mp4">',
      ].join(""),
    );
    await writeFile(join(root, "source-parent", "private-in-picture.png"), "image");
    await writeFile(join(root, "source-parent", "real-srcset.png"), "image");
    await writeFile(join(root, "source-parent", "fallback.png"), "image");
    await writeFile(join(root, "source-parent", "real-video.mp4"), "video");
    await writeFile(join(root, "source-parent", "detached.mp4"), "video");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "source-parent",
    );

    expect(manifestOf(site)?.assets).not.toContain("source-parent/private-in-picture.png");
    expect(manifestOf(site)?.assets).toContain("source-parent/real-srcset.png");
    expect(manifestOf(site)?.assets).toContain("source-parent/fallback.png");
    expect(manifestOf(site)?.assets).toContain("source-parent/real-video.mp4");
    expect(manifestOf(site)?.assets).not.toContain("source-parent/detached.mp4");
  });

  it("preserves image-set() string candidates instead of blanking them as ordinary CSS strings", async () => {
    await mkdir(join(root, "image-set-css"), { recursive: true });
    await writeFile(
      join(root, "image-set-css", "index.html"),
      '<style>body { background-image: image-set("one.png" 1x, "two.png" 2x); }</style>',
    );
    await writeFile(join(root, "image-set-css", "one.png"), "image");
    await writeFile(join(root, "image-set-css", "two.png"), "image");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "image-set-css",
    );

    expect(manifestOf(site)?.assets).toContain("image-set-css/one.png");
    expect(manifestOf(site)?.assets).toContain("image-set-css/two.png");
  });

  it("does not let an unrelated scope's non-URL-literal binding of the same name grant URL-literal provenance", async () => {
    await mkdir(join(root, "url-literal-scope"), { recursive: true });
    await writeFile(
      join(root, "url-literal-scope", "index.html"),
      '<script type="module" src="app.js"></script>',
    );
    await writeFile(
      join(root, "url-literal-scope", "app.js"),
      [
        'const target = new URL("private.json", import.meta.url);',
        "function load(target) {",
        "  fetch(target);",
        "}",
        'load("public.json");',
      ].join("\n"),
    );
    await writeFile(join(root, "url-literal-scope", "private.json"), "{}");
    await writeFile(join(root, "url-literal-scope", "public.json"), "{}");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "url-literal-scope",
    );

    expect(manifestOf(site)?.assets).not.toContain("url-literal-scope/private.json");
    expect(manifestOf(site)?.assets).not.toContain("url-literal-scope/public.json");
  });

  it("follows a literal XMLHttpRequest.open() target as a document-relative dependency", async () => {
    await mkdir(join(root, "xhr-open"), { recursive: true });
    await writeFile(
      join(root, "xhr-open", "index.html"),
      '<script>const request = new XMLHttpRequest(); request.open("GET", "data.json"); request.send();</script>',
    );
    await writeFile(join(root, "xhr-open", "data.json"), "{}");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "xhr-open",
    );

    expect(manifestOf(site)?.assets).toContain("xhr-open/data.json");
  });

  it("parses an iframe's srcdoc as a nested document, resolved against the embedding document's base", async () => {
    await mkdir(join(root, "srcdoc"), { recursive: true });
    await writeFile(
      join(root, "srcdoc", "index.html"),
      "<iframe srcdoc=\"<img src='frame.png'>\"></iframe>",
    );
    await writeFile(join(root, "srcdoc", "frame.png"), "image");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "srcdoc",
    );

    expect(manifestOf(site)?.assets).toContain("srcdoc/frame.png");
  });

  it("honors a nested srcdoc document's own relative <base>, resolved against the embedding document's own <base>", async () => {
    await mkdir(join(root, "srcdoc-base", "elsewhere", "nested"), { recursive: true });
    await mkdir(join(root, "srcdoc-base", "nested"), { recursive: true });
    await writeFile(
      join(root, "srcdoc-base", "index.html"),
      [
        '<base href="/elsewhere/">',
        "<iframe srcdoc=\"<base href='nested/'><img src='inner.png'>\"></iframe>",
      ].join(""),
    );
    await writeFile(
      join(root, "srcdoc-base", "elsewhere", "nested", "inner.png"),
      "image",
    );
    // Decoy at the path a nested relative <base> would resolve to if it
    // ignored the embedding document's own <base href="/elsewhere/"> and
    // fell back to the embedding document's plain directory instead.
    await writeFile(join(root, "srcdoc-base", "nested", "inner.png"), "wrong file");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "srcdoc-base",
    );

    expect(manifestOf(site)?.assets).toContain("srcdoc-base/elsewhere/nested/inner.png");
    expect(manifestOf(site)?.assets).not.toContain("srcdoc-base/nested/inner.png");
  });

  it("does not mint a CSS reference from url()/@import text embedded inside an ordinary CSS string value", async () => {
    await mkdir(join(root, "css-string"), { recursive: true });
    await writeFile(
      join(root, "css-string", "index.html"),
      '<link rel="stylesheet" href="style.css">',
    );
    await writeFile(
      join(root, "css-string", "style.css"),
      [
        '.a { content: "url(private-url.txt)"; }',
        ".b { content: '@import \"private-import.css\"'; }",
        ".c { background: url(real.png); }",
      ].join("\n"),
    );
    await writeFile(join(root, "css-string", "private-url.txt"), "private");
    await writeFile(join(root, "css-string", "private-import.css"), "private");
    await writeFile(join(root, "css-string", "real.png"), "image");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "css-string",
    );

    expect(manifestOf(site)?.assets).toContain("css-string/real.png");
    expect(manifestOf(site)?.assets).not.toContain("css-string/private-url.txt");
    expect(manifestOf(site)?.assets).not.toContain("css-string/private-import.css");
  });

  it("does not trust document.createElement through a receiver that only happens to be named document", async () => {
    await mkdir(join(root, "fake-document"), { recursive: true });
    await writeFile(
      join(root, "fake-document", "index.html"),
      '<script src="app.js"></script>',
    );
    await writeFile(
      join(root, "fake-document", "app.js"),
      [
        'const fake = { document: { createElement: () => ({}) } };',
        'const img = fake.document.createElement("img");',
        'img.src = "private.png";',
      ].join("\n"),
    );
    await writeFile(join(root, "fake-document", "private.png"), "image");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "fake-document",
    );

    expect(manifestOf(site)?.assets).not.toContain("fake-document/private.png");
  });

  it("does not trust serviceWorker.register through a receiver that only happens to be named serviceWorker", async () => {
    await mkdir(join(root, "fake-sw"), { recursive: true });
    await writeFile(
      join(root, "fake-sw", "index.html"),
      '<script src="app.js"></script>',
    );
    await writeFile(
      join(root, "fake-sw", "app.js"),
      [
        'const app = { serviceWorker: { register: (url) => url } };',
        'app.serviceWorker.register("private-sw.js");',
      ].join("\n"),
    );
    await writeFile(join(root, "fake-sw", "private-sw.js"), "self.ready = true;");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "fake-sw",
    );

    expect(manifestOf(site)?.assets).not.toContain("fake-sw/private-sw.js");
  });

  it("never fetches a data-block script's own src (a non-executable type never fires a request)", async () => {
    await mkdir(join(root, "data-block"), { recursive: true });
    await writeFile(
      join(root, "data-block", "index.html"),
      '<script type="application/json" src="data.json"></script>',
    );
    await writeFile(join(root, "data-block", "data.json"), "{}");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "data-block",
    );

    expect(manifestOf(site)?.assets).not.toContain("data-block/data.json");
  });

  it("parses a classic script with its own grammar rather than falling back to module grammar", async () => {
    await mkdir(join(root, "classic-only"), { recursive: true });
    await writeFile(
      join(root, "classic-only", "index.html"),
      '<script src="classic.js"></script>',
    );
    // `import` is only legal in module grammar — a real browser throws a
    // syntax error for this classic script and runs nothing in it,
    // including the otherwise-valid fetch call below.
    await writeFile(
      join(root, "classic-only", "classic.js"),
      'import "module-only.js";\nfetch("fetch-target.txt");',
    );
    await writeFile(join(root, "classic-only", "module-only.js"), "export {};");
    await writeFile(join(root, "classic-only", "fetch-target.txt"), "data");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "classic-only",
    );

    expect(manifestOf(site)?.assets).not.toContain("classic-only/module-only.js");
    expect(manifestOf(site)?.assets).not.toContain("classic-only/fetch-target.txt");
  });

  it("scans the same external file separately per script context instead of deduping across classic and module", async () => {
    await mkdir(join(root, "dual-context"), { recursive: true });
    await writeFile(
      join(root, "dual-context", "index.html"),
      [
        '<script src="shared.js"></script>',
        '<script type="module" src="shared.js"></script>',
      ].join(""),
    );
    // Invalid as a classic script (export is module-only syntax), so the
    // classic reference to shared.js contributes nothing; a scan keyed only
    // by path would let that failed classic parse "use up" shared.js and
    // silently skip the later module reference that DOES parse.
    await writeFile(
      join(root, "dual-context", "shared.js"),
      'export {};\nfetch("target.txt");',
    );
    await writeFile(join(root, "dual-context", "target.txt"), "data");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "dual-context",
    );

    expect(manifestOf(site)?.assets).toContain("dual-context/target.txt");
  });

  it("only counts a new URL(...) constructed from import.meta.url when the result is consumed", async () => {
    await mkdir(join(root, "url-consumption"), { recursive: true });
    await writeFile(
      join(root, "url-consumption", "index.html"),
      '<script type="module" src="app.js"></script>',
    );
    await writeFile(
      join(root, "url-consumption", "app.js"),
      [
        'new URL("unconsumed.txt", import.meta.url);',
        'new Worker(new URL("inline-worker.js", import.meta.url));',
        'const target = new URL("one-hop.json", import.meta.url);',
        'fetch(target);',
      ].join("\n"),
    );
    await writeFile(join(root, "url-consumption", "unconsumed.txt"), "data");
    await writeFile(join(root, "url-consumption", "inline-worker.js"), "self.ready = true;");
    await writeFile(join(root, "url-consumption", "one-hop.json"), "{}");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "url-consumption",
    );

    expect(manifestOf(site)?.assets).not.toContain("url-consumption/unconsumed.txt");
    expect(manifestOf(site)?.assets).toContain("url-consumption/inline-worker.js");
    expect(manifestOf(site)?.assets).toContain("url-consumption/one-hop.json");
  });

  it("includes inline SVG image/use href and xlink:href references", async () => {
    await mkdir(join(root, "svg-href"), { recursive: true });
    await writeFile(
      join(root, "svg-href", "index.html"),
      [
        '<svg><image href="diagram.png"></image>',
        '<use xlink:href="icons.svg#mark"></use></svg>',
      ].join(""),
    );
    await writeFile(join(root, "svg-href", "diagram.png"), "image");
    await writeFile(join(root, "svg-href", "icons.svg"), "<svg></svg>");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "svg-href",
    );

    expect(manifestOf(site)?.assets).toContain("svg-href/diagram.png");
    expect(manifestOf(site)?.assets).toContain("svg-href/icons.svg");
  });

  it("excludes template content from both base selection and reference scanning", async () => {
    await mkdir(join(root, "template-inert"), { recursive: true });
    await mkdir(join(root, "template-inert", "private"), { recursive: true });
    await writeFile(
      join(root, "template-inert", "index.html"),
      [
        '<template><base href="/private/"><img src="template-image.png"></template>',
        '<script src="app.js"></script>',
      ].join(""),
    );
    await writeFile(join(root, "template-inert", "app.js"), "window.ready = true;");
    await writeFile(join(root, "template-inert", "template-image.png"), "image");
    await writeFile(join(root, "template-inert", "private", "app.js"), "wrong file");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "template-inert",
    );

    expect(manifestOf(site)?.assets).toContain("template-inert/app.js");
    expect(manifestOf(site)?.assets).not.toContain("template-inert/private/app.js");
    expect(manifestOf(site)?.assets).not.toContain("template-inert/template-image.png");
  });

  it("bounds a metadata file read and records a diagnostic instead of reading it unbounded", async () => {
    await mkdir(join(root, "huge-meta"), { recursive: true });
    await writeFile(join(root, "huge-meta", "index.html"), "<h1>Huge</h1>");
    await writeFile(
      join(root, "huge-meta", "package.json"),
      JSON.stringify({
        name: "huge",
        scripts: { dev: "vite" },
        padding: "x".repeat(2 * 1024 * 1024),
      }),
    );

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "huge-meta",
    );

    expect(site?.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "metadata-too-large" })]),
    );
    expect(site?.scripts).toEqual({});
  });

  it("refuses to share a manifest whose path exceeds the relay selector's character bound", async () => {
    const segment = "a".repeat(250);
    const nestedDir = join(root, "long-path", segment, segment, segment, segment, segment);
    await mkdir(nestedDir, { recursive: true });
    await writeFile(
      join(root, "long-path", "index.html"),
      `<script src="./${segment}/${segment}/${segment}/${segment}/${segment}/x.js"></script>`,
    );
    await writeFile(join(nestedDir, "x.js"), "window.ready = true;");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "long-path",
    );

    expect(site?.shareManifest).toMatchObject({
      ok: false,
      reason: "path-too-long",
      limitChars: 1024,
    });
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

  it("surfaces a configured preview mode without a static or build command", async () => {
    await mkdir(join(root, "configured-mode"), { recursive: true });
    await writeFile(join(root, "configured-mode", "index.html"), "<h1>Mode</h1>");
    await writeFile(
      join(root, "configured-mode", "package.json"),
      JSON.stringify({ scripts: { dev: "vite" } }),
    );
    await writeFile(
      join(root, "configured-mode", "dohc.json"),
      JSON.stringify({ type: "site", preview: { mode: "static" } }),
    );

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "configured-mode",
    );

    expect(site).toMatchObject({
      configuredPreviewMode: "static",
      configuredScripts: {},
    });
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

  it("keeps package script bodies separate from a configured package-manager wrapper", async () => {
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        scripts: {
          predev: "vite --host 0.0.0.0",
          dev: "vite --host 127.0.0.1",
        },
      }),
    );
    await writeFile(
      join(root, "dohc.json"),
      JSON.stringify({
        type: "site",
        preview: { mode: "dev", command: "npm run dev" },
      }),
    );
    await writeFile(join(root, "index.html"), "<h1>Configured</h1>");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === ".",
    );

    expect(site).toMatchObject({
      scripts: {
        predev: "vite --host 0.0.0.0",
        dev: "vite --host 127.0.0.1",
      },
      configuredScripts: { dev: "npm run dev" },
    });
  });

  it("drops an over-length package script (name or body) with a diagnostic instead of hiding the whole site", async () => {
    await mkdir(root, { recursive: true });
    const longName = "x".repeat(201);
    const longBody = `echo ${"y".repeat(10_000)}`;
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        scripts: {
          dev: "vite",
          [longName]: "echo short",
          "long-body": longBody,
        },
      }),
    );
    await writeFile(join(root, "index.html"), "<h1>Scripts</h1>");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === ".",
    );

    expect(site?.scripts).toEqual({ dev: "vite" });
    expect(site?.diagnostics).toContainEqual(
      expect.objectContaining({ code: "script-too-large" }),
    );
    expect(
      site?.diagnostics.filter((d) => d.code === "script-too-large"),
    ).toHaveLength(2);
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

  // ---- round-17 review pins ----

  it("does not fire a <source srcset> outside a <picture> parent", async () => {
    await mkdir(join(root, "source-srcset-guard"), { recursive: true });
    await writeFile(
      join(root, "source-srcset-guard", "index.html"),
      '<video><source srcset="inert.png"></video>',
    );
    await writeFile(join(root, "source-srcset-guard", "inert.png"), "private");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "source-srcset-guard",
    );

    expect(manifestOf(site)?.assets).not.toContain("source-srcset-guard/inert.png");
  });

  it("treats an import-map target resolving to an external URL as a terminal resolution, not a fall-through", async () => {
    await mkdir(join(root, "import-map-external"), { recursive: true });
    await writeFile(
      join(root, "import-map-external", "index.html"),
      [
        '<script type="importmap">{"imports": {"./module.js": "https://cdn.example/app.js"}}</script>',
        '<script type="module">import "./module.js";</script>',
      ].join(""),
    );
    await writeFile(join(root, "import-map-external", "module.js"), "private local file");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "import-map-external",
    );

    expect(manifestOf(site)?.assets).not.toContain("import-map-external/module.js");
  });

  it("keeps a scoped import map's own mapping reachable independently of the top-level map", async () => {
    await mkdir(join(root, "import-map-scope", "feature"), { recursive: true });
    await writeFile(
      join(root, "import-map-scope", "index.html"),
      [
        '<script type="importmap">',
        JSON.stringify({
          imports: { lib: "./from-top.js" },
          scopes: { "./feature/": { lib: "./from-scope.js" } },
        }),
        "</script>",
        '<script type="module">import "./feature/mod.js";</script>',
      ].join(""),
    );
    await writeFile(join(root, "import-map-scope", "from-top.js"), "export {};");
    await writeFile(join(root, "import-map-scope", "from-scope.js"), "export {};");
    await writeFile(
      join(root, "import-map-scope", "feature", "mod.js"),
      'import "lib";',
    );

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "import-map-scope",
    );

    expect(manifestOf(site)?.assets).toContain("import-map-scope/from-scope.js");
  });

  it("scans a shared script under each document's own scoped import map, not a cached result from the first", async () => {
    // Two documents reach the SAME relative script with the SAME top-level
    // import map but DIFFERENT scoped mappings for the module it imports —
    // if the scan-queue's dedupe fingerprint ignored scopes, the second
    // document's scan would be skipped as "already scanned", silently
    // dropping its own scope's dependency.
    await mkdir(join(root, "import-map-scope-fingerprint", "shared"), { recursive: true });
    await writeFile(
      join(root, "import-map-scope-fingerprint", "index.html"),
      [
        '<script type="importmap">',
        JSON.stringify({ scopes: { "./shared/": { lib: "./from-a.js" } } }),
        "</script>",
        '<script type="module">import "./shared/loader.js";</script>',
        '<iframe src="page2.html"></iframe>',
      ].join(""),
    );
    await writeFile(
      join(root, "import-map-scope-fingerprint", "page2.html"),
      [
        '<script type="importmap">',
        JSON.stringify({ scopes: { "./shared/": { lib: "./from-b.js" } } }),
        "</script>",
        '<script type="module">import "./shared/loader.js";</script>',
      ].join(""),
    );
    await writeFile(join(root, "import-map-scope-fingerprint", "shared", "loader.js"), 'import "lib";');
    await writeFile(join(root, "import-map-scope-fingerprint", "from-a.js"), "export {};");
    await writeFile(join(root, "import-map-scope-fingerprint", "from-b.js"), "export {};");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "import-map-scope-fingerprint",
    );

    expect(manifestOf(site)?.assets).toContain("import-map-scope-fingerprint/from-a.js");
    expect(manifestOf(site)?.assets).toContain("import-map-scope-fingerprint/from-b.js");
  });

  it("falls back to a parent scope when a deeper scope does not map the specifier", async () => {
    await mkdir(join(root, "import-map-parent-scope", "feature", "deep"), { recursive: true });
    await writeFile(
      join(root, "import-map-parent-scope", "index.html"),
      [
        '<script type="importmap">',
        JSON.stringify({
          scopes: {
            "./feature/": { lib: "./from-feature.js" },
            "./feature/deep/": {},
          },
        }),
        "</script>",
        '<script type="module">import "./feature/deep/mod.js";</script>',
      ].join(""),
    );
    await writeFile(join(root, "import-map-parent-scope", "from-feature.js"), "export {};");
    await writeFile(
      join(root, "import-map-parent-scope", "feature", "deep", "mod.js"),
      'import "lib";',
    );

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "import-map-parent-scope",
    );

    expect(manifestOf(site)?.assets).toContain("import-map-parent-scope/from-feature.js");
  });

  it("reads every image-set() candidate even when an earlier candidate has its own nested url()", async () => {
    await mkdir(join(root, "image-set-nested-url"), { recursive: true });
    await writeFile(
      join(root, "image-set-nested-url", "index.html"),
      '<style>div { background: image-set(url("one.png") 1x, "two.png" 2x); }</style>',
    );
    await writeFile(join(root, "image-set-nested-url", "one.png"), "one");
    await writeFile(join(root, "image-set-nested-url", "two.png"), "two");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "image-set-nested-url",
    );

    expect(manifestOf(site)?.assets).toContain("image-set-nested-url/one.png");
    expect(manifestOf(site)?.assets).toContain("image-set-nested-url/two.png");
  });

  it("excludes an importScripts() call from a module worker", async () => {
    await mkdir(join(root, "module-worker-import-scripts"), { recursive: true });
    await writeFile(
      join(root, "module-worker-import-scripts", "index.html"),
      '<script type="module">new Worker("worker.js", { type: "module" });</script>',
    );
    await writeFile(
      join(root, "module-worker-import-scripts", "worker.js"),
      'importScripts("private.js");',
    );
    await writeFile(join(root, "module-worker-import-scripts", "private.js"), "secret");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "module-worker-import-scripts",
    );

    expect(manifestOf(site)?.assets).not.toContain("module-worker-import-scripts/private.js");
  });

  it("does not count an XMLHttpRequest target until send() is called", async () => {
    await mkdir(join(root, "xhr-open-without-send"), { recursive: true });
    await writeFile(
      join(root, "xhr-open-without-send", "index.html"),
      [
        "<script>",
        "var xhr = new XMLHttpRequest();",
        'xhr.open("GET", "never-sent.json");',
        "</script>",
      ].join(""),
    );
    await writeFile(join(root, "xhr-open-without-send", "never-sent.json"), "secret");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "xhr-open-without-send",
    );

    expect(manifestOf(site)?.assets).not.toContain("xhr-open-without-send/never-sent.json");
  });

  it("counts an XMLHttpRequest target once send() is called on the same instance", async () => {
    await mkdir(join(root, "xhr-open-and-send"), { recursive: true });
    await writeFile(
      join(root, "xhr-open-and-send", "index.html"),
      [
        "<script>",
        "var xhr = new XMLHttpRequest();",
        'xhr.open("GET", "sent.json");',
        "xhr.send();",
        "</script>",
      ].join(""),
    );
    await writeFile(join(root, "xhr-open-and-send", "sent.json"), "public");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "xhr-open-and-send",
    );

    expect(manifestOf(site)?.assets).toContain("xhr-open-and-send/sent.json");
  });

  it("does not parse a fetch-only .css file's url()s as an applied stylesheet", async () => {
    await mkdir(join(root, "css-fetch-only"), { recursive: true });
    await writeFile(
      join(root, "css-fetch-only", "index.html"),
      '<script>fetch("data.css");</script>',
    );
    await writeFile(
      join(root, "css-fetch-only", "data.css"),
      'body { background: url("never-applied.png"); }',
    );
    await writeFile(join(root, "css-fetch-only", "never-applied.png"), "secret");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "css-fetch-only",
    );

    expect(manifestOf(site)?.assets).toContain("css-fetch-only/data.css");
    expect(manifestOf(site)?.assets).not.toContain("css-fetch-only/never-applied.png");
  });

  it("still parses a <link rel=stylesheet>'s url()s as an applied stylesheet", async () => {
    await mkdir(join(root, "css-applied-stylesheet"), { recursive: true });
    await writeFile(
      join(root, "css-applied-stylesheet", "index.html"),
      '<link rel="stylesheet" href="applied.css">',
    );
    await writeFile(
      join(root, "css-applied-stylesheet", "applied.css"),
      'body { background: url("applied.png"); }',
    );
    await writeFile(join(root, "css-applied-stylesheet", "applied.png"), "public");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "css-applied-stylesheet",
    );

    expect(manifestOf(site)?.assets).toContain("css-applied-stylesheet/applied.png");
  });

  // ---- round-18 review pins ----

  it("does not treat an image-set() type() MIME string as a URL candidate", async () => {
    await mkdir(join(root, "image-set-type-hint"), { recursive: true });
    await writeFile(
      join(root, "image-set-type-hint", "index.html"),
      '<style>div { background: image-set(url("hero.avif") type("image/avif") 1x); }</style>',
    );
    await writeFile(join(root, "image-set-type-hint", "hero.avif"), "public");
    await mkdir(join(root, "image-set-type-hint", "image"), { recursive: true });
    await writeFile(join(root, "image-set-type-hint", "image", "avif"), "private, coincidentally shaped like the type string");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "image-set-type-hint",
    );

    expect(manifestOf(site)?.assets).toContain("image-set-type-hint/hero.avif");
    expect(manifestOf(site)?.assets).not.toContain("image-set-type-hint/image/avif");
  });

  it("counts an XHR target when send() is visited before open() in AST source order", async () => {
    await mkdir(join(root, "xhr-source-order"), { recursive: true });
    await writeFile(
      join(root, "xhr-source-order", "index.html"),
      [
        "<script>",
        "var xhr = new XMLHttpRequest();",
        "function issue() { xhr.send(); }",
        'xhr.open("GET", "data.json");',
        "issue();",
        "</script>",
      ].join(""),
    );
    await writeFile(join(root, "xhr-source-order", "data.json"), "public");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "xhr-source-order",
    );

    expect(manifestOf(site)?.assets).toContain("xhr-source-order/data.json");
  });

  it("expands an SVG loaded as a document (<object data>) for its own <image>/<use> references", async () => {
    await mkdir(join(root, "svg-object-document"), { recursive: true });
    await writeFile(
      join(root, "svg-object-document", "index.html"),
      '<object data="diagram.svg"></object>',
    );
    await writeFile(
      join(root, "svg-object-document", "diagram.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="asset.png"/></svg>',
    );
    await writeFile(join(root, "svg-object-document", "asset.png"), "public");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "svg-object-document",
    );

    expect(manifestOf(site)?.assets).toContain("svg-object-document/asset.png");
  });

  it("leaves an SVG loaded only as an image (<img src>) unexpanded", async () => {
    await mkdir(join(root, "svg-img-only"), { recursive: true });
    await writeFile(
      join(root, "svg-img-only", "index.html"),
      '<img src="icon.svg">',
    );
    await writeFile(
      join(root, "svg-img-only", "icon.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="hidden.png"/></svg>',
    );
    await writeFile(join(root, "svg-img-only", "hidden.png"), "private");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "svg-img-only",
    );

    expect(manifestOf(site)?.assets).toContain("svg-img-only/icon.svg");
    expect(manifestOf(site)?.assets).not.toContain("svg-img-only/hidden.png");
  });

  it("does not approve a script a document's own meta CSP blocks with script-src 'none'", async () => {
    await mkdir(join(root, "csp-script-none"), { recursive: true });
    await writeFile(
      join(root, "csp-script-none", "index.html"),
      [
        '<meta http-equiv="Content-Security-Policy" content="script-src \'none\'">',
        '<script src="private.js"></script>',
      ].join(""),
    );
    await writeFile(join(root, "csp-script-none", "private.js"), "console.log(1)");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "csp-script-none",
    );

    expect(manifestOf(site)?.assets).not.toContain("csp-script-none/private.js");
  });

  it("does not let a CSP-blocked class suppress an UNRELATED class's resources", async () => {
    await mkdir(join(root, "csp-script-none-img-ok"), { recursive: true });
    await writeFile(
      join(root, "csp-script-none-img-ok", "index.html"),
      [
        '<meta http-equiv="Content-Security-Policy" content="script-src \'none\'">',
        '<script src="private.js"></script>',
        '<img src="ok.png">',
      ].join(""),
    );
    await writeFile(join(root, "csp-script-none-img-ok", "private.js"), "console.log(1)");
    await writeFile(join(root, "csp-script-none-img-ok", "ok.png"), "public");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "csp-script-none-img-ok",
    );

    expect(manifestOf(site)?.assets).not.toContain("csp-script-none-img-ok/private.js");
    expect(manifestOf(site)?.assets).toContain("csp-script-none-img-ok/ok.png");
  });

  it("approves a script normally when the document declares no CSP at all", async () => {
    await mkdir(join(root, "no-csp"), { recursive: true });
    await writeFile(join(root, "no-csp", "index.html"), '<script src="a.js"></script>');
    await writeFile(join(root, "no-csp", "a.js"), "console.log(1)");

    const site = (await listSitePackages(root)).find((candidate) => candidate.root === "no-csp");

    expect(manifestOf(site)?.assets).toContain("no-csp/a.js");
  });

  // ---- round-19 review pins ----

  it("keeps only the most recently opened XHR target when a receiver re-opens before it sends", async () => {
    await mkdir(join(root, "xhr-reopen"), { recursive: true });
    await writeFile(
      join(root, "xhr-reopen", "index.html"),
      [
        "<script>",
        "var xhr = new XMLHttpRequest();",
        'xhr.open("GET", "private.json");',
        'xhr.open("GET", "public.json");',
        "xhr.send();",
        "</script>",
      ].join(""),
    );
    await writeFile(join(root, "xhr-reopen", "private.json"), "secret");
    await writeFile(join(root, "xhr-reopen", "public.json"), "public");

    const site = (await listSitePackages(root)).find((candidate) => candidate.root === "xhr-reopen");

    expect(manifestOf(site)?.assets).toContain("xhr-reopen/public.json");
    expect(manifestOf(site)?.assets).not.toContain("xhr-reopen/private.json");
  });

  it("does not treat a class named XMLHttpRequest as the real global", async () => {
    await mkdir(join(root, "xhr-shadowed"), { recursive: true });
    await writeFile(
      join(root, "xhr-shadowed", "index.html"),
      [
        "<script>",
        "class XMLHttpRequest { open() {} send() {} }",
        "var xhr = new XMLHttpRequest();",
        'xhr.open("GET", "private.json");',
        "xhr.send();",
        "</script>",
      ].join(""),
    );
    await writeFile(join(root, "xhr-shadowed", "private.json"), "secret");

    const site = (await listSitePackages(root)).find((candidate) => candidate.root === "xhr-shadowed");

    expect(manifestOf(site)?.assets).not.toContain("xhr-shadowed/private.json");
  });

  it("leaves an @font-face url() unclassified so an img-src 'none' policy does not remove it", async () => {
    await mkdir(join(root, "css-font-face"), { recursive: true });
    await writeFile(
      join(root, "css-font-face", "index.html"),
      [
        '<meta http-equiv="Content-Security-Policy" content="img-src \'none\'; font-src \'self\'">',
        '<style>@font-face { font-family: "Body"; src: url("font.woff2"); }</style>',
      ].join(""),
    );
    await writeFile(join(root, "css-font-face", "font.woff2"), "font");

    const site = (await listSitePackages(root)).find((candidate) => candidate.root === "css-font-face");

    expect(manifestOf(site)?.assets).toContain("css-font-face/font.woff2");
  });

  it("does not corrupt an image-set() candidate whose own text contains type(", async () => {
    await mkdir(join(root, "image-set-type-in-candidate"), { recursive: true });
    await writeFile(
      join(root, "image-set-type-in-candidate", "index.html"),
      "<style>div { background: image-set(\"icons/type('dark').png\" 1x); }</style>",
    );
    await mkdir(join(root, "image-set-type-in-candidate", "icons"), { recursive: true });
    await writeFile(
      join(root, "image-set-type-in-candidate", "icons", "type('dark').png"),
      "public",
    );

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "image-set-type-in-candidate",
    );

    expect(manifestOf(site)?.assets).toContain("image-set-type-in-candidate/icons/type('dark').png");
  });

  it("does not parse fetch-only HTML as an active document", async () => {
    await mkdir(join(root, "fetch-only-html"), { recursive: true });
    await writeFile(
      join(root, "fetch-only-html", "index.html"),
      '<script>fetch("template.html");</script>',
    );
    await writeFile(
      join(root, "fetch-only-html", "template.html"),
      '<img src="private.png">',
    );
    await writeFile(join(root, "fetch-only-html", "private.png"), "secret");

    const site = (await listSitePackages(root)).find((candidate) => candidate.root === "fetch-only-html");

    expect(manifestOf(site)?.assets).toContain("fetch-only-html/template.html");
    expect(manifestOf(site)?.assets).not.toContain("fetch-only-html/private.png");
  });

  it("still expands an HTML page reached via <a href> navigation", async () => {
    await mkdir(join(root, "anchor-navigation"), { recursive: true });
    await writeFile(
      join(root, "anchor-navigation", "index.html"),
      '<a href="page.html">Go</a>',
    );
    await writeFile(
      join(root, "anchor-navigation", "page.html"),
      '<img src="asset.png">',
    );
    await writeFile(join(root, "anchor-navigation", "asset.png"), "public");

    const site = (await listSitePackages(root)).find((candidate) => candidate.root === "anchor-navigation");

    expect(manifestOf(site)?.assets).toContain("anchor-navigation/asset.png");
  });

  it("does not follow formaction on a submit control with no owning form", async () => {
    await mkdir(join(root, "formaction-no-owner"), { recursive: true });
    await writeFile(
      join(root, "formaction-no-owner", "index.html"),
      '<button type="submit" formaction="private.html">Send</button>',
    );
    await writeFile(join(root, "formaction-no-owner", "private.html"), "<h1>Private</h1>");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "formaction-no-owner",
    );

    expect(manifestOf(site)?.assets).not.toContain("formaction-no-owner/private.html");
  });

  it("follows formaction on a submit control owned via a form= attribute naming a form declared later", async () => {
    await mkdir(join(root, "formaction-form-attr"), { recursive: true });
    await writeFile(
      join(root, "formaction-form-attr", "index.html"),
      [
        '<button type="submit" form="checkout" formaction="confirm.html">Send</button>',
        '<form id="checkout"></form>',
      ].join(""),
    );
    await writeFile(join(root, "formaction-form-attr", "confirm.html"), "<h1>Confirm</h1>");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "formaction-form-attr",
    );

    expect(manifestOf(site)?.assets).toContain("formaction-form-attr/confirm.html");
  });

  it("does not approve a detached script's src before it is inserted into the document", async () => {
    await mkdir(join(root, "detached-script"), { recursive: true });
    await writeFile(
      join(root, "detached-script", "index.html"),
      '<script src="app.js"></script>',
    );
    await writeFile(
      join(root, "detached-script", "app.js"),
      [
        'const script = document.createElement("script");',
        'script.src = "private.js";',
        // Never inserted anywhere — document.createElement alone never
        // connects it to the document, so this request never fires.
      ].join("\n"),
    );
    await writeFile(join(root, "detached-script", "private.js"), "console.log(1)");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "detached-script",
    );

    expect(manifestOf(site)?.assets).not.toContain("detached-script/private.js");
  });

  it("approves a script's src once it is proven inserted into the document", async () => {
    await mkdir(join(root, "inserted-script"), { recursive: true });
    await writeFile(
      join(root, "inserted-script", "index.html"),
      '<script src="app.js"></script>',
    );
    await writeFile(
      join(root, "inserted-script", "app.js"),
      [
        'const script = document.createElement("script");',
        "document.body.appendChild(script);",
        'script.src = "loaded.js";',
      ].join("\n"),
    );
    await writeFile(join(root, "inserted-script", "loaded.js"), "console.log(1)");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "inserted-script",
    );

    expect(manifestOf(site)?.assets).toContain("inserted-script/loaded.js");
  });

  it("approves a script's src once inserted via document.documentElement, the same as document.body", async () => {
    await mkdir(join(root, "inserted-via-document-element"), { recursive: true });
    await writeFile(
      join(root, "inserted-via-document-element", "index.html"),
      '<script src="app.js"></script>',
    );
    await writeFile(
      join(root, "inserted-via-document-element", "app.js"),
      [
        'const script = document.createElement("script");',
        // document.documentElement (<html>) is exactly as always-attached
        // as document.body/document.head — a real browser connects and
        // fetches this the same way it would via document.body.
        "document.documentElement.appendChild(script);",
        'script.src = "loaded.js";',
      ].join("\n"),
    );
    await writeFile(join(root, "inserted-via-document-element", "loaded.js"), "console.log(1)");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "inserted-via-document-element",
    );

    expect(manifestOf(site)?.assets).toContain("inserted-via-document-element/loaded.js");
  });

  it("applies the document's CSP to an external stylesheet's own url() references", async () => {
    await mkdir(join(root, "csp-external-stylesheet"), { recursive: true });
    await writeFile(
      join(root, "csp-external-stylesheet", "index.html"),
      [
        '<meta http-equiv="Content-Security-Policy" content="img-src \'none\'; style-src \'self\'">',
        '<link rel="stylesheet" href="style.css">',
      ].join(""),
    );
    await writeFile(
      join(root, "csp-external-stylesheet", "style.css"),
      'body { background: url("private.png"); }',
    );
    await writeFile(join(root, "csp-external-stylesheet", "private.png"), "secret");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "csp-external-stylesheet",
    );

    expect(manifestOf(site)?.assets).toContain("csp-external-stylesheet/style.css");
    expect(manifestOf(site)?.assets).not.toContain("csp-external-stylesheet/private.png");
  });

  it("does not retroactively remove a reference requested before its own blocking meta CSP", async () => {
    await mkdir(join(root, "csp-document-order"), { recursive: true });
    await writeFile(
      join(root, "csp-document-order", "index.html"),
      [
        '<script src="early.js"></script>',
        '<meta http-equiv="Content-Security-Policy" content="script-src \'none\'">',
        '<script src="late.js"></script>',
      ].join(""),
    );
    await writeFile(join(root, "csp-document-order", "early.js"), "console.log('early')");
    await writeFile(join(root, "csp-document-order", "late.js"), "console.log('late')");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "csp-document-order",
    );

    // Chromium already requested early.js before it ever saw the policy —
    // the published artifact must not omit a resource the preview used.
    expect(manifestOf(site)?.assets).toContain("csp-document-order/early.js");
    expect(manifestOf(site)?.assets).not.toContain("csp-document-order/late.js");
  });

  // ---- round-20 review pins ----

  it("does not scan an inline script's own dependencies when script-src blocks it entirely", async () => {
    await mkdir(join(root, "csp-inline-script-blocked"), { recursive: true });
    await writeFile(
      join(root, "csp-inline-script-blocked", "index.html"),
      [
        '<meta http-equiv="Content-Security-Policy" content="script-src \'none\'; connect-src \'self\'">',
        '<script>fetch("private.json");</script>',
      ].join(""),
    );
    await writeFile(join(root, "csp-inline-script-blocked", "private.json"), "secret");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "csp-inline-script-blocked",
    );

    expect(manifestOf(site)?.assets).not.toContain("csp-inline-script-blocked/private.json");
  });

  it("does not scan an inline style block's own dependencies when style-src blocks it entirely", async () => {
    await mkdir(root + "/csp-inline-style-blocked", { recursive: true });
    await writeFile(
      join(root, "csp-inline-style-blocked", "index.html"),
      [
        '<meta http-equiv="Content-Security-Policy" content="style-src \'none\'; img-src \'self\'">',
        '<style>div { background: url("private.png"); }</style>',
      ].join(""),
    );
    await writeFile(join(root, "csp-inline-style-blocked", "private.png"), "secret");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "csp-inline-style-blocked",
    );

    expect(manifestOf(site)?.assets).not.toContain("csp-inline-style-blocked/private.png");
  });

  it("pairs an XHR send with the open target active at that point, not the last open anywhere", async () => {
    await mkdir(join(root, "xhr-send-then-reopen"), { recursive: true });
    await writeFile(
      join(root, "xhr-send-then-reopen", "index.html"),
      [
        "<script>",
        "var xhr = new XMLHttpRequest();",
        'xhr.open("GET", "public.json");',
        "xhr.send();",
        'xhr.open("GET", "private.json");',
        "</script>",
      ].join(""),
    );
    await writeFile(join(root, "xhr-send-then-reopen", "public.json"), "public");
    await writeFile(join(root, "xhr-send-then-reopen", "private.json"), "secret");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "xhr-send-then-reopen",
    );

    expect(manifestOf(site)?.assets).toContain("xhr-send-then-reopen/public.json");
    expect(manifestOf(site)?.assets).not.toContain("xhr-send-then-reopen/private.json");
  });

  it("still resolves an XHR send() visited before its open() due to a hoisted function declaration", async () => {
    await mkdir(join(root, "xhr-hoisted-send"), { recursive: true });
    await writeFile(
      join(root, "xhr-hoisted-send", "index.html"),
      [
        "<script>",
        "var xhr = new XMLHttpRequest();",
        "function issue() { xhr.send(); }",
        'xhr.open("GET", "data.json");',
        "issue();",
        "</script>",
      ].join(""),
    );
    await writeFile(join(root, "xhr-hoisted-send", "data.json"), "public");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "xhr-hoisted-send",
    );

    expect(manifestOf(site)?.assets).toContain("xhr-hoisted-send/data.json");
  });

  it("classifies a preload as=image target under img-src", async () => {
    await mkdir(root + "/csp-preload-image", { recursive: true });
    await writeFile(
      join(root, "csp-preload-image", "index.html"),
      [
        '<meta http-equiv="Content-Security-Policy" content="img-src \'none\'">',
        '<link rel="preload" as="image" href="private.png">',
      ].join(""),
    );
    await writeFile(join(root, "csp-preload-image", "private.png"), "secret");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "csp-preload-image",
    );

    expect(manifestOf(site)?.assets).not.toContain("csp-preload-image/private.png");
  });

  it("resets the inherited document CSP for an external worker's own policy context", async () => {
    await mkdir(root + "/csp-worker-reset", { recursive: true });
    await writeFile(
      join(root, "csp-worker-reset", "index.html"),
      [
        '<meta http-equiv="Content-Security-Policy" content="connect-src \'none\'; worker-src \'self\'">',
        '<script>new Worker("worker.js");</script>',
      ].join(""),
    );
    await writeFile(
      join(root, "csp-worker-reset", "worker.js"),
      'fetch("data.json");',
    );
    await writeFile(join(root, "csp-worker-reset", "data.json"), "public");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "csp-worker-reset",
    );

    expect(manifestOf(site)?.assets).toContain("csp-worker-reset/data.json");
  });

  it("skips a nomodule script's src on this module-capable runtime", async () => {
    await mkdir(root + "/nomodule-skipped", { recursive: true });
    await writeFile(
      join(root, "nomodule-skipped", "index.html"),
      '<script nomodule src="private.js"></script>',
    );
    await writeFile(join(root, "nomodule-skipped", "private.js"), "console.log(1)");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "nomodule-skipped",
    );

    expect(manifestOf(site)?.assets).not.toContain("nomodule-skipped/private.js");
  });

  it("skips a nomodule inline script's own dependencies on this module-capable runtime", async () => {
    await mkdir(root + "/nomodule-inline-skipped", { recursive: true });
    await writeFile(
      join(root, "nomodule-inline-skipped", "index.html"),
      '<script nomodule>fetch("private.json");</script>',
    );
    await writeFile(join(root, "nomodule-inline-skipped", "private.json"), "secret");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "nomodule-inline-skipped",
    );

    expect(manifestOf(site)?.assets).not.toContain("nomodule-inline-skipped/private.json");
  });

  it("still approves a classic script with no nomodule attribute", async () => {
    await mkdir(root + "/module-attr-present", { recursive: true });
    await writeFile(
      join(root, "module-attr-present", "index.html"),
      '<script src="app.js"></script>',
    );
    await writeFile(join(root, "module-attr-present", "app.js"), "console.log(1)");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "module-attr-present",
    );

    expect(manifestOf(site)?.assets).toContain("module-attr-present/app.js");
  });

  it("scans the same external stylesheet independently for two documents under different CSPs", async () => {
    await mkdir(join(root, "csp-dedup-key"), { recursive: true });
    await writeFile(
      join(root, "csp-dedup-key", "index.html"),
      [
        '<meta http-equiv="Content-Security-Policy" content="img-src \'none\'">',
        '<link rel="stylesheet" href="style.css">',
        '<iframe src="page2.html"></iframe>',
      ].join(""),
    );
    await writeFile(
      join(root, "csp-dedup-key", "page2.html"),
      '<link rel="stylesheet" href="style.css">',
    );
    await writeFile(
      join(root, "csp-dedup-key", "style.css"),
      'body { background: url("shared.png"); }',
    );
    await writeFile(join(root, "csp-dedup-key", "shared.png"), "public");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "csp-dedup-key",
    );

    // page2.html has no CSP of its own, so its own scan of style.css must
    // still approve shared.png even though index.html's img-src 'none'
    // scan of the SAME file (same path, same directory) filtered it out.
    expect(manifestOf(site)?.assets).toContain("csp-dedup-key/shared.png");
  });

  it("shares the source entry for a static site with a leftover build-output directory, when previewed as static", async () => {
    await mkdir(join(root, "stale-dist", "dist"), { recursive: true });
    await writeFile(join(root, "stale-dist", "index.html"), "<h1>Source</h1>");
    // A leftover build from an earlier session — buildOutputs still
    // detects it, but the site is genuinely static and IS being
    // previewed as static right now.
    await writeFile(join(root, "stale-dist", "dist", "index.html"), "<h1>Stale build</h1>");

    const noOverride = await getSitePackage(root, "stale-dist");
    expect(noOverride?.shareManifest.ok).toBe(true);
    if (noOverride?.shareManifest.ok) {
      expect(noOverride.shareManifest.manifest.entryPath).toBe("stale-dist/dist/index.html");
    }

    const withStaticMode = await getSitePackage(root, "stale-dist", undefined, "static");
    expect(withStaticMode?.shareManifest.ok).toBe(true);
    if (withStaticMode?.shareManifest.ok) {
      expect(withStaticMode.shareManifest.manifest.entryPath).toBe("stale-dist/index.html");
    }
  });

  it("shares the source entry for a package site with no config pin, when the user manually selected static", async () => {
    await mkdir(join(root, "manual-static", "dist"), { recursive: true });
    await writeFile(join(root, "manual-static", "index.html"), "<h1>Source</h1>");
    await writeFile(join(root, "manual-static", "dist", "index.html"), "<h1>Built</h1>");
    await writeFile(
      join(root, "manual-static", "package.json"),
      JSON.stringify({ scripts: { dev: "vite", build: "vite build" } }),
    );

    const withoutMode = await getSitePackage(root, "manual-static");
    expect(withoutMode?.shareManifest.ok).toBe(true);
    if (withoutMode?.shareManifest.ok) {
      expect(withoutMode.shareManifest.manifest.entryPath).toBe("manual-static/dist/index.html");
    }

    const withManualStatic = await getSitePackage(root, "manual-static", undefined, "static");
    expect(withManualStatic?.shareManifest.ok).toBe(true);
    if (withManualStatic?.shareManifest.ok) {
      expect(withManualStatic.shareManifest.manifest.entryPath).toBe("manual-static/index.html");
    }
  });

  // ---- round-21 review pins ----

  it("declines an XHR send when its receiver opens two distinct targets and walk order can't disambiguate it", async () => {
    await mkdir(join(root, "xhr-ambiguous-open"), { recursive: true });
    await writeFile(
      join(root, "xhr-ambiguous-open", "index.html"),
      [
        "<script>",
        "var xhr = new XMLHttpRequest();",
        "function issue() { xhr.send(); }",
        'xhr.open("GET", "public.json");',
        "issue();",
        'xhr.open("GET", "private.json");',
        "</script>",
      ].join(""),
    );
    await writeFile(join(root, "xhr-ambiguous-open", "public.json"), "public");
    await writeFile(join(root, "xhr-ambiguous-open", "private.json"), "secret");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "xhr-ambiguous-open",
    );

    // The hoisted send() runs before either open() textually, and the
    // receiver opens two DIFFERENT targets elsewhere in the file — no
    // walk-order bookkeeping proves which one this send() actually paired
    // with at runtime, so neither is approved.
    expect(manifestOf(site)?.assets).not.toContain("xhr-ambiguous-open/public.json");
    expect(manifestOf(site)?.assets).not.toContain("xhr-ambiguous-open/private.json");
  });

  it("does not scan an inline script's own dependencies when CSP permits external scripts but not inline execution", async () => {
    await mkdir(join(root, "csp-inline-script-not-unsafe-inline"), { recursive: true });
    await writeFile(
      join(root, "csp-inline-script-not-unsafe-inline", "index.html"),
      [
        '<meta http-equiv="Content-Security-Policy" content="script-src \'self\'; connect-src \'self\'">',
        '<script>fetch("private.json");</script>',
      ].join(""),
    );
    await writeFile(join(root, "csp-inline-script-not-unsafe-inline", "private.json"), "secret");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "csp-inline-script-not-unsafe-inline",
    );

    // script-src 'self' permits an EXTERNAL same-origin script file, but a
    // real browser still blocks this INLINE script from executing at all
    // (no 'unsafe-inline'/nonce/hash) — its fetch() never fires.
    expect(manifestOf(site)?.assets).not.toContain(
      "csp-inline-script-not-unsafe-inline/private.json",
    );
  });

  it("does not treat the mere presence of a nonce source as class-wide permission for an un-nonced script", async () => {
    await mkdir(join(root, "csp-nonce-mismatch"), { recursive: true });
    await writeFile(
      join(root, "csp-nonce-mismatch", "index.html"),
      [
        '<meta http-equiv="Content-Security-Policy" content="script-src \'nonce-approved\'; connect-src \'self\'">',
        '<script>fetch("private.json");</script>',
      ].join(""),
    );
    await writeFile(join(root, "csp-nonce-mismatch", "private.json"), "secret");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "csp-nonce-mismatch",
    );

    // A source list carrying a nonce-source permits ONLY an element whose
    // OWN nonce attribute matches it — a script with no nonce attribute at
    // all is still blocked, the same way it would be under a plain
    // script-src 'self' with no nonce/hash present at all.
    expect(manifestOf(site)?.assets).not.toContain("csp-nonce-mismatch/private.json");
  });

  it("scans an inline script whose own nonce attribute matches the policy's nonce source", async () => {
    await mkdir(join(root, "csp-nonce-match"), { recursive: true });
    await writeFile(
      join(root, "csp-nonce-match", "index.html"),
      [
        '<meta http-equiv="Content-Security-Policy" content="script-src \'nonce-approved\'; connect-src \'self\'">',
        '<script nonce="approved">fetch("public.json");</script>',
      ].join(""),
    );
    await writeFile(join(root, "csp-nonce-match", "public.json"), "data");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "csp-nonce-match",
    );

    expect(manifestOf(site)?.assets).toContain("csp-nonce-match/public.json");
  });

  it("scans an inline style whose own content hash matches the policy's hash source", async () => {
    await mkdir(join(root, "csp-hash-match"), { recursive: true });
    const styleText = 'body{background:url("public.png")}';
    const digest = createHash("sha256").update(styleText, "utf8").digest("base64");
    await writeFile(
      join(root, "csp-hash-match", "index.html"),
      [
        `<meta http-equiv="Content-Security-Policy" content="style-src 'sha256-${digest}'; img-src 'self'">`,
        `<style>${styleText}</style>`,
      ].join(""),
    );
    await writeFile(join(root, "csp-hash-match", "public.png"), "img");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "csp-hash-match",
    );

    expect(manifestOf(site)?.assets).toContain("csp-hash-match/public.png");
  });

  it("does not permit an inline event handler via a hash source without 'unsafe-hashes'", async () => {
    await mkdir(join(root, "csp-handler-hash-no-unsafe-hashes"), { recursive: true });
    const handlerText = 'fetch("private.json")';
    const digest = createHash("sha256").update(handlerText, "utf8").digest("base64");
    await writeFile(
      join(root, "csp-handler-hash-no-unsafe-hashes", "index.html"),
      [
        `<meta http-equiv="Content-Security-Policy" content="script-src 'sha256-${digest}'; connect-src 'self'">`,
        `<button onclick='${handlerText}'>go</button>`,
      ].join(""),
    );
    await writeFile(join(root, "csp-handler-hash-no-unsafe-hashes", "private.json"), "secret");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "csp-handler-hash-no-unsafe-hashes",
    );

    // A hash-source only covers an on* handler's own value when the list
    // ALSO carries 'unsafe-hashes' (CSP3) — a nonce never applies to an
    // attribute at all, since an attribute is never itself an element with
    // a nonce of its own.
    expect(manifestOf(site)?.assets).not.toContain(
      "csp-handler-hash-no-unsafe-hashes/private.json",
    );
  });

  it("permits an inline event handler via a hash source once 'unsafe-hashes' is present", async () => {
    await mkdir(join(root, "csp-handler-hash-unsafe-hashes"), { recursive: true });
    const handlerText = 'fetch("public.json")';
    const digest = createHash("sha256").update(handlerText, "utf8").digest("base64");
    await writeFile(
      join(root, "csp-handler-hash-unsafe-hashes", "index.html"),
      [
        `<meta http-equiv="Content-Security-Policy" content="script-src 'unsafe-hashes' 'sha256-${digest}'; connect-src 'self'">`,
        `<button onclick='${handlerText}'>go</button>`,
      ].join(""),
    );
    await writeFile(join(root, "csp-handler-hash-unsafe-hashes", "public.json"), "data");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "csp-handler-hash-unsafe-hashes",
    );

    expect(manifestOf(site)?.assets).toContain("csp-handler-hash-unsafe-hashes/public.json");
  });

  it("ignores 'unsafe-inline' once the source list also carries a nonce source, even for content neither can satisfy", async () => {
    await mkdir(join(root, "csp-unsafe-inline-ignored"), { recursive: true });
    await writeFile(
      join(root, "csp-unsafe-inline-ignored", "index.html"),
      [
        '<meta http-equiv="Content-Security-Policy" content="script-src \'unsafe-inline\' \'nonce-approved\'; connect-src \'self\'">',
        '<button onclick=\'fetch("private.json")\'>go</button>',
      ].join(""),
    );
    await writeFile(join(root, "csp-unsafe-inline-ignored", "private.json"), "secret");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "csp-unsafe-inline-ignored",
    );

    // Per CSP2+, 'unsafe-inline' is ignored entirely once a nonce- or
    // hash-source is ALSO present — even for an on* handler, which neither
    // a nonce (attributes have none) nor this list's hash-less nonce
    // source can ever cover.
    expect(manifestOf(site)?.assets).not.toContain(
      "csp-unsafe-inline-ignored/private.json",
    );
  });

  it("keeps a reference an inline script already requested before a later meta CSP blocks its class", async () => {
    await mkdir(join(root, "csp-inline-block-order"), { recursive: true });
    await writeFile(
      join(root, "csp-inline-block-order", "index.html"),
      [
        '<script>fetch("needed.json");</script>',
        '<meta http-equiv="Content-Security-Policy" content="connect-src \'none\'">',
      ].join(""),
    );
    await writeFile(join(root, "csp-inline-block-order", "needed.json"), "data");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "csp-inline-block-order",
    );

    // The script block ran and started its fetch BEFORE the later meta
    // tag's connect-src 'none' took effect — filtering it against the
    // document's FINAL CSP state would wrongly remove it.
    expect(manifestOf(site)?.assets).toContain("csp-inline-block-order/needed.json");
  });

  it("classifies a preload as=worker target under worker-src", async () => {
    await mkdir(join(root, "csp-preload-worker"), { recursive: true });
    await writeFile(
      join(root, "csp-preload-worker", "index.html"),
      [
        '<meta http-equiv="Content-Security-Policy" content="worker-src \'none\'">',
        '<link rel="preload" as="worker" href="private.js">',
      ].join(""),
    );
    await writeFile(join(root, "csp-preload-worker", "private.js"), "secret");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "csp-preload-worker",
    );

    expect(manifestOf(site)?.assets).not.toContain("csp-preload-worker/private.js");
  });

  it("classifies an unquoted @import url() target as a stylesheet, not the generic CSS url() default", async () => {
    await mkdir(join(root, "css-import-unquoted"), { recursive: true });
    await writeFile(
      join(root, "css-import-unquoted", "index.html"),
      [
        '<meta http-equiv="Content-Security-Policy" content="img-src \'none\'; style-src \'self\'">',
        '<link rel="stylesheet" href="style.css">',
      ].join(""),
    );
    await writeFile(
      join(root, "css-import-unquoted", "style.css"),
      "@import url(theme.css);",
    );
    await writeFile(join(root, "css-import-unquoted", "theme.css"), "body {}");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "css-import-unquoted",
    );

    // theme.css must be classified "style" (permitted by style-src 'self')
    // rather than falling through to CSS_URL_PATTERN's generic "img"
    // classification, which img-src 'none' would wrongly block.
    expect(manifestOf(site)?.assets).toContain("css-import-unquoted/theme.css");
  });

  it("does not let @import's own url() also match the generic CSS pattern under a different, wrongly-permissive class", async () => {
    await mkdir(join(root, "css-import-not-double-matched"), { recursive: true });
    await writeFile(
      join(root, "css-import-not-double-matched", "index.html"),
      [
        // The <link> is reached BEFORE the later meta CSP — it's approved
        // under the permissive state active at THAT point in document
        // order, and style.css itself is queued and scanned regardless.
        // Its OWN discovered references are then filtered against the
        // document's FINAL policy (style-src 'none', img-src 'self') —
        // exactly the ordering a link-then-restrict document produces.
        '<link rel="stylesheet" href="style.css">',
        '<meta http-equiv="Content-Security-Policy" content="img-src \'self\'; style-src \'none\'">',
      ].join(""),
    );
    await writeFile(
      join(root, "css-import-not-double-matched", "style.css"),
      "@import url(theme.css);",
    );
    await writeFile(join(root, "css-import-not-double-matched", "theme.css"), "body {}");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "css-import-not-double-matched",
    );

    // @import's own url(...) call ALSO matches the generic CSS_URL_PATTERN
    // pass — without excluding that span, the same target mints a SECOND
    // reference classified "img" (permitted here) alongside the correctly
    // classified "style" one (blocked here), and the img-classified
    // duplicate would silently survive filtering even though a real
    // browser's style-src 'none' blocks the whole @import.
    expect(manifestOf(site)?.assets).toContain("css-import-not-double-matched/style.css");
    expect(manifestOf(site)?.assets).not.toContain(
      "css-import-not-double-matched/theme.css",
    );
  });

  it("locks a specifier to its first resolution across the document, so a later import map cannot remap it", async () => {
    await mkdir(join(root, "locked-specifier-keys"), { recursive: true });
    await writeFile(
      join(root, "locked-specifier-keys", "index.html"),
      [
        // "./dep.js" resolves NATURALLY here — no import map is active yet,
        // so a real browser's module map already remembers this specifier's
        // target before the importmap tag below is even parsed.
        '<script type="module">import "./dep.js";</script>',
        // Tries to remap the ALREADY-resolved specifier — a real browser
        // ignores this for anything reached from this point on too.
        '<script type="importmap">{"imports": {"./dep.js": "./private.js"}}</script>',
        // Reaches "./dep.js" again — must resolve the SAME way as the
        // first script, not pick up the new remap.
        '<script type="module">import "./dep.js";</script>',
      ].join(""),
    );
    await writeFile(join(root, "locked-specifier-keys", "dep.js"), "export {};");
    await writeFile(join(root, "locked-specifier-keys", "private.js"), "private file");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "locked-specifier-keys",
    );

    expect(manifestOf(site)?.assets).toContain("locked-specifier-keys/dep.js");
    expect(manifestOf(site)?.assets).not.toContain("locked-specifier-keys/private.js");
  });

  it("rejects a syntactically invalid nonce-source token even when it textually matches an equally malformed nonce attribute", async () => {
    await mkdir(join(root, "csp-nonce-invalid"), { recursive: true });
    await writeFile(
      join(root, "csp-nonce-invalid", "index.html"),
      [
        '<meta http-equiv="Content-Security-Policy" content="script-src \'nonce-!!!\'; connect-src \'self\'">',
        '<script nonce="!!!">fetch("private.json");</script>',
      ].join(""),
    );
    await writeFile(join(root, "csp-nonce-invalid", "private.json"), "secret");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "csp-nonce-invalid",
    );

    // '!!!' is not valid CSP base64-value grammar — a real browser drops the
    // whole nonce-source token as syntactically invalid rather than treating
    // it as a wildcard any equally malformed nonce attribute could satisfy.
    expect(manifestOf(site)?.assets).not.toContain("csp-nonce-invalid/private.json");
  });

  it("treats a CSP directive present with no source expressions as blocking, the same as an explicit 'none'", async () => {
    await mkdir(join(root, "csp-empty-source-list"), { recursive: true });
    await writeFile(
      join(root, "csp-empty-source-list", "index.html"),
      [
        '<meta http-equiv="Content-Security-Policy" content="img-src">',
        '<img src="private.png">',
      ].join(""),
    );
    await writeFile(join(root, "csp-empty-source-list", "private.png"), "image");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "csp-empty-source-list",
    );

    expect(manifestOf(site)?.assets).not.toContain("csp-empty-source-list/private.png");
  });

  it("honors the more specific script-src-attr directive over a permissive generic script-src", async () => {
    await mkdir(join(root, "csp-attr-directive"), { recursive: true });
    await writeFile(
      join(root, "csp-attr-directive", "index.html"),
      [
        '<meta http-equiv="Content-Security-Policy" content="script-src \'unsafe-inline\'; script-src-attr \'none\'; connect-src \'self\'">',
        "<button onclick='fetch(\"private.json\")'>go</button>",
      ].join(""),
    );
    await writeFile(join(root, "csp-attr-directive", "private.json"), "secret");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "csp-attr-directive",
    );

    // script-src alone would permit the inline handler via 'unsafe-inline',
    // but the more specific script-src-attr 'none' locks down attribute-
    // sourced script content and must win.
    expect(manifestOf(site)?.assets).not.toContain("csp-attr-directive/private.json");
  });

  it("still permits an inline script element via script-src's own unsafe-inline when no script-src-elem/-attr override is present", async () => {
    await mkdir(join(root, "csp-elem-fallback"), { recursive: true });
    await writeFile(
      join(root, "csp-elem-fallback", "index.html"),
      [
        '<meta http-equiv="Content-Security-Policy" content="script-src \'unsafe-inline\'; connect-src \'self\'">',
        '<script>fetch("public.json");</script>',
      ].join(""),
    );
    await writeFile(join(root, "csp-elem-fallback", "public.json"), "data");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "csp-elem-fallback",
    );

    // An inline SCRIPT ELEMENT is governed by script-src-elem, which falls
    // back to script-src when absent — the fallback chain must still work.
    expect(manifestOf(site)?.assets).toContain("csp-elem-fallback/public.json");
  });

  it("applies a srcdoc's own CSP to what it references, not the outer (unrestricted) document's policy", async () => {
    await mkdir(join(root, "srcdoc-own-csp"), { recursive: true });
    await writeFile(
      join(root, "srcdoc-own-csp", "index.html"),
      "<iframe srcdoc=\"<meta http-equiv=&quot;Content-Security-Policy&quot; content=&quot;connect-src 'none'&quot;><script src=&quot;app.js&quot;></script>\"></iframe>",
    );
    await writeFile(join(root, "srcdoc-own-csp", "app.js"), 'fetch("private.json");');
    await writeFile(join(root, "srcdoc-own-csp", "private.json"), "secret");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "srcdoc-own-csp",
    );

    // app.js itself is a real, permitted reference from the srcdoc...
    expect(manifestOf(site)?.assets).toContain("srcdoc-own-csp/app.js");
    // ...but its own fetch() is filtered by the SRCDOC's connect-src
    // 'none', not the (unrestricted) outer document's policy.
    expect(manifestOf(site)?.assets).not.toContain("srcdoc-own-csp/private.json");
  });

  it("normalizes an uppercase setAttribute attribute name before the URL-attribute lookup", async () => {
    await mkdir(join(root, "setattribute-case"), { recursive: true });
    await writeFile(
      join(root, "setattribute-case", "index.html"),
      '<script src="app.js"></script>',
    );
    await writeFile(
      join(root, "setattribute-case", "app.js"),
      [
        'const img = document.createElement("img");',
        'img.setAttribute("SRC", "asset.png");',
      ].join("\n"),
    );
    await writeFile(join(root, "setattribute-case", "asset.png"), "image");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "setattribute-case",
    );

    // HTML attribute names are case-insensitive — setAttribute("SRC", ...)
    // sets the same "src" attribute as setAttribute("src", ...), and img
    // fetches on property assignment alone (URL_FETCH_WITHOUT_INSERTION_TAGS),
    // no insertion proof required.
    expect(manifestOf(site)?.assets).toContain("setattribute-case/asset.png");
  });

  it("parses a meta-refresh target as a real document destination, discovering its own stylesheet dependencies", async () => {
    await mkdir(join(root, "meta-refresh-document"), { recursive: true });
    await writeFile(
      join(root, "meta-refresh-document", "index.html"),
      '<meta http-equiv="refresh" content="0; url=page2.html">',
    );
    await writeFile(
      join(root, "meta-refresh-document", "page2.html"),
      '<link rel="stylesheet" href="style.css">',
    );
    await writeFile(join(root, "meta-refresh-document", "style.css"), "body {}");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "meta-refresh-document",
    );

    // style.css only gets discovered if page2.html is actually PARSED as a
    // document (documentDestination: true), not just approved as an opaque
    // leaf asset.
    expect(manifestOf(site)?.assets).toContain("meta-refresh-document/page2.html");
    expect(manifestOf(site)?.assets).toContain("meta-refresh-document/style.css");
  });

  it("parses a form's action target as a real document destination, discovering its own stylesheet dependencies", async () => {
    await mkdir(join(root, "form-action-document"), { recursive: true });
    await writeFile(
      join(root, "form-action-document", "index.html"),
      '<form action="page2.html"><button type="submit">Go</button></form>',
    );
    await writeFile(
      join(root, "form-action-document", "page2.html"),
      '<link rel="stylesheet" href="style.css">',
    );
    await writeFile(join(root, "form-action-document", "style.css"), "body {}");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "form-action-document",
    );

    // Submitting the form is a real navigation, GET or POST alike —
    // style.css only gets discovered if page2.html is actually PARSED as
    // a document, not just approved as an opaque leaf asset.
    expect(manifestOf(site)?.assets).toContain("form-action-document/page2.html");
    expect(manifestOf(site)?.assets).toContain("form-action-document/style.css");
  });

  it("parses a submit control's formaction override as a real document destination", async () => {
    await mkdir(join(root, "formaction-document"), { recursive: true });
    await writeFile(
      join(root, "formaction-document", "index.html"),
      [
        '<form action="fallback.html">',
        '<button type="submit" formaction="page2.html">Go</button>',
        "</form>",
      ].join(""),
    );
    await writeFile(
      join(root, "formaction-document", "page2.html"),
      '<link rel="stylesheet" href="style.css">',
    );
    await writeFile(join(root, "formaction-document", "style.css"), "body {}");
    await writeFile(join(root, "formaction-document", "fallback.html"), "<h1>Fallback</h1>");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "formaction-document",
    );

    expect(manifestOf(site)?.assets).toContain("formaction-document/page2.html");
    expect(manifestOf(site)?.assets).toContain("formaction-document/style.css");
  });

  it("treats an unattached img element's src assignment as proven, without requiring insertion proof", async () => {
    await mkdir(join(root, "img-src-without-insertion"), { recursive: true });
    await writeFile(
      join(root, "img-src-without-insertion", "index.html"),
      '<script src="app.js"></script>',
    );
    await writeFile(
      join(root, "img-src-without-insertion", "app.js"),
      [
        'const img = document.createElement("img");',
        'img.src = "public.png";',
        // Never appended/inserted anywhere — img/video/audio start loading
        // the instant the property is set, the classic preload idiom.
      ].join("\n"),
    );
    await writeFile(join(root, "img-src-without-insertion", "public.png"), "image");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "img-src-without-insertion",
    );

    expect(manifestOf(site)?.assets).toContain("img-src-without-insertion/public.png");
  });

  it("declines a fresh, unbound document.createElement(\"script\") chain's src assignment as unprovable", async () => {
    await mkdir(join(root, "unbound-script-chain"), { recursive: true });
    await writeFile(
      join(root, "unbound-script-chain", "index.html"),
      '<script src="app.js"></script>',
    );
    await writeFile(
      join(root, "unbound-script-chain", "app.js"),
      // A bare chain, never bound to any variable, never inserted — there
      // is no way to trace whether its result was ever attached anywhere.
      'document.createElement("script").src = "private.js";',
    );
    await writeFile(join(root, "unbound-script-chain", "private.js"), "console.log(1)");

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "unbound-script-chain",
    );

    expect(manifestOf(site)?.assets).not.toContain("unbound-script-chain/private.js");
  });

  it("trims a <base href> before classifying it, so leading whitespace cannot hide an external base as a local directory", async () => {
    // Leading whitespace before "//evil.example/" would otherwise fail
    // BOTH the "//" network-path check and the anchored URI_SCHEME_PATTERN
    // match, letting the href fall through to local-directory resolution —
    // joining the untrimmed, still-space-prefixed href onto the document's
    // own directory instead of recognizing it as external. Stage a real
    // file at exactly that bogus, would-be-resolved local path: only the
    // untrimmed (buggy) code path can ever find it.
    await mkdir(join(root, "base-trim-external", " ", "evil.example"), { recursive: true });
    await writeFile(
      join(root, "base-trim-external", "index.html"),
      [
        '<base href=" //evil.example/">',
        '<script src="app.js"></script>',
      ].join(""),
    );
    await writeFile(
      join(root, "base-trim-external", " ", "evil.example", "app.js"),
      "leaked via bogus local base",
    );

    const site = (await listSitePackages(root)).find(
      (candidate) => candidate.root === "base-trim-external",
    );

    // A correctly trimmed, correctly external base resolves NO relative
    // reference locally at all — the bogus path is never even considered.
    expect(manifestOf(site)?.assets).not.toContain(
      "base-trim-external/ /evil.example/app.js",
    );
  });
});
