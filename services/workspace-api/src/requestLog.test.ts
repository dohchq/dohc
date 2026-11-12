import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRouter, type AuthGateway } from "./routes";
import { createWorkspaceServer } from "./server";

const AT = "2026-11-12T11:02:03.456Z";
const TOKEN = Buffer.alloc(32, 7).toString("base64url");

let server: Server | undefined;
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
});

async function listen(handler: AuthGateway["handler"]): Promise<string> {
  const router = createRouter({
    auth: { handler, api: { getSession: async () => null, deviceVerify: async () => ({ status: "pending" }) } },
    readiness: async () => ({ ok: true, database: "ok", schema: "ok", missingTables: [] }),
    descriptor: { authUrl: "http://auth.test", relayUrl: "http://relay.test", shareUrl: "http://share.test" },
    emailTransport: "smtp",
    allowedOrigins: [],
  });
  server = createWorkspaceServer(router, new Set());
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

it("logs a sign-in as its route, never its query, body or address", async () => {
  const base = await listen(async () => Response.json({ token: TOKEN }));
  const response = await fetch(`${base}/api/auth/sign-in/email?callbackURL=%2Faccount`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "ada@example.com", password: TOKEN }),
  });
  expect(response.status).toBe(200);
  await response.arrayBuffer();
  expect(lines).toEqual([`[workspace-api] request ${AT} POST /api/auth/sign-in/email 200`]);
});

it("logs a sign-in route it does not list, and a token in the path, as the sign-in prefix", async () => {
  const base = await listen(async () => new Response(null, { status: 302, headers: { location: "/account" } }));
  const reset = await fetch(`${base}/api/auth/reset-password/${TOKEN}?callbackURL=%2Faccount`, { redirect: "manual" });
  expect(reset.status).toBe(302);
  const page = await fetch(`${base}/account/reset-password?token=${TOKEN}`);
  expect(page.status).toBe(200);
  await page.arrayBuffer();
  expect(lines).toEqual([
    `[workspace-api] request ${AT} GET /api/auth/* 302`,
    `[workspace-api] request ${AT} GET /account/reset-password 200`,
  ]);
});

it("logs a path no route matches as one fixed word", async () => {
  const base = await listen(async () => Response.json({}));
  const response = await fetch(`${base}/account/${TOKEN}?token=${TOKEN}`);
  expect(response.status).toBe(404);
  await response.arrayBuffer();
  expect(lines).toEqual([`[workspace-api] request ${AT} GET unmatched 404`]);
});

it("logs an answer whose client leaves before its body ends, once", async () => {
  // One chunk, then a body that never ends: the client leaves mid-answer.
  const base = await listen(async () => new Response(new ReadableStream({ start: (controller) => controller.enqueue(new Uint8Array([1])) })));
  const leave = new AbortController();
  const response = await fetch(`${base}/api/auth/stream`, { signal: leave.signal });
  expect(response.status).toBe(200);
  await response.body!.getReader().read();
  leave.abort();
  await expect.poll(() => lines).toEqual([`[workspace-api] request ${AT} GET /api/auth/* 200`]);
});

it("logs a page by its path, and an asset by its route, never its hash", async () => {
  const base = await listen(async () => Response.json({}));
  const ready = await fetch(`${base}/ready`);
  await ready.arrayBuffer();
  const html = await (await fetch(`${base}/account/sign-in`)).text();
  const asset = html.match(/\/account\/assets\/account\.[A-Za-z0-9_-]+\.css/u)?.[0];
  expect(asset).toBeDefined();
  const css = await fetch(`${base}${asset}`);
  await css.arrayBuffer();
  expect(lines).toEqual([
    `[workspace-api] request ${AT} GET /ready 200`,
    `[workspace-api] request ${AT} GET /account/sign-in 200`,
    `[workspace-api] request ${AT} GET /account/assets/:asset 200`,
  ]);
});
