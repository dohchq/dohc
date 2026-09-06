import { request as httpRequest, type IncomingMessage } from "node:http";
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
