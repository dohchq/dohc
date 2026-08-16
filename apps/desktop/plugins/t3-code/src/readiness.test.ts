import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  pollT3Readiness,
  T3ChildExitError,
  T3ReadinessTimeoutError,
  T3VersionMismatchError,
} from "./readiness";
import { T3_PINNED_VERSION } from "./t3Entry";

// Real HTTP behavior, not mocked fetch: the poller's contract is what a real
// socket does — refused connections before listen, slow bodies, real JSON.

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    ),
  );
});

function listen(
  handler: Parameters<typeof createServer>[1],
): Promise<{ port: number; server: Server }> {
  const server = createServer(handler);
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      resolve({ port: address.port, server });
    });
  });
}

const never = new Promise<never>(() => {});

function environmentUrl(port: number): string {
  return `http://127.0.0.1:${port}/.well-known/t3/environment`;
}

describe("pollT3Readiness", () => {
  it("resolves once the endpoint serves the pinned version", async () => {
    let requests = 0;
    const { port } = await listen((_request, response) => {
      requests += 1;
      if (requests < 3) {
        // A server that is up but not command-ready yet.
        response.writeHead(503).end();
        return;
      }
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ serverVersion: T3_PINNED_VERSION, capabilities: [] }));
    });

    const descriptor = await pollT3Readiness({
      environmentUrl: environmentUrl(port),
      childExited: never,
      intervalMs: 5,
    });
    expect(descriptor.serverVersion).toBe(T3_PINNED_VERSION);
    expect(requests).toBeGreaterThanOrEqual(3);
  });

  it("keeps polling through refused connections before the server listens", async () => {
    // Allocate a port, but start listening only after the poller has begun.
    const { port, server } = await listen((_request, response) => {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ serverVersion: T3_PINNED_VERSION }));
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const poll = pollT3Readiness({
      environmentUrl: environmentUrl(port),
      childExited: never,
      intervalMs: 5,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const restarted = createServer((_request, response) => {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ serverVersion: T3_PINNED_VERSION }));
    });
    servers.push(restarted);
    await new Promise<void>((resolve) => {
      restarted.listen(port, "127.0.0.1", () => resolve());
    });

    await expect(poll).resolves.toEqual({ serverVersion: T3_PINNED_VERSION });
  });

  // The two halves of "only HTTP 200 with a decodable descriptor" — each
  // serves the wrong-but-tempting answer three times, so a poller that
  // accepted it would resolve on the FIRST request instead of the fourth.
  it("keeps polling a 200 whose body carries no serverVersion", async () => {
    let requests = 0;
    const { port } = await listen((_request, response) => {
      requests += 1;
      const body =
        requests < 4
          ? JSON.stringify({ status: "starting" })
          : JSON.stringify({ serverVersion: T3_PINNED_VERSION });
      response.writeHead(200, { "content-type": "application/json" }).end(body);
    });

    // MUTATION (accept an undecodable descriptor as the pinned version):
    // resolves on request 1.
    const descriptor = await pollT3Readiness({
      environmentUrl: environmentUrl(port),
      childExited: never,
      intervalMs: 5,
    });
    expect(descriptor.serverVersion).toBe(T3_PINNED_VERSION);
    expect(requests).toBeGreaterThanOrEqual(4);
  });

  it("keeps polling a non-200 that carries a valid descriptor", async () => {
    let requests = 0;
    const { port } = await listen((_request, response) => {
      requests += 1;
      response
        .writeHead(requests < 4 ? 503 : 200, { "content-type": "application/json" })
        .end(JSON.stringify({ serverVersion: T3_PINNED_VERSION }));
    });

    // MUTATION (status === 200 → status >= 100): resolves on request 1, from
    // a server that just said it cannot serve.
    const descriptor = await pollT3Readiness({
      environmentUrl: environmentUrl(port),
      childExited: never,
      intervalMs: 5,
    });
    expect(descriptor.serverVersion).toBe(T3_PINNED_VERSION);
    expect(requests).toBeGreaterThanOrEqual(4);
  });

  it("rejects with a version mismatch on any other serverVersion", async () => {
    const { port } = await listen((_request, response) => {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ serverVersion: "0.0.34" }));
    });

    const poll = pollT3Readiness({
      environmentUrl: environmentUrl(port),
      childExited: never,
      intervalMs: 5,
    });
    await expect(poll).rejects.toBeInstanceOf(T3VersionMismatchError);
    await expect(poll).rejects.toThrow("0.0.34");
    await expect(poll).rejects.toThrow(T3_PINNED_VERSION);
  });

  it("fails as soon as the child exits", async () => {
    const { port, server } = await listen(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    let exit: (value: unknown) => void = () => undefined;
    const childExited = new Promise((resolve) => {
      exit = resolve;
    });

    const poll = pollT3Readiness({
      environmentUrl: environmentUrl(port),
      childExited,
      intervalMs: 5,
    });
    exit({ code: 1, reason: "exited" });
    await expect(poll).rejects.toBeInstanceOf(T3ChildExitError);
  });

  it("gives up at the overall deadline and names it", async () => {
    // Nothing ever listens on this port.
    const { port, server } = await listen(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const poll = pollT3Readiness({
      environmentUrl: environmentUrl(port),
      childExited: never,
      intervalMs: 5,
      overallTimeoutMs: 100,
    });
    await expect(poll).rejects.toBeInstanceOf(T3ReadinessTimeoutError);
    await expect(poll).rejects.toThrow("100 ms");
  });

  it("survives a per-request timeout from a hanging server", async () => {
    let hung = 0;
    const { port } = await listen((_request, response) => {
      hung += 1;
      if (hung === 1) return; // Never respond to the first request.
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ serverVersion: T3_PINNED_VERSION }));
    });

    const descriptor = await pollT3Readiness({
      environmentUrl: environmentUrl(port),
      childExited: never,
      intervalMs: 5,
      requestTimeoutMs: 50,
    });
    expect(descriptor.serverVersion).toBe(T3_PINNED_VERSION);
    expect(hung).toBeGreaterThanOrEqual(2);
  });
});
