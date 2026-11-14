import { request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DRAIN_TIMEOUT_HEADER } from "./pipeResponseBody";
import {
  ClientClosedRequest,
  serveFetchHandler,
  type ServeFetchHandlerOptions,
} from "./serveFetchHandler";

const servers: Server[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function serve(
  options: Partial<ServeFetchHandlerOptions> & Pick<ServeFetchHandlerOptions, "handler">,
): Promise<{ port: number; server: Server }> {
  const server = serveFetchHandler({
    maxBodyBytes: () => 1024 * 1024,
    oversized: () => Response.json({ ok: false, error: "too large" }, { status: 413 }),
    failure: () => Response.json({ ok: false, error: "failed" }, { status: 500 }),
    ...options,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no TCP port");
  return { port: address.port, server };
}

function firstChunk(response: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    response.once("data", (chunk: Buffer) => resolve(Buffer.from(chunk)));
    response.once("end", () => reject(new Error("ended without bytes")));
    response.once("error", reject);
  });
}

describe("serveFetchHandler", () => {
  it("bounds headers itself and leaves body receipt to the adapter or a streaming handler", async () => {
    const ordinary = await serve({ handler: async () => new Response(null) });
    const streaming = await serve({
      streamBody: () => true,
      handler: async () => new Response(null),
    });
    for (const { server } of [ordinary, streaming]) {
      expect(server.requestTimeout).toBe(0);
      expect(server.headersTimeout).toBe(60_000);
    }
  });

  it("refuses an upload that does not arrive in time while its handler reads it", async () => {
    let readFailed = false;
    const handler = vi.fn(async (request: Request) => {
      await request.text().catch(() => {
        readFailed = true;
      });
      return new Response("ok");
    });
    const { port, server } = await serve({
      streamBody: (url) => url.pathname === "/import",
      handler,
      timedOut: (url) => new Response(null, { status: 408, headers: { "x-path": url.pathname } }),
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const arrived = new Promise<void>((resolve) => server.once("request", () => resolve()));
    const response = new Promise<IncomingMessage>((resolve, reject) => {
      const request = httpRequest(`http://127.0.0.1:${port}/ordinary`, { method: "POST" }, resolve);
      request.on("error", reject);
      request.write("unfinished");
    });
    await arrived;
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(300_000);
    const refused = await response;
    expect(refused.statusCode).toBe(408);
    expect(refused.headers.connection).toBe("close");
    expect(refused.headers["x-path"]).toBe("/ordinary");
    refused.resume();
    await vi.waitFor(() => expect(readFailed).toBe(true));
    // The connection lingers so the client can read the answer, then goes.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the receipt timer once the body has arrived", async () => {
    let entered!: () => void, finish!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { port } = await serve({
      streamBody: () => false,
      handler: async (request) => {
        expect(await request.text()).toBe("complete");
        await new Promise<void>((resolve) => {
          finish = resolve;
          entered();
        });
        expect(request.signal.aborted).toBe(false);
        return new Response("ok");
      },
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const response = new Promise<IncomingMessage>((resolve, reject) => {
      httpRequest(`http://127.0.0.1:${port}/ordinary`, { method: "POST" }, resolve)
        .on("error", reject)
        .end("complete");
    });
    await started;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(300_000);
    finish();
    const completed = await response;
    expect(completed.statusCode).toBe(200);
    completed.resume();
  });

  it("leaves streaming receipt deadlines to the handler and aborts a disconnected upload", async () => {
    let entered!: () => void, aborted!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const cancelled = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    let signal!: AbortSignal;
    const { port } = await serve({
      streamBody: () => true,
      handler: async (request) => {
        signal = request.signal;
        request.signal.addEventListener("abort", aborted, { once: true });
        const reader = request.body!.getReader();
        expect((await reader.read()).value?.byteLength).toBe(1);
        entered();
        try {
          await reader.read();
        } catch {
          /* Disconnect rejects the pending read. */
        }
        return new Response(null);
      },
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const request = httpRequest(`http://127.0.0.1:${port}/import`, { method: "POST" });
    request.on("error", () => {});
    request.write("x");
    await started;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(360_000);
    expect(signal.aborted).toBe(false);
    request.destroy();
    await cancelled;
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("admits a streaming upload before its client finishes sending the body", async () => {
    const { port } = await serve({
      streamBody: () => true,
      handler: async () => new Response("not authorized", { status: 403 }),
    });
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = httpRequest(`http://127.0.0.1:${port}/import`, { method: "POST" }, resolve);
      request.on("error", reject);
      request.write(Buffer.alloc(1));
      // No end: authentication must not wait for the rest of an archive.
    });
    expect(response.statusCode).toBe(403);
    response.resume();
  });

  it("answers a streamed route's GET without reading the upload it carries", async () => {
    let body: ReadableStream<Uint8Array> | null | undefined;
    const { port } = await serve({
      streamBody: () => true,
      handler: async (request) => {
        body = request.body;
        return new Response(null, { status: 405 });
      },
    });
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = httpRequest(
        `http://127.0.0.1:${port}/import`,
        { method: "GET", headers: { "content-length": "1048576" } },
        resolve,
      );
      request.on("error", reject);
      request.write(Buffer.alloc(1));
      // No end: the answer must not wait for the rest of the upload.
    });
    expect(response.statusCode).toBe(405);
    expect(response.headers.connection).toBe("close");
    expect(body).toBeNull();
    response.resume();
  });

  it("streams uploads larger than its ordinary buffering cap with prepared headers", async () => {
    const { port } = await serve({
      streamBody: () => true,
      prepareHeaders: (headers) => headers.set("x-trusted", "server"),
      handler: async (request) => {
        expect(request.headers.get("x-trusted")).toBe("server");
        let bytes = 0;
        for await (const chunk of request.body!) bytes += chunk.byteLength;
        return Response.json({ bytes });
      },
    });
    const response = await fetch(`http://127.0.0.1:${port}/import`, {
      method: "POST",
      body: Buffer.alloc(2048),
    });
    expect(await response.json()).toEqual({ bytes: 2048 });
  });

  it("disposes an errored response returned after its client disconnected", async () => {
    let entered!: () => void, cancellationAwaited!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const completed = new Promise<void>((resolve) => {
      cancellationAwaited = resolve;
    });
    const { port } = await serve({
      handler: async (request) => {
        if (new URL(request.url).pathname === "/health") return Response.json({ ok: true });
        await new Promise<void>((resolve) => {
          request.signal.addEventListener("abort", () => resolve(), { once: true });
          entered();
        });
        const response = new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("retired response"));
            },
          }),
        );
        const cancel = response.body!.cancel.bind(response.body!);
        vi.spyOn(response.body!, "cancel").mockImplementation(
          () =>
            ({
              catch(onRejected: (error: Error) => void) {
                const cancelled = cancel().catch(onRejected);
                return {
                  then(resolve: () => void, reject: (error: unknown) => void) {
                    cancelled.then(() => {
                      cancellationAwaited();
                      resolve();
                    }, reject);
                  },
                };
              },
            }) as unknown as Promise<void>,
        );
        return response;
      },
    });
    const request = httpRequest(`http://127.0.0.1:${port}/park`);
    request.on("error", () => {});
    request.end();
    await started;
    request.destroy();
    await completed;
    expect(await (await fetch(`http://127.0.0.1:${port}/health`)).json()).toEqual({ ok: true });
  });

  it("passes raw request and response bytes through untouched", async () => {
    const bytes = Uint8Array.from([0, 1, 2, 253, 254, 255, 128, 200]);
    let received: Uint8Array | undefined;
    const { port } = await serve({
      handler: async (request) => {
        received = new Uint8Array(await request.arrayBuffer());
        return new Response(Buffer.from(received), {
          headers: { "x-echo": "1", [DRAIN_TIMEOUT_HEADER]: "1" },
        });
      },
    });
    const response = await fetch(`http://127.0.0.1:${port}/blob`, { method: "PUT", body: bytes });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-echo")).toBe("1");
    expect(
      response.headers.has(DRAIN_TIMEOUT_HEADER),
      "the drain timeout stays on the server",
    ).toBe(false);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(received).toEqual(bytes);
  });

  it("streams headers and the first chunk before the body completes", async () => {
    let finish: (() => void) | undefined;
    const { port } = await serve({
      handler: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(1024).fill(0x61));
              finish = () => {
                controller.enqueue(new Uint8Array(1024).fill(0x62));
                controller.close();
              };
            },
          }),
          { headers: { "content-type": "application/octet-stream" } },
        ),
    });
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      httpRequest(`http://127.0.0.1:${port}/stream`, resolve).once("error", reject).end();
    });
    const chunk = await firstChunk(response);
    expect(response.statusCode).toBe(200);
    expect(response.complete).toBe(false);
    expect(chunk.every((byte) => byte === 0x61)).toBe(true);
    const rest: Buffer[] = [];
    const ended = new Promise<void>((resolve) => response.once("end", resolve));
    response.on("data", (data: Buffer) => rest.push(Buffer.from(data)));
    finish!();
    await ended;
    expect(Buffer.concat(rest).every((byte) => byte === 0x62)).toBe(true);
  });

  it("cancels the source stream when the client disconnects mid-body", async () => {
    let cancelled = false;
    const { port } = await serve({
      handler: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(1024).fill(1));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    });
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      httpRequest(`http://127.0.0.1:${port}/stream`, resolve).once("error", reject).end();
    });
    await firstChunk(response);
    response.destroy();
    await new Promise<void>((resolve) => {
      const poll = (): void => {
        if (cancelled) resolve();
        else setTimeout(poll, 5);
      };
      poll();
    });
    expect(cancelled).toBe(true);
  });

  it("aborts the request signal when the client disconnects", async () => {
    let signal: AbortSignal | undefined;
    let release: (() => void) | undefined;
    const { port } = await serve({
      handler: (request) => {
        signal = request.signal;
        return new Promise<Response>((resolve) => {
          release = () => resolve(new Response("late"));
          request.signal.addEventListener("abort", () =>
            resolve(new Response(null, { status: 499 })),
          );
        });
      },
    });
    const socket = connect(port, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write("GET /park HTTP/1.1\r\nHost: test\r\n\r\n");
    await new Promise<void>((resolve) => {
      const poll = (): void => (signal ? resolve() : void setTimeout(poll, 5));
      poll();
    });
    socket.destroy();
    await new Promise<void>((resolve) => {
      const poll = (): void => (signal!.aborted ? resolve() : void setTimeout(poll, 5));
      poll();
    });
    expect(signal!.reason).toBeInstanceOf(ClientClosedRequest);
    release?.();
  });

  it("aborts without the client's reason when the server closes its own connections at shutdown", async () => {
    let signal: AbortSignal | undefined;
    const { port, server } = await serve({
      handler: (request) => {
        signal = request.signal;
        return new Promise<Response>((resolve) => {
          request.signal.addEventListener("abort", () =>
            resolve(new Response(null, { status: 503 })),
          );
        });
      },
    });
    const socket = connect(port, "127.0.0.1");
    socket.on("error", () => undefined);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write("GET /park HTTP/1.1\r\nHost: test\r\n\r\n");
    await new Promise<void>((resolve) => {
      const poll = (): void => (signal ? resolve() : void setTimeout(poll, 5));
      poll();
    });
    server.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      const poll = (): void => (signal!.aborted ? resolve() : void setTimeout(poll, 5));
      poll();
    });
    expect(signal!.reason).toMatchObject({ name: "AbortError" });
    expect(signal!.reason).not.toBeInstanceOf(ClientClosedRequest);
    socket.destroy();
  });

  it("refuses an upload as it crosses the cap and closes the socket", async () => {
    let readFailed = false;
    const { port } = await serve({
      maxBodyBytes: () => 96 * 1024,
      handler: async (request) => {
        await request.arrayBuffer().catch(() => {
          readFailed = true;
        });
        return new Response("ok");
      },
    });
    const socket = connect(port, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    const raw: Buffer[] = [];
    socket.on("data", (data: Buffer) => raw.push(Buffer.from(data)));
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.write("PUT /blob HTTP/1.1\r\nHost: test\r\nTransfer-Encoding: chunked\r\n\r\n");
    const chunk = Buffer.alloc(64 * 1024, "x");
    socket.write(`${chunk.length.toString(16)}\r\n`);
    socket.write(chunk);
    socket.write("\r\n");
    socket.write(`${chunk.length.toString(16)}\r\n`);
    socket.write(chunk);
    socket.write("\r\n");
    await closed;
    const text = Buffer.concat(raw).toString("utf8");
    expect(text).toMatch(/^HTTP\/1\.1 413/u);
    expect(text).toMatch(/\r\nconnection: close\r\n/iu);
    expect(text).toContain('{"ok":false,"error":"too large"}');
    expect(readFailed).toBe(true);
  });

  it("refuses an upload whose declared length is over the cap without running the handler", async () => {
    const handler = vi.fn(async () => new Response("ok"));
    const { port } = await serve({ maxBodyBytes: () => 1024, handler });
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = httpRequest(
        `http://127.0.0.1:${port}/blob`,
        { method: "PUT", headers: { "content-length": "2048" } },
        resolve,
      );
      request.on("error", reject);
      request.write(Buffer.alloc(1));
    });
    expect(response.statusCode).toBe(413);
    expect(response.headers.connection).toBe("close");
    response.resume();
    expect(handler).not.toHaveBeenCalled();
  });

  it("runs a small body's handler only once the body has arrived, outside the budget", async () => {
    let entered = 0;
    const bodies: string[] = [];
    const sockets: IncomingMessage["socket"][] = [];
    const { port, server } = await serve({
      maxBodyBytes: () => 16 * 1024,
      bodiesInFlight: { maxBytes: 1, maxBytesPerCaller: 1, caller: () => "" },
      // A handler that takes a slot before it checks its caller.
      handler: async (request) => {
        entered++;
        bodies.push(await request.text());
        return new Response(null);
      },
    });
    server.on("connection", (socket) => sockets.push(socket));
    const head = ["POST /desktop-ready HTTP/1.1", "Host: test", "Content-Length: 4", "", ""].join(
      "\r\n",
    );
    const socket = connect(port, "127.0.0.1");
    const raw: Buffer[] = [];
    socket.on("data", (data: Buffer) => raw.push(Buffer.from(data)));
    socket.write(head + "ab");
    await vi.waitFor(() => expect(sockets[0]?.bytesRead).toBe(head.length + 2));
    expect(entered).toBe(0);
    socket.write("cd");
    await vi.waitFor(() => expect(Buffer.concat(raw).toString("utf8")).toMatch(/^HTTP\/1\.1 200/u));
    expect(bodies).toEqual(["abcd"]);
    socket.destroy();
  });

  it("gives a POST that frames no body a null body", async () => {
    const bodies: Array<ReadableStream<Uint8Array> | null> = [];
    const { port } = await serve({
      handler: async (request) => {
        bodies.push(request.body);
        return new Response(null);
      },
    });
    const response = await fetch(`http://127.0.0.1:${port}/handoff`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(bodies).toEqual([null]);
  });

  it("delivers the answer of a handler that stops reading at its own smaller limit", async () => {
    const { port } = await serve({
      handler: async (request) => {
        const reader = request.body!.getReader();
        await reader.read();
        await reader.cancel();
        return new Response(null, { status: 413 });
      },
    });
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = httpRequest(`http://127.0.0.1:${port}/small`, { method: "POST" }, resolve);
      request.on("error", reject);
      request.end(Buffer.alloc(512 * 1024));
    });
    expect(response.statusCode).toBe(413);
    response.resume();
  });

  it("never reads the upload of a caller its handler refuses or keeps waiting", async () => {
    const uploads = 8;
    const size = 4 * 1024 * 1024;
    let admit!: () => void;
    const admission = new Promise<void>((resolve) => {
      admit = resolve;
    });
    const sockets: IncomingMessage["socket"][] = [];
    const statuses: number[] = [];
    const { port, server } = await serve({
      maxBodyBytes: () => size,
      handler: async () => {
        await admission;
        return new Response(null, { status: 401 });
      },
    });
    server.on("request", (incoming: IncomingMessage) => sockets.push(incoming.socket));
    const payload = Buffer.alloc(size - 1);
    // Each client is still sending when it is refused, and must still read the refusal.
    const clients = Array.from({ length: uploads }, () => {
      const request = httpRequest(`http://127.0.0.1:${port}/log`, {
        method: "POST",
        headers: { "content-length": String(size) },
      });
      request.on("error", () => undefined);
      request.on("response", (response) => {
        statuses.push(response.statusCode ?? 0);
        response.resume();
      });
      request.write(payload);
      return request;
    });
    await vi.waitFor(() => expect(sockets).toHaveLength(uploads));
    // Give the clients time to push what the server will accept.
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    const readWhileWaiting = sockets.reduce((total, socket) => total + socket.bytesRead, 0);
    admit();
    await vi.waitFor(() => expect(statuses).toEqual(Array(uploads).fill(401)));
    await vi.waitFor(() => expect(sockets.every((socket) => socket.destroyed)).toBe(true), {
      timeout: 5_000,
    });
    for (const client of clients) client.destroy();
    // Each connection holds at most a stream window, not its upload.
    expect(readWhileWaiting).toBeLessThan(uploads * 512 * 1024);
  });

  it("keeps the bodies that handlers have read within the shared budget and each caller's share", async () => {
    const releases: Array<() => void> = [];
    const { port } = await serve({
      bodiesInFlight: {
        maxBytes: 96 * 1024,
        maxBytesPerCaller: 64 * 1024,
        caller: (headers) => headers.get("authorization") ?? "",
      },
      busy: () => Response.json({ ok: false, error: "busy" }, { status: 503 }),
      handler: async (request) => {
        const bytes = (await request.arrayBuffer()).byteLength;
        // Holding the answer keeps this body counted.
        await new Promise<void>((resolve) => releases.push(resolve));
        return Response.json({ bytes });
      },
    });
    const send = (caller: string) =>
      new Promise<IncomingMessage>((resolve, reject) => {
        httpRequest(
          `http://127.0.0.1:${port}/log`,
          { method: "POST", headers: { authorization: caller } },
          resolve,
        )
          .on("error", reject)
          .end(Buffer.alloc(48 * 1024));
      });
    const refused = async (pending: Promise<IncomingMessage>) => {
      const response = await pending;
      response.resume();
      return [response.statusCode, response.headers.connection];
    };
    const first = send("a");
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    // Past caller a's share, while the budget still has room.
    expect(await refused(send("a"))).toEqual([503, "close"]);
    const second = send("b");
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    // Past the budget, though caller c holds nothing.
    expect(await refused(send("c"))).toEqual([503, "close"]);
    releases[0]!();
    expect((await first).statusCode).toBe(200);
    (await first).resume();
    // Answering a releases its bytes for anyone.
    const third = send("c");
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    releases[1]!();
    releases[2]!();
    expect((await second).statusCode).toBe(200);
    expect((await third).statusCode).toBe(200);
    (await second).resume();
    (await third).resume();
  });

  it("returns a timed-out upload's bytes to the budget as it refuses the upload", async () => {
    const received = new Map<string, number>();
    const { port, server } = await serve({
      bodiesInFlight: {
        maxBytes: 64 * 1024,
        maxBytesPerCaller: 64 * 1024,
        caller: (headers) => headers.get("authorization") ?? "",
      },
      busy: () => new Response(null, { status: 503 }),
      handler: async (request) => {
        const caller = request.headers.get("authorization") ?? "";
        const reader = request.body!.getReader();
        for (;;) {
          const read = await reader.read().catch(() => ({ done: true as const }));
          if (read.done) break;
          received.set(caller, (received.get(caller) ?? 0) + read.value.byteLength);
        }
        return new Response(null);
      },
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const send = (caller: string, bytes: number, length = bytes) =>
      new Promise<IncomingMessage>((resolve, reject) => {
        const request = httpRequest(
          `http://127.0.0.1:${port}/log`,
          { method: "POST", headers: { authorization: caller, "content-length": String(length) } },
          resolve,
        );
        request.on("error", reject);
        request.write(Buffer.alloc(bytes));
        if (bytes === length) request.end();
      });
    const arrived = new Promise<void>((resolve) => server.once("request", () => resolve()));
    const stalled = send("a", 48 * 1024, 60 * 1024);
    await arrived;
    await vi.waitFor(() => expect(received.get("a")).toBe(48 * 1024));
    const busy = await send("b", 48 * 1024);
    expect(busy.statusCode).toBe(503);
    busy.resume();
    await vi.advanceTimersByTimeAsync(300_000);
    const timedOut = await stalled;
    expect(timedOut.statusCode).toBe(408);
    timedOut.resume();
    // Before the refused connection lingers out, and before any collection.
    const admitted = await send("b", 48 * 1024);
    expect(admitted.statusCode).toBe(200);
    admitted.resume();
  });

  it("answers a throwing handler with the failure response for its URL", async () => {
    const { port } = await serve({
      handler: async () => {
        throw new Error("boom");
      },
      failure: (url) =>
        Response.json({ ok: false, error: "failed", path: url.pathname }, { status: 500 }),
    });
    const response = await fetch(`http://127.0.0.1:${port}/x`);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('{"ok":false,"error":"failed","path":"/x"}');
  });

  it("forwards every set-cookie header separately and lets prepareHeaders stamp the client", async () => {
    let seen: string | null = null;
    const { port } = await serve({
      handler: async (request) => {
        seen = request.headers.get("x-client");
        const headers = new Headers();
        headers.append("set-cookie", "a=1");
        headers.append("set-cookie", "b=2");
        return new Response("ok", { headers });
      },
      prepareHeaders: (headers, incoming) => {
        headers.set("x-client", incoming.socket.remoteAddress ?? "unknown");
      },
    });
    const response = await fetch(`http://127.0.0.1:${port}/cookies`);
    expect(response.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
    expect(seen).toBe("127.0.0.1");
  });
});
