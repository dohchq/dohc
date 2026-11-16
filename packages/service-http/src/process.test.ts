import { Agent, request as httpRequest, type IncomingMessage } from "node:http";
import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { closeServer, parseGracePeriodMs } from "./process";
import { serveFetchHandler } from "./serveFetchHandler";

describe("parseGracePeriodMs", () => {
  it("accepts a non-negative integer and falls back otherwise", () => {
    expect(parseGracePeriodMs("250", 10_000)).toBe(250);
    expect(parseGracePeriodMs("0", 10_000)).toBe(0);
    expect(parseGracePeriodMs(undefined, 10_000)).toBe(10_000);
    expect(parseGracePeriodMs("-1", 10_000)).toBe(10_000);
    expect(parseGracePeriodMs("soon", 10_000)).toBe(10_000);
  });
});

describe("closeServer", () => {
  it("closes soon after its last request ends, though a client keeps its connection in use", async () => {
    let arrived = () => {},
      release = () => {};
    const inFlight = new Promise<void>((resolve) => (arrived = resolve));
    const held = new Promise<void>((resolve) => (release = resolve));
    const server = serveFetchHandler({
      handler: async () => {
        arrived();
        await held;
        return new Response("ok");
      },
      maxBodyBytes: () => 1024,
      oversized: () => new Response(null, { status: 413 }),
      failure: () => new Response(null, { status: 500 }),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no TCP port");
    // One connection, kept alive and used again and again, as a proxy in front of the server keeps its own.
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const get = () =>
      new Promise<void>((resolve, reject) => {
        httpRequest({ host: "127.0.0.1", port: address.port, agent }, (response) => {
          response.resume();
          response.once("end", resolve);
        })
          .once("error", reject)
          .end();
      });
    const first = get();
    await inFlight;

    const startedAt = Date.now();
    const closing = closeServer(server, 5_000);
    release();
    await first;
    const again = setInterval(() => void get().catch(() => undefined), 20);
    try {
      await closing;
    } finally {
      clearInterval(again);
      agent.destroy();
    }
    // Well under the 5 s grace period, which a server that waited for this connection to fall idle would use up.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("answers every accepted pipelined request during shutdown", async () => {
    let arrived = () => {},
      followed = () => {},
      release = () => {};
    const inFlight = new Promise<void>((resolve) => (arrived = resolve));
    const bothFollowed = new Promise<void>((resolve) => (followed = resolve));
    const held = new Promise<void>((resolve) => (release = resolve));
    let later = 0;
    const server = serveFetchHandler({
      handler: async (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/first") {
          arrived();
          await held;
        } else if (++later === 2) followed();
        return new Response(path);
      },
      maxBodyBytes: () => 1024,
      oversized: () => new Response(null, { status: 413 }),
      failure: () => new Response(null, { status: 500 }),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no TCP port");
    const socket = connect(address.port, "127.0.0.1");
    let answered = "";
    socket.setEncoding("utf8").on("data", (chunk: string) => (answered += chunk));
    const ended = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    const get = (path: string) => `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`;
    socket.write(get("/first"));
    await inFlight;

    const closing = closeServer(server, 5_000);
    // Two more requests follow the first on the same connection. The server has taken both before the first is
    // answered, so the connection is never idle between them.
    socket.write(get("/second") + get("/third"));
    await bothFollowed;
    release();
    await Promise.all([closing, ended]);
    expect(answered.match(/^HTTP\/1\.1 200/gmu)).toHaveLength(3);
    expect(answered).toContain("/third");
  });

  it("force-closes a stalled response after the grace period", async () => {
    const server = serveFetchHandler({
      handler: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(16).fill(1));
              // Never closes: the client is left holding a half-finished body.
            },
          }),
        ),
      maxBodyBytes: () => 1024,
      oversized: () => new Response(null, { status: 413 }),
      failure: () => new Response(null, { status: 500 }),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no TCP port");
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      httpRequest(`http://127.0.0.1:${address.port}/stalled`, resolve).once("error", reject).end();
    });
    await new Promise<void>((resolve) => response.once("data", () => resolve()));
    const closedAt = new Promise<void>((resolve) => response.once("close", () => resolve()));

    const startedAt = Date.now();
    await closeServer(server, 100);
    await closedAt;
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(90);
  });
});
