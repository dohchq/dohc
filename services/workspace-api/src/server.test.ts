import { once } from "node:events";
import type { Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceServer, REQUEST_TIMEOUTS } from "./server";

// Short limits, checked often, so a stalled connection closes within the test.
// The idle limit is the longest, so it never closes a connection before a 408.
const SHORT = { headersMs: 100, requestMs: 200, checkEveryMs: 10, idleMs: 300 };

let server: Server | undefined;
const clients: Socket[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function listen(
  timeouts = REQUEST_TIMEOUTS,
  handle = async (request: Request) => new Response(`read ${(await request.text()).length}`),
): Promise<number> {
  server = createWorkspaceServer(handle, new Set(), timeouts);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return (server!.address() as AddressInfo).port;
}

/** Opens a connection and resolves with the server's side of it. */
async function open(port: number): Promise<{ client: Socket; socket: Socket }> {
  const accepted = once(server!, "connection");
  const client = connect(port, "127.0.0.1");
  clients.push(client);
  client.on("error", () => undefined);
  const [socket] = (await accepted) as [Socket];
  return { client, socket };
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
      timeout: REQUEST_TIMEOUTS.idleMs,
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

  it("closes a connection when its answer stops moving for the idle limit", async () => {
    // An answer with no end, so it stops moving once the client stops reading.
    const port = await listen(SHORT, async () => new Response(new ReadableStream({ pull: (controller) => controller.enqueue(new Uint8Array(64 * 1024)) })));
    const { client, socket } = await open(port);
    client.pause();
    const started = Date.now();
    client.write("GET / HTTP/1.1\r\nHost: api.example.test\r\n\r\n");
    await once(socket, "close");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("finishes an answer that takes longer than the idle limit", async () => {
    let accepted: Promise<unknown[]> | undefined;
    const port = await listen(SHORT, async () => {
      // Answers only once its connection has been idle past the limit.
      const [socket] = (await accepted!) as [Socket];
      await once(socket, "timeout");
      return new Response("slow answer");
    });
    accepted = once(server!, "connection");
    const { reply } = await exchange(port, "GET / HTTP/1.1\r\nHost: api.example.test\r\nConnection: close\r\n\r\n");
    expect(reply).toMatch(/^HTTP\/1\.1 200 /);
    expect(reply).toContain("slow answer");
  });

  it("still closes an idle keep-alive connection", async () => {
    const port = await listen(SHORT);
    server!.keepAliveTimeout = 50;
    const { client, socket } = await open(port);
    client.resume();
    client.write("GET / HTTP/1.1\r\nHost: api.example.test\r\n\r\n");
    const started = Date.now();
    await once(socket, "close");
    // Node adds a second to the keep-alive limit.
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
