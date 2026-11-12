import { serveFetchHandler } from "@dohc/service-http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createShareWebApplication, SHARE_WEB_REQUEST_LOG } from "./server";

const AT = "2026-11-12T11:02:03.456Z";
const HOST = "share.example.test";
const SECRET = Buffer.alloc(32, 11).toString("base64url");
const SESSION_TOKEN = Buffer.alloc(32, 21).toString("base64url");
const CAPABILITY = Buffer.alloc(32, 1).toString("base64url");
const SHA = "a".repeat(64);

let server: Server | undefined;
let assets: string | undefined;
let lines: string[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(AT));
  lines = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  if (assets) await rm(assets, { recursive: true, force: true });
  assets = undefined;
});

// The share-web application behind the same node server main.ts runs.
async function listen(): Promise<string> {
  assets = await mkdtemp(join(tmpdir(), "share-web-request-log-"));
  await writeFile(join(assets, "index.html"), "<!doctype html>");
  const application = createShareWebApplication({
    relayUrl: "http://relay.test",
    publicRelayUrl: "https://relay.public.test",
    publicHosts: new Set([HOST]),
    viewerAssetsDir: assets,
    nowMs: () => 1_000,
    newSessionToken: () => SESSION_TOKEN,
    fetchRelay: async (relayRequest) => {
      const pathname = new URL(relayRequest.url).pathname;
      if (pathname === "/sync/link-exchange") {
        return Response.json({ ok: true, grantId: "grant-log", capabilityToken: CAPABILITY, capabilityExpiresAtMs: 901_000 });
      }
      if (pathname.endsWith(SHA)) return new Response(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      return new Response("missing", { status: 404 });
    },
  });
  server = serveFetchHandler({
    handler: application.handle,
    maxBodyBytes: () => 1024 * 1024,
    oversized: () => new Response(null, { status: 413 }),
    failure: () => new Response(null, { status: 500 }),
    prepareHeaders: (headers) => headers.set("host", HOST),
    requestLog: SHARE_WEB_REQUEST_LOG,
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function read(response: Promise<Response>): Promise<Response> {
  const answered = await response;
  await answered.arrayBuffer();
  return answered;
}

it("logs a share-link page as its route, never what follows /s/", async () => {
  const base = await listen();
  // A share link puts its secret after #, which a browser never sends.
  expect((await read(fetch(`${base}/s/`))).status).toBe(200);
  // A link pasted with its # dropped puts the secret in the path.
  expect((await read(fetch(`${base}/s/${SECRET}`))).status).toBe(200);
  const agent = await read(fetch(`${base}/mcp/s/${SECRET}`, { method: "POST" }));
  expect(lines).toEqual([
    `[share-web] request ${AT} GET /s/ 200`,
    `[share-web] request ${AT} GET /s/* 200`,
    `[share-web] request ${AT} POST /mcp/s/:secret ${agent.status}`,
  ]);
});

it("logs a share page file request as its route, never its session", async () => {
  const base = await listen();
  const exchanged = await fetch(`${base}/api/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: SECRET }),
  });
  expect(exchanged.status).toBe(200);
  const { session } = (await exchanged.json()) as { session: string };
  const cookie = exchanged.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const file = await read(fetch(`${base}/api/view/blob/${SHA}?session=${session}`, { headers: { cookie } }));
  expect(file.status).toBe(200);
  expect(lines).toEqual([
    `[share-web] request ${AT} POST /api/exchange 200`,
    `[share-web] request ${AT} GET /api/view/blob/:sha256 200`,
  ]);
});

it("logs a path no route matches as one fixed word", async () => {
  const base = await listen();
  const response = await read(fetch(`${base}/${SECRET}?session=${SESSION_TOKEN}`));
  expect(lines).toEqual([`[share-web] request ${AT} GET unmatched ${response.status}`]);
});

it("logs a published app's request as app, even on a path the viewer also serves", async () => {
  // Apps need a registrable viewer domain, which a .test host is not.
  const viewer = "share.example.com";
  const application = createShareWebApplication({
    relayUrl: "http://relay.test",
    publicRelayUrl: "https://relay.public.test",
    publicHosts: new Set([viewer]),
    fetchRelay: async () => new Response("missing", { status: 404 }),
    appLaunch: { viewerOrigin: `https://${viewer}`, appDomain: "example.net" },
  });
  const appHost = `${"a".repeat(48)}.example.net`;
  const statuses: number[] = [];
  for (const [host, path] of [[appHost, "/api/apps/launch"], [appHost, "/bootstrap"], [viewer, "/api/apps/launch"]] as const) {
    const request = new Request(`https://${host}${path}`, { method: "POST", headers: { host } });
    const response = await application.handle(request);
    statuses.push(response.status);
    // What the node server writes once the application answers.
    SHARE_WEB_REQUEST_LOG.write(request, "POST", response.status, Date.now());
  }
  expect(lines).toEqual([
    `[share-web] request ${AT} POST app ${statuses[0]}`,
    `[share-web] request ${AT} POST app ${statuses[1]}`,
    `[share-web] request ${AT} POST /api/apps/launch ${statuses[2]}`,
  ]);
});
