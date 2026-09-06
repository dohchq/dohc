import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pipeResponseBody } from "./pipeResponseBody";

export interface ServeFetchHandlerOptions {
  handler: (request: Request) => Promise<Response>;
  /** The most request-body bytes buffered for this URL before the upload is refused. */
  maxBodyBytes: (url: URL) => number;
  /** The answer to an upload that crosses the cap; the socket closes after it flushes. */
  oversized: (url: URL) => Response;
  /** The answer when the handler throws. */
  failure: () => Response;
  /** Sets request headers the handler trusts, such as the client address. */
  prepareHeaders?: (headers: Headers, incoming: IncomingMessage, url: URL) => void;
}

/**
 * A node:http server over a fetch-style handler. The body is buffered under a
 * streaming cap so an oversized upload is refused as it arrives, raw bytes
 * pass through untouched in both directions, and a client disconnect aborts
 * the request signal so parked work releases at once.
 */
export function serveFetchHandler(options: ServeFetchHandlerOptions): Server {
  return createServer((incoming, outgoing) => {
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
    incoming.on("data", (chunk: Buffer) => {
      if (rejected) return;
      received += chunk.length;
      if (received > maxBodyBytes) {
        rejected = true;
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
    void response.body?.cancel();
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
