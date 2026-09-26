import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeResponseBody } from "./pipeResponseBody";

export interface ServeFetchHandlerOptions {
  handler: (request: Request) => Promise<Response>;
  /** The most request-body bytes buffered for this URL before the upload is refused. */
  maxBodyBytes: (url: URL) => number;
  /**
   * Dispatch without buffering, for any method. These handlers must
   * authenticate before reading and bound body size and receipt time. A GET
   * or HEAD reaches them with no body, and any upload it carries stays unread.
   */
  streamBody?: (url: URL, method: string) => boolean;
  /** The answer to an upload that crosses the cap; the socket closes after it flushes. */
  oversized: (url: URL) => Response;
  /** The answer when the handler throws. */
  failure: () => Response;
  /** Sets request headers the handler trusts, such as the client address. */
  prepareHeaders?: (headers: Headers, incoming: IncomingMessage, url: URL) => void;
}

/**
 * A node:http server over a fetch-style handler. Bodies are buffered under a
 * cap unless a handler opts into bounded streaming. Raw bytes pass through
 * untouched in both directions. A client disconnect aborts the request signal.
 */
export function serveFetchHandler(options: ServeFetchHandlerOptions): Server {
  // Streaming handlers own their receive deadline. Ordinary bodies retain a
  // five-minute bound after headers; headers themselves remain bounded to 60s.
  return createServer(options.streamBody ? { requestTimeout: 0, headersTimeout: 60_000 } : {}, (incoming, outgoing) => {
    let url: URL;
    try {
      url = new URL(incoming.url ?? "/", `http://${incoming.headers.host ?? "localhost"}`);
    } catch {
      outgoing.destroy();
      return;
    }
    const maxBodyBytes = options.maxBodyBytes(url);
    const chunks: Buffer[] = [];
    let received = 0;
    let rejected = false;
    const disconnect = new AbortController();
    outgoing.once("close", () => disconnect.abort());
    incoming.on("error", () => {
      rejected = true;
      disconnect.abort();
      outgoing.destroy();
    });
    const method = incoming.method ?? "GET";
    if (options.streamBody?.(url, method)) {
      const headers = new Headers(incoming.headers as Record<string, string>);
      options.prepareHeaders?.(headers, incoming, url);
      const body = method === "GET" || method === "HEAD" ? null : Readable.toWeb(incoming, {
        strategy: { highWaterMark: 64 * 1024, size: (chunk: Uint8Array) => chunk.byteLength },
      }) as ReadableStream<Uint8Array>;
      const init: RequestInit & { duplex: "half" } = { method, headers, signal: disconnect.signal, body, duplex: "half" };
      let request: Request;
      try { request = new Request(url, init); }
      catch { incoming.destroy(); outgoing.destroy(); return; }
      // An admission refusal may leave the upload unread. Flush its response
      // before closing the connection; never drain an unauthenticated archive.
      void options.handler(request)
        .then(response => writeResponse(response, outgoing, incoming.readableEnded ? undefined : incoming))
        .catch(() => {
          if (!outgoing.destroyed) void writeResponse(options.failure(), outgoing, incoming);
        });
      return;
    }
    const bodyTimer = options.streamBody ? setTimeout(() => {
      if (rejected) return;
      rejected = true;
      chunks.length = 0;
      disconnect.abort(new DOMException("Request body timed out", "TimeoutError"));
      void writeResponse(new Response(null, { status: 408 }), outgoing, incoming);
    }, 300_000) : undefined;
    bodyTimer?.unref();
    const clearBodyTimer = () => clearTimeout(bodyTimer);
    incoming.once("end", clearBodyTimer);
    incoming.once("close", clearBodyTimer);
    outgoing.once("close", clearBodyTimer);
    incoming.on("data", (chunk: Buffer) => {
      if (rejected) return;
      received += chunk.length;
      if (received > maxBodyBytes) {
        rejected = true;
        clearBodyTimer();
        chunks.length = 0;
        void writeResponse(options.oversized(url), outgoing, incoming);
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    incoming.on("end", () => {
      if (rejected) return;
      const method = incoming.method ?? "GET";
      const headers = new Headers(incoming.headers as Record<string, string>);
      options.prepareHeaders?.(headers, incoming, url);
      let request: Request;
      try {
        request = new Request(url, {
          method,
          headers,
          signal: disconnect.signal,
          body:
            method === "GET" || method === "HEAD" || chunks.length === 0
              ? undefined
              : Buffer.concat(chunks),
        });
      } catch {
        outgoing.destroy();
        return;
      }
      void options
        .handler(request)
        .then((response) => writeResponse(response, outgoing))
        .catch(() => {
          if (!outgoing.destroyed) void writeResponse(options.failure(), outgoing);
        });
    });
  });
}

async function writeResponse(
  response: Response,
  outgoing: ServerResponse,
  closeAfter?: IncomingMessage,
): Promise<void> {
  if (outgoing.destroyed) {
    await response.body?.cancel().catch(() => undefined);
    return;
  }
  outgoing.statusCode = response.status;
  for (const [key, value] of response.headers) {
    if (key !== "set-cookie") outgoing.setHeader(key, value);
  }
  const setCookies = response.headers.getSetCookie();
  if (setCookies.length > 0) outgoing.setHeader("set-cookie", setCookies);
  if (closeAfter) {
    // Flush the refusal for a well-behaved client, then drop the socket so the
    // sender cannot keep streaming.
    outgoing.setHeader("connection", "close");
    outgoing.end(Buffer.from(await response.arrayBuffer()), () => closeAfter.destroy());
    return;
  }
  if (!response.body) {
    outgoing.end();
    return;
  }
  await pipeResponseBody(response.body, outgoing);
}
