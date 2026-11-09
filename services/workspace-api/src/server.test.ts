import type { Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceServer, REQUEST_TIMEOUTS } from "./server";

// Short limits, checked often, so a stalled connection closes within the test.
const SHORT = { headersMs: 100, requestMs: 200, checkEveryMs: 10 };

let server: Server | undefined;

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function listen(timeouts = REQUEST_TIMEOUTS): Promise<number> {
  server = createWorkspaceServer(async (request) => new Response(`read ${(await request.text()).length}`), new Set(), timeouts);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return (server!.address() as AddressInfo).port;
}

/** Writes `text` on a new connection and resolves with everything the server sent once it closes. */
function exchange(port: number, text: string): Promise<{ reply: string; ms: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = connect(port, "127.0.0.1");
    let reply = "";
    socket.on("data", (chunk) => (reply += chunk.toString("latin1")));
    socket.on("error", () => undefined);
    socket.on("close", () => resolve({ reply, ms: Date.now() - started }));
    socket.write(text);
  });
}

describe("workspace server", () => {
  it("sets the request time limits", async () => {
    await listen();
    expect(server).toMatchObject({
      headersTimeout: REQUEST_TIMEOUTS.headersMs,
      requestTimeout: REQUEST_TIMEOUTS.requestMs,
      connectionsCheckingInterval: REQUEST_TIMEOUTS.checkEveryMs,
    });
  });

  it("answers 408 and closes a connection that stops sending its headers", async () => {
    const port = await listen(SHORT);
    const { reply, ms } = await exchange(port, "GET /health HTTP/1.1\r\nHost: api.example.test\r\n");
    expect(reply).toMatch(/^HTTP\/1\.1 408 /);
    // Node checks its limits every 30 s by default, so this fails if the check interval isn't set.
    expect(ms).toBeLessThan(5_000);
  });

  it("answers 408 and closes a connection that stops sending its body", async () => {
    const port = await listen(SHORT);
    const { reply, ms } = await exchange(
      port,
      "POST /api/auth/sign-in/email HTTP/1.1\r\nHost: api.example.test\r\nContent-Type: application/json\r\nContent-Length: 10\r\n\r\n{\"a\"",
    );
    expect(reply).toMatch(/^HTTP\/1\.1 408 /);
    expect(ms).toBeLessThan(5_000);
  });

  it("answers 400 to a request the adapter can't read, and keeps serving", async () => {
    const port = await listen();
    const unreadable = await exchange(port, "GET /health HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n");
    expect(unreadable.reply).toMatch(/^HTTP\/1\.1 400 /);
    const { reply } = await exchange(port, "GET /health HTTP/1.1\r\nHost: api.example.test\r\nConnection: close\r\n\r\n");
    expect(reply).toMatch(/^HTTP\/1\.1 200 /);
    expect(reply).toContain("read 0");
  });
});
