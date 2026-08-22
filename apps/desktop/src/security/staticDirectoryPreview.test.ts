import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Serving a directory is real filesystem and socket work, honest work a busy
// machine stretches (#568). Same 15s deadline the site runner's suite measured
// its way to.
vi.setConfig({ testTimeout: 15_000 });
import { createTestScratch } from "../workspaces/testTemp";
import { startStaticDirectoryPreview } from "./staticDirectoryPreview";

/** Sends `path` exactly as spelled, with no client-side URL normalization. */
function rawRequestStatus(origin: string, path: string): Promise<number> {
  const { hostname, port } = new URL(origin);
  return new Promise((resolve, reject) => {
    const call = request({ hostname, port, path, method: "GET" }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    call.on("error", reject);
    call.end();
  });
}

let root: string;

beforeEach(async () => {
  root = await createTestScratch("dohc-static-preview-");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("startStaticDirectoryPreview", () => {
  it("serves an arbitrary contained panel directory with the static safeguards", async () => {
    const pluginRoot = join(root, "plugin");
    const panelRoot = join(pluginRoot, "panel");
    await mkdir(join(panelRoot, ".dohc"), { recursive: true });
    await writeFile(join(panelRoot, "index.html"), "<h1>Plugin panel</h1>");
    await writeFile(join(panelRoot, ".dohc", "secret.txt"), "secret");

    const preview = await startStaticDirectoryPreview(panelRoot, {
      containmentRoot: pluginRoot,
      entry: "index.html",
      entryLabel: "panel entry",
    });
    try {
      const response = await fetch(preview.url);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.text()).resolves.toContain("Plugin panel");
      await expect(
        fetch(new URL("/.dohc/secret.txt", preview.url)).then(
          (result) => result.status,
        ),
      ).resolves.toBe(403);
    } finally {
      await preview.stop();
    }
  });

  it("refuses a root outside its containment root", async () => {
    const containment = join(root, "contained");
    const outside = join(root, "outside");
    await mkdir(containment, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "index.html"), "<h1>Escaped</h1>");

    // MUTATION (containment): drop the isInside check and this root is served
    // even though nothing about it was judged against the containment root.
    await expect(
      startStaticDirectoryPreview(outside, {
        containmentRoot: containment,
        entry: "index.html",
        entryLabel: "panel entry",
      }),
    ).rejects.toThrow(/escapes its containment root/);
  });

  it("refuses a root that sits on a reserved metadata path", async () => {
    const reserved = join(root, ".dohc", "panel");
    await mkdir(reserved, { recursive: true });
    await writeFile(join(reserved, "index.html"), "<h1>Control plane</h1>");

    await expect(
      startStaticDirectoryPreview(reserved, {
        containmentRoot: root,
        entry: "index.html",
        entryLabel: "panel entry",
      }),
    ).rejects.toThrow(/reserved metadata path/);
  });

  it("refuses an entry that walks out of the served root", async () => {
    const panelRoot = join(root, "panel");
    await mkdir(panelRoot, { recursive: true });
    await writeFile(join(root, "index.html"), "<h1>Parent</h1>");

    await expect(
      startStaticDirectoryPreview(panelRoot, {
        containmentRoot: root,
        entry: "../index.html",
        entryLabel: "panel entry",
      }),
    ).rejects.toThrow(/Invalid panel entry/);
  });

  it("serves files under the root and refuses traversal out of it", async () => {
    const panelRoot = join(root, "panel");
    await mkdir(join(panelRoot, "assets"), { recursive: true });
    await writeFile(join(panelRoot, "index.html"), "<h1>Panel</h1>");
    await writeFile(join(panelRoot, "assets", "app.js"), "export const ok = 1;");
    await writeFile(join(root, "outside.txt"), "outside");

    const preview = await startStaticDirectoryPreview(panelRoot, {
      containmentRoot: root,
      entry: "index.html",
      entryLabel: "panel entry",
    });
    try {
      const asset = await fetch(new URL("/assets/app.js", preview.url));
      expect(asset.status).toBe(200);
      // MUTATION (mime): a wrong table entry ships JS as octet-stream and the
      // panel's module never executes.
      expect(asset.headers.get("content-type")).toBe(
        "application/javascript; charset=utf-8",
      );
      expect(asset.headers.get("x-content-type-options")).toBe("nosniff");
      // Sent RAW, because `fetch` rewrites the path before it leaves the
      // client. A plainly spelled `..` is resolved away by the URL parser on
      // both sides, so it arrives already contained.
      await expect(rawRequestStatus(preview.url, "/../outside.txt")).resolves.toBe(
        404,
      );
      // An ENCODED slash is what the parser cannot see: it keeps `%2f`
      // opaque, so the traversal appears only after decodeURIComponent. That
      // is the case the segment check exists for.
      // MUTATION (traversal): drop the ".." segment check and this reaches
      // outside.txt above the served root.
      await expect(
        rawRequestStatus(preview.url, "/assets%2f..%2f..%2foutside.txt"),
      ).resolves.toBe(400);
      // MUTATION (null byte): drop the "\0" check and a truncating path
      // reaches the filesystem layer.
      await expect(rawRequestStatus(preview.url, "/%00index.html")).resolves.toBe(
        400,
      );
    } finally {
      await preview.stop();
    }
  });

  it("serves a .htm entry as text/html, not application/octet-stream", async () => {
    const panelRoot = join(root, "htm-panel");
    await mkdir(panelRoot, { recursive: true });
    await writeFile(join(panelRoot, "index.htm"), "<h1>Htm</h1>");

    const preview = await startStaticDirectoryPreview(panelRoot, {
      containmentRoot: root,
      entry: "index.htm",
      entryLabel: "panel entry",
    });
    try {
      const asset = await fetch(new URL("/index.htm", preview.url));
      expect(asset.status).toBe(200);
      // MUTATION (mime): a missing .htm table entry falls through to
      // application/octet-stream and the browser downloads the page instead
      // of rendering it.
      expect(asset.headers.get("content-type")).toBe("text/html; charset=utf-8");
    } finally {
      await preview.stop();
    }
  });

  it("refuses an alias that leaves the served root but stays in containment", async () => {
    // The served root is a SUBDIRECTORY of the containment root, so the
    // containment check alone still admits the plugin's sibling files. This
    // is the only guard that narrows a request to the served directory.
    const pluginRoot = join(root, "plugin");
    const panelRoot = join(pluginRoot, "panel");
    await mkdir(panelRoot, { recursive: true });
    await writeFile(join(panelRoot, "index.html"), "<h1>Panel</h1>");
    await writeFile(join(pluginRoot, "sibling.txt"), "not the panel's to serve");
    await symlink(pluginRoot, join(panelRoot, "escape"), "dir");

    const preview = await startStaticDirectoryPreview(panelRoot, {
      containmentRoot: pluginRoot,
      entry: "index.html",
      entryLabel: "panel entry",
    });
    try {
      // MUTATION (served-root narrowing): drop the isInside(root, realTarget)
      // check and this serves sibling.txt from outside the served directory.
      await expect(rawRequestStatus(preview.url, "/escape/sibling.txt")).resolves.toBe(
        403,
      );
    } finally {
      await preview.stop();
    }
  });

  it("forbidSharedWithMePaths refuses even an ordinary same-directory request when the served root itself sits inside shared-with-me", async () => {
    // siteRunner passes forbidSharedWithMePaths: true and, for an owned
    // (non-share-authority) site, containmentRoot is the WHOLE workspace —
    // so if this site's own served root turns out to sit inside a
    // shared-with-me mount (its directory misclassified, or reached through
    // a symlink resolved before the server ever starts), the rule must
    // refuse it entirely, not just requests that escape the served
    // directory. The plain isInside(root, realTarget) containment check
    // alone would happily allow this — the entry file genuinely lives where
    // it's requested from — so this exercises forbidSharedWithMePaths
    // doing something isInside does not.
    const workspaceRoot = join(root, "workspace");
    const leakedSiteRoot = join(workspaceRoot, "shared-with-me", "alice", "leaked-site");
    await mkdir(leakedSiteRoot, { recursive: true });
    await writeFile(join(leakedSiteRoot, "index.html"), "<h1>Not this workspace's to serve</h1>");

    const preview = await startStaticDirectoryPreview(leakedSiteRoot, {
      containmentRoot: workspaceRoot,
      entry: "index.html",
      entryLabel: "site entry",
      forbidSharedWithMePaths: true,
    });
    try {
      // MUTATION (forbidSharedWithMePaths as a whole): drop BOTH the
      // spelled-path and resolved-path isSharedWithMePath checks and this
      // site's own entry file is served normally. The two checks are
      // mutually redundant for every construction reachable in this test
      // (no symlink separates "spelled" from "resolved" here, so they see
      // the identical string) — verified directly: disabling either ONE
      // alone still left this refused, via the other. Both still guard
      // genuinely different code paths (one runs before any filesystem
      // resolution, the other after) even though this specific scenario
      // cannot distinguish them; disabling only ONE is deliberately NOT
      // pinned here, to avoid asserting a false claim about which check
      // did the refusing.
      await expect(rawRequestStatus(preview.url, "/index.html")).resolves.toBe(403);
    } finally {
      await preview.stop();
    }
  });
});
