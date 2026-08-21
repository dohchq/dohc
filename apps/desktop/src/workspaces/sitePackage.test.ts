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
        // Provable, matching (tag, property): img.src.
        'const img = document.createElement("img");',
        'img.src = "img.png";',
        // Provable, matching (tag, property): a.href via setAttribute.
        'const link = document.createElement("a");',
        'link.setAttribute("href", "linked.html");',
        // Provable receiver, WRONG property for the tag — div.src is an
        // inert expando, not a request (finding 2).
        'const div = document.createElement("div");',
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
});
