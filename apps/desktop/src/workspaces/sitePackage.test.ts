import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { nativeTmpdir } from "./testTemp";
import { discoverSiteRoots, getSitePackage, listSitePackages } from "./sitePackage";
import type { WorkspaceFileEntry } from "../ipc/bridgeContract";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(nativeTmpdir(), "dohc-site-packages-"));
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
          file("notes/today.md"),
          file("dohc.json"),
        ],
        ["built/dist", "plain"],
      ),
    ).toEqual([".", "built", "dash", "portal", "report"]);
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
    await mkdir(join(root, "sdk-site"), { recursive: true });
    await writeFile(
      join(root, "sdk-site", "package.json"),
      JSON.stringify({ scripts: { dev: "vite" } }),
    );
    await writeFile(
      join(root, "sdk-site", "dohc.json"),
      JSON.stringify({
        type: "site",
        title: "SDK Site",
        preview: { mode: "dev", command: "node /tmp/vite.js --host 127.0.0.1" },
      }),
    );

    const site = (await listSitePackages(root)).find((entry) => entry.root === "sdk-site");
    expect(site).toMatchObject({
      scripts: { dev: "node /tmp/vite.js --host 127.0.0.1" },
      configuredScripts: { dev: "node /tmp/vite.js --host 127.0.0.1" },
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
