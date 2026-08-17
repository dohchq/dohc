import { mkdir, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestScratch } from "../../../src/workspaces/testTemp";
import { startSiteServer, type SiteServer } from "./staticServer";

const running: SiteServer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.stop().catch(() => undefined)));
});

async function workspaceWithSite(): Promise<{ workspaceRoot: string; siteRoot: string }> {
  const workspaceRoot = await createTestScratch("dohc-sites-server-");
  const siteRoot = join(workspaceRoot, "marketing");
  await mkdir(join(siteRoot, "assets"), { recursive: true });
  await writeFile(join(siteRoot, "index.html"), "<h1>Marketing</h1>", "utf8");
  await writeFile(join(siteRoot, "assets", "app.css"), "body{color:red}", "utf8");
  await mkdir(join(workspaceRoot, ".dohc"), { recursive: true });
  await writeFile(join(workspaceRoot, ".dohc", "secret.txt"), "workspace control plane", "utf8");
  await writeFile(join(workspaceRoot, "outside.txt"), "not this site", "utf8");
  return { workspaceRoot, siteRoot };
}

async function start(workspaceRoot: string): Promise<SiteServer> {
  const server = await startSiteServer({
    workspaceRoot,
    status: { heading: "Marketing", detail: "Opening this site." },
  });
  running.push(server);
  return server;
}

async function get(server: SiteServer, path: string): Promise<Response> {
  return fetch(new URL(path, server.url));
}

/** A request with the path exactly as written, past any client normalization. */
async function rawGet(
  server: SiteServer,
  path: string,
): Promise<{ status: number; body: string }> {
  const origin = new URL(server.url);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: origin.hostname, port: Number(origin.port), path, method: "GET" },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.on("error", reject);
    request.end();
  });
}

describe("the site server", () => {
  it("reports what it is waiting for until a directory is served", async () => {
    const { workspaceRoot, siteRoot } = await workspaceWithSite();
    const server = await start(workspaceRoot);

    const waiting = await get(server, "/");
    expect(waiting.status).toBe(200);
    const waitingBody = await waiting.text();
    expect(waitingBody).toContain("Opening this site.");
    // A tab that is still waiting comes back on its own, which is what lets a
    // build outlast dohc's limit on starting a web app.
    expect(waitingBody).toContain('http-equiv="refresh"');

    await server.serveDirectory({ rootPath: siteRoot, entry: "index.html" });
    const served = await get(server, "/");
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("<h1>Marketing</h1>");
    expect(served.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(served.headers.get("cache-control")).toBe("no-store");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("stops asking once the preview has failed", async () => {
    const { workspaceRoot } = await workspaceWithSite();
    const server = await start(workspaceRoot);
    server.setStatus({ failed: true, heading: "Marketing did not build", detail: "Exit code 2.", log: ["boom"] });

    const response = await get(server, "/");
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain("Exit code 2.");
    expect(body).toContain("boom");
    expect(body).not.toContain("http-equiv=\"refresh\"");
  });

  it("escapes log text into the page rather than letting it become markup", async () => {
    const { workspaceRoot } = await workspaceWithSite();
    const server = await start(workspaceRoot);
    server.setStatus({
      failed: true,
      heading: "Marketing did not build",
      detail: "Exit code 2.",
      log: ["<script>alert(1)</script>"],
    });
    const body = await (await get(server, "/")).text();
    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).toContain("&lt;script&gt;");
  });

  it("serves an asset under the site", async () => {
    const { workspaceRoot, siteRoot } = await workspaceWithSite();
    const server = await start(workspaceRoot);
    await server.serveDirectory({ rootPath: siteRoot, entry: "index.html" });

    const response = await get(server, "/assets/app.css");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("body{color:red}");
    expect(response.headers.get("content-type")).toBe("text/css; charset=utf-8");
  });

  it("never answers a request that climbs out of the site", async () => {
    const { workspaceRoot, siteRoot } = await workspaceWithSite();
    const server = await start(workspaceRoot);
    await server.serveDirectory({ rootPath: siteRoot, entry: "index.html" });

    // Sent raw: fetch resolves "/../" away before a request leaves, so only a
    // request written by hand reaches the server still asking to climb.
    for (const path of [
      "/../outside.txt",
      "/%2e%2e/outside.txt",
      "/%2E%2E/outside.txt",
      "/assets/../../outside.txt",
      "/..%2foutside.txt",
      "/.%2e/outside.txt",
    ]) {
      const response = await rawGet(server, path);
      expect(response.status, path).not.toBe(200);
      expect(response.body, path).not.toContain("not this site");
    }
  });

  it("refuses a traversal segment that survives to the request handler", async () => {
    const { workspaceRoot, siteRoot } = await workspaceWithSite();
    const server = await start(workspaceRoot);
    await server.serveDirectory({ rootPath: siteRoot, entry: "index.html" });

    // An encoded separator keeps ".." out of the URL parser's own path
    // normalization, so this is the spelling that reaches the guard. Every
    // other traversal spelling is already flattened by the time it arrives.
    expect((await rawGet(server, "/..%2foutside.txt")).status).toBe(400);
    expect((await rawGet(server, "/%00index.html")).status).toBe(400);
  });

  it("refuses a request that resolves out of the site through a link", async () => {
    const { workspaceRoot, siteRoot } = await workspaceWithSite();
    try {
      await symlink(workspaceRoot, join(siteRoot, "escape"), "junction");
    } catch {
      // A machine that refuses to make links has nothing to test here.
      return;
    }
    const server = await start(workspaceRoot);
    await server.serveDirectory({ rootPath: siteRoot, entry: "index.html" });

    // Nothing about "/escape/outside.txt" is spelled wrong: no traversal
    // segment, no reserved name, and the file is really there. Only resolving
    // it and comparing against the served directory refuses it, which makes
    // this the one request that reaches that check.
    const response = await rawGet(server, "/escape/outside.txt");
    expect(response.status).toBe(403);
    expect(response.body).not.toContain("not this site");
  });

  it("refuses a request naming a reserved workspace directory", async () => {
    const { workspaceRoot, siteRoot } = await workspaceWithSite();
    const server = await start(workspaceRoot);
    await server.serveDirectory({ rootPath: siteRoot, entry: "index.html" });

    expect((await get(server, "/.dohc/secret.txt")).status).toBe(403);
    expect((await get(server, "/node_modules/thing.js")).status).toBe(403);
  });

  it("refuses to serve a directory outside the workspace", async () => {
    const { workspaceRoot } = await workspaceWithSite();
    const elsewhere = await createTestScratch("dohc-sites-elsewhere-");
    await writeFile(join(elsewhere, "index.html"), "<h1>Elsewhere</h1>", "utf8");
    const server = await start(workspaceRoot);

    await expect(
      server.serveDirectory({ rootPath: elsewhere, entry: "index.html" }),
    ).rejects.toThrow(/outside the workspace/);
    // The refusal leaves the preview reporting, never serving what it refused.
    expect((await get(server, "/")).status).toBe(200);
    expect(await (await get(server, "/")).text()).toContain("Opening this site.");
  });

  it("refuses to serve the workspace's own control plane", async () => {
    const { workspaceRoot } = await workspaceWithSite();
    await writeFile(join(workspaceRoot, ".dohc", "index.html"), "<h1>No</h1>", "utf8");
    const server = await start(workspaceRoot);

    await expect(
      server.serveDirectory({ rootPath: join(workspaceRoot, ".dohc"), entry: "index.html" }),
    ).rejects.toThrow(/reserved workspace path/);
  });

  it("refuses a site directory that is a link onto a reserved path", async () => {
    const { workspaceRoot } = await workspaceWithSite();
    await writeFile(join(workspaceRoot, ".dohc", "index.html"), "<h1>No</h1>", "utf8");
    const link = join(workspaceRoot, "alias");
    try {
      await symlink(join(workspaceRoot, ".dohc"), link, "junction");
    } catch {
      // A machine that refuses to make links has nothing to test here.
      return;
    }
    const server = await start(workspaceRoot);
    await expect(
      server.serveDirectory({ rootPath: link, entry: "index.html" }),
    ).rejects.toThrow(/reserved workspace path/);
  });

  it("refuses an entry that is not inside the site", async () => {
    const { workspaceRoot, siteRoot } = await workspaceWithSite();
    const server = await start(workspaceRoot);
    await expect(
      server.serveDirectory({ rootPath: siteRoot, entry: "../outside.txt" }),
    ).rejects.toThrow(/Invalid site entry/);
  });
});
