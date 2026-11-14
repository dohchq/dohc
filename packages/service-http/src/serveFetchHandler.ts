import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { DRAIN_TIMEOUT_HEADER, pipeResponseBody } from "./pipeResponseBody";
import type { RequestLog } from "./requestLog";

export interface ServeFetchHandlerOptions {
  handler: (request: Request) => Promise<Response>;
  /** The most request-body bytes a handler may read for this URL before the upload is refused. */
  maxBodyBytes: (url: URL) => number;
  /**
   * The body bytes that unanswered requests may have read at once, in all and
   * for one caller. A request whose next bytes would pass either is refused as
   * busy. Unbounded without it.
   */
  bodiesInFlight?: {
    maxBytes: number;
    maxBytesPerCaller: number;
    /**
     * Names the credential a request presents, the same for each way of
     * presenting it, so one caller cannot take several shares.
     */
    caller: (headers: Headers) => string;
  };
  /**
   * Dispatch without the adapter's size and receipt bounds, for any method.
   * These handlers must authenticate before reading and bound body size and
   * receipt time themselves. A GET or HEAD reaches them with no body, and any
   * upload it carries stays unread.
   */
  streamBody?: (url: URL, method: string) => boolean;
  /** The answer to an upload that crosses the cap; the socket closes after it flushes. */
  oversized: (url: URL) => Response;
  /** The answer when the handler throws. */
  failure: (url: URL) => Response;
  /** The answer to an upload that does not arrive in time; a bare 408 without it. */
  timedOut?: (url: URL) => Response;
  /** The answer to an upload refused because bodies in flight are at their budget; a bare 503 without it. */
  busy?: (url: URL) => Response;
  /** Sets request headers the handler trusts, such as the client address. */
  prepareHeaders?: (headers: Headers, incoming: IncomingMessage, url: URL) => void;
  /** Gets one line for each answer, naming the route the handler marked. */
  requestLog?: Pick<RequestLog, "write">;
}

/**
 * The request signal's abort reason when its connection closes while the server is listening, as when the client leaves.
 * A connection closed at shutdown, after the server stops listening, aborts without it.
 */
export class ClientClosedRequest extends DOMException {
  constructor() {
    super("The client closed the request", "AbortError");
  }
}

/**
 * The request signal's abort reason, and its body's error, when the server refused the body and already sent the
 * refusal. The handler's own answer to that request is never sent.
 */
export class RefusedRequest extends DOMException {}

const BODY_RECEIPT_MS = 300_000;
const REFUSAL_LINGER_MS = 2_000;
// The stream window a body read on demand already holds.
const READ_FIRST_BYTES = 64 * 1024;

/**
 * A node:http server over a fetch-style handler. The handler starts as soon
 * as the headers arrive, and a body is read only as the handler reads it, so
 * a handler that refuses its caller first never receives the upload. A body
 * capped at one stream window costs no more read in full, so it arrives whole
 * before its handler runs, and a slow sender holds no slot its handler takes.
 * Bodies are bounded in size and receipt time, and bodies read on demand also
 * in bytes in flight, unless a handler opts into bounding its own stream. Raw
 * bytes pass through untouched in both directions. A client disconnect aborts
 * the request signal.
 */
export function serveFetchHandler(options: ServeFetchHandlerOptions): Server {
  let bytesInFlight = 0;
  const callerBytesInFlight = new Map<string, number>();
  // Headers stay bounded to 60s; the adapter or a streaming handler bounds the body.
  const server = createServer(
    { requestTimeout: 0, headersTimeout: 60_000 },
    (incoming, outgoing) => {
      let url: URL;
      try {
        url = new URL(incoming.url ?? "/", `http://${incoming.headers.host ?? "localhost"}`);
      } catch {
        outgoing.destroy();
        return;
      }
      const arrivedAtMs = Date.now();
      const method = incoming.method ?? "GET";
      let answered = false;
      let reserved = 0;
      let caller = "";
      const release = () => {
        if (reserved === 0) return;
        bytesInFlight -= reserved;
        const left = (callerBytesInFlight.get(caller) ?? 0) - reserved;
        if (left > 0) callerBytesInFlight.set(caller, left);
        else callerBytesInFlight.delete(caller);
        reserved = 0;
      };
      let request: Request | undefined;
      const answer = (response: Response, closeAfter?: IncomingMessage): Promise<void> => {
        if (answered) return response.body?.cancel().catch(() => undefined) ?? Promise.resolve();
        answered = true;
        release();
        options.requestLog?.write(request, method, response.status, arrivedAtMs);
        return writeResponse(response, outgoing, closeAfter);
      };
      const disconnect = new AbortController();
      // A server that has stopped listening is shutting down and closes its own connections.
      const closed = () =>
        disconnect.abort(server.listening ? new ClientClosedRequest() : undefined);
      outgoing.once("close", () => {
        release();
        closed();
      });
      incoming.on("error", () => {
        closed();
        outgoing.destroy();
      });
      const headers = new Headers(incoming.headers as Record<string, string>);
      options.prepareHeaders?.(headers, incoming, url);
      const hasBody = method !== "GET" && method !== "HEAD";
      // A request that frames no body reaches its handler with a null body.
      const framed =
        incoming.headers["transfer-encoding"] !== undefined ||
        Number(incoming.headers["content-length"] ?? 0) > 0;
      const upload = () =>
        Readable.toWeb(incoming, {
          strategy: { highWaterMark: 64 * 1024, size: (chunk: Uint8Array) => chunk.byteLength },
        }) as ReadableStream<Uint8Array>;
      let body: ReadableStream<Uint8Array> | null = null;
      let readFirst = false;
      if (options.streamBody?.(url, method)) {
        body = hasBody ? upload() : null;
      } else if (hasBody && framed) {
        const maxBodyBytes = options.maxBodyBytes(url);
        readFirst = maxBodyBytes <= READ_FIRST_BYTES;
        const declared = Number(incoming.headers["content-length"]);
        if (Number.isFinite(declared) && declared > maxBodyBytes) {
          void answer(options.oversized(url), incoming);
          return;
        }
        const refuse = (response: Response, reason: RefusedRequest): RefusedRequest => {
          clearTimeout(bodyTimer);
          disconnect.abort(reason);
          void answer(response, incoming);
          return reason;
        };
        const bodyTimer = setTimeout(() => {
          bounded.abort(
            refuse(
              options.timedOut?.(url) ?? new Response(null, { status: 408 }),
              new RefusedRequest("Request body timed out", "TimeoutError"),
            ),
          );
        }, BODY_RECEIPT_MS);
        bodyTimer.unref();
        const clearBodyTimer = () => clearTimeout(bodyTimer);
        incoming.once("end", clearBodyTimer);
        incoming.once("close", clearBodyTimer);
        outgoing.once("close", clearBodyTimer);
        const bounded = new AbortController();
        let received = 0;
        body = upload().pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            start(controller) {
              bounded.signal.addEventListener(
                "abort",
                () => controller.error(bounded.signal.reason),
                {
                  once: true,
                },
              );
            },
            transform(chunk, controller) {
              received += chunk.byteLength;
              if (received > maxBodyBytes) {
                controller.error(
                  refuse(
                    options.oversized(url),
                    new RefusedRequest("Request body too large", "AbortError"),
                  ),
                );
                return;
              }
              const budget = options.bodiesInFlight;
              if (budget && !readFirst) {
                if (reserved === 0) caller = budget.caller(headers);
                const callerBytes = callerBytesInFlight.get(caller) ?? 0;
                if (
                  bytesInFlight + chunk.byteLength > budget.maxBytes ||
                  callerBytes + chunk.byteLength > budget.maxBytesPerCaller
                ) {
                  controller.error(
                    refuse(
                      options.busy?.(url) ?? new Response(null, { status: 503 }),
                      new RefusedRequest(
                        "Request bodies in flight are at their budget",
                        "AbortError",
                      ),
                    ),
                  );
                  return;
                }
                bytesInFlight += chunk.byteLength;
                callerBytesInFlight.set(caller, callerBytes + chunk.byteLength);
                reserved += chunk.byteLength;
              }
              controller.enqueue(chunk);
            },
          }),
          // A handler that stops reading early still answers before the
          // connection closes.
          { preventCancel: true },
        );
      }
      const start = (body: ReadableStream<Uint8Array> | ArrayBuffer | null) => {
        const init: RequestInit & { duplex: "half" } = {
          method,
          headers,
          signal: disconnect.signal,
          body,
          duplex: "half",
        };
        try {
          request = new Request(url, init);
        } catch {
          incoming.destroy();
          outgoing.destroy();
          return;
        }
        // A refusal may leave the upload still arriving. Flush its response
        // before closing the connection; never drain an unauthenticated upload.
        void options
          .handler(request)
          .then((response) => answer(response, incoming.complete ? undefined : incoming))
          .catch(() => {
            if (!outgoing.destroyed) void answer(options.failure(url), incoming);
          });
      };
      if (body && readFirst) {
        // A refused or abandoned read has already been answered or closed.
        void new Response(body).arrayBuffer().then(
          (bytes) => start(bytes.byteLength > 0 ? bytes : null),
          () => undefined,
        );
      } else start(body);
    },
  );
  return server;
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
    if (key !== "set-cookie" && key !== DRAIN_TIMEOUT_HEADER) outgoing.setHeader(key, value);
  }
  const setCookies = response.headers.getSetCookie();
  if (setCookies.length > 0) outgoing.setHeader("set-cookie", setCookies);
  if (closeAfter) {
    // Flush the refusal and close our side, leaving the rest of the upload
    // unread. Node would destroy the connection as soon as the answer flushes;
    // bytes the client is still sending would then reset it, which can discard
    // the answer before the client reads it. Drop the connection a moment later.
    const socket = closeAfter.socket;
    socket.destroySoon = () => {
      socket.end();
      setTimeout(() => socket.destroy(), REFUSAL_LINGER_MS).unref();
    };
    outgoing.setHeader("connection", "close");
    outgoing.end(Buffer.from(await response.arrayBuffer()));
    return;
  }
  await pipeResponseBody(response, outgoing);
}
