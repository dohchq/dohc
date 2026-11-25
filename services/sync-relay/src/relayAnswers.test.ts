import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { untilRelayAnswers } from "./relayAnswers";

let server: Server | undefined;
afterEach(
  () => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())),
);

async function gateway(statuses: number[]): Promise<{ origin: string; paths: string[] }> {
  const paths: string[] = [];
  server = createServer((request, response) => {
    paths.push(request.url ?? "");
    response.writeHead(statuses[Math.min(paths.length, statuses.length) - 1]!).end();
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, paths };
}

describe("untilRelayAnswers", () => {
  it("waits through gateway errors until the relay answers", async () => {
    const { origin, paths } = await gateway([502, 503, 404]);
    await untilRelayAnswers(origin, {
      withinMs: 10_000,
      retryMs: 1,
      signal: new AbortController().signal,
    });
    expect(paths).toEqual(["/sync/", "/sync/", "/sync/"]);
  });

  it("gives up once its wait ends", async () => {
    const { origin, paths } = await gateway([502]);
    await untilRelayAnswers(origin, {
      withinMs: 200,
      retryMs: 20,
      signal: new AbortController().signal,
    });
    expect(paths.length).toBeGreaterThan(1);
  });

  it("stops when the server closes", async () => {
    const { origin } = await gateway([502]);
    const closing = new AbortController();
    const waiting = untilRelayAnswers(origin, {
      withinMs: 60_000,
      retryMs: 60_000,
      signal: closing.signal,
    });
    closing.abort();
    await waiting;
  });
});
