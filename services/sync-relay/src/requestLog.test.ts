import { serveFetchHandler } from "@dohc/service-http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { guardRelayResponses } from "./relayResponseStanding";
import { relayEntryPattern } from "./requestLog";
import { SYNC_RELAY_REQUEST_LOG } from "./server";
import { closeTestStorages, testHandler, testStorage } from "./testing";

const AT = "2026-11-12T11:02:03.456Z";
const SECRET = Buffer.alloc(32, 11).toString("base64url");

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
  await closeTestStorages();
});

async function listen(): Promise<string> {
  server = serveFetchHandler({
    handler: testHandler(await testStorage()),
    maxBodyBytes: () => 1024 * 1024,
    oversized: () => new Response(null, { status: 413 }),
    failure: () => new Response(null, { status: 500 }),
    requestLog: SYNC_RELAY_REQUEST_LOG,
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function read(response: Promise<Response>): Promise<Response> {
  const answered = await response;
  await answered.arrayBuffer();
  return answered;
}

it("logs a matched route as its pattern, never the ids in its path or its query", async () => {
  const base = await listen();
  const log = await read(fetch(`${base}/sync/workspace-a/log?since=0&limit=10`, { headers: { authorization: "Bearer user:a" } }));
  const link = await read(fetch(`${base}/sync/link/share`, { headers: { authorization: `LinkCapability ${SECRET}` } }));
  expect(lines).toEqual([
    `[sync-relay] request ${AT} GET /sync/:workspaceId/log ${log.status}`,
    `[sync-relay] request ${AT} GET /sync/link/share ${link.status}`,
  ]);
});

it("logs a path no route matches as one fixed word", async () => {
  const base = await listen();
  const outside = await read(fetch(`${base}/${SECRET}?token=${SECRET}`));
  // The parser refuses `link` as a workspace id, so this matches no route either.
  const inside = await read(fetch(`${base}/sync/link/${SECRET}/nothing?token=${SECRET}`));
  expect(outside.status).toBe(404);
  expect(lines).toEqual([
    `[sync-relay] request ${AT} GET unmatched 404`,
    `[sync-relay] request ${AT} GET unmatched ${inside.status}`,
  ]);
});

it("names the routes answered before dispatch by their pattern", () => {
  expect([
    relayEntryPattern(null, "/sync/live/desktop-open"),
    relayEntryPattern(null, "/sync/workspace-a/live-host"),
    relayEntryPattern(null, "/sync/workspace-a/live-host/kept-edits"),
    relayEntryPattern(null, "/sync/live/link-document"),
    relayEntryPattern(null, `/sync/named-chat/${SECRET}`),
    relayEntryPattern(`Bearer dohc-service-v1.${SECRET}`, `/sync/workspace-a/log`),
    relayEntryPattern(null, `/sync/live/${SECRET}`),
    relayEntryPattern(null, "/sync/workspace-a/log"),
  ]).toEqual([
    "/sync/live/desktop-open",
    "/sync/:workspaceId/live-host",
    "/sync/:workspaceId/live-host/kept-edits",
    "/sync/live/link-document",
    "/sync/named-chat/*",
    "replication",
    undefined,
    undefined,
  ]);
});

it("keeps the route a guarded handler marked on the request it rebuilt", async () => {
  const outer = new Request("http://relay.test/sync/workspace-a/log");
  const guarded = guardRelayResponses(await testStorage(), async (inner) => {
    SYNC_RELAY_REQUEST_LOG.mark(inner, "/sync/:workspaceId/log");
    return new Response(null, { status: 204 });
  });
  const response = await guarded(outer);
  SYNC_RELAY_REQUEST_LOG.write(outer, "GET", response.status, Date.now());
  expect(lines).toEqual([`[sync-relay] request ${AT} GET /sync/:workspaceId/log 204`]);
});
