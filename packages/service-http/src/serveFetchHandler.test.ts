import { request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serveFetchHandler, type ServeFetchHandlerOptions } from "./serveFetchHandler";

const servers: Server[] = [];

afterEach(async () => {
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
    maxBodyBytes: () => 1024,
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
  it("disposes an errored response returned after its client disconnected", async () => {
    let entered!: () => void, cancellationAwaited!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const completed = new Promise<void>(resolve => { cancellationAwaited = resolve; });
    const { port } = await serve({ handler: async request => {
      if (new URL(request.url).pathname === "/health") return Response.json({ ok: true });
      await new Promise<void>(resolve => {
        request.signal.addEventListener("abort", () => resolve(), { once: true });
        entered();
      });
      const response = new Response(new ReadableStream({ start(controller) { controller.error(new Error("retired response")); } }));
      vi.spyOn(response.body!, "cancel").mockImplementation(() => ({
        catch(onRejected: (error: Error) => void) {
          onRejected(new Error("retired response"));
          return { then(resolve: () => void) { cancellationAwaited(); resolve(); } };
        },
      }) as unknown as Promise<void>);
      return response;
    } });
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
        return new Response(Buffer.from(received), { headers: { "x-echo": "1" } });
      },
    });
    const response = await fetch(`http://127.0.0.1:${port}/blob`, { method: "PUT", body: bytes });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-echo")).toBe("1");
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
          request.signal.addEventListener("abort", () => resolve(new Response(null, { status: 499 })));
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
    expect(signal!.aborted).toBe(true);
    release?.();
  });

  it("refuses an upload as it crosses the cap and closes the socket", async () => {
    let handled = false;
    const { port } = await serve({
      handler: async () => {
        handled = true;
        return new Response("ok");
      },
    });
    const socket = connect(port, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    const raw: Buffer[] = [];
    socket.on("data", (data: Buffer) => raw.push(Buffer.from(data)));
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.write("PUT /blob HTTP/1.1\r\nHost: test\r\nTransfer-Encoding: chunked\r\n\r\n");
    const chunk = Buffer.alloc(600, "x");
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
    expect(handled).toBe(false);
  });

  it("answers a throwing handler with the failure response", async () => {
    const { port } = await serve({
      handler: async () => {
        throw new Error("boom");
      },
    });
    const response = await fetch(`http://127.0.0.1:${port}/x`);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('{"ok":false,"error":"failed"}');
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
