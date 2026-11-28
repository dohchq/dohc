import type { ServerProblemKind } from "@dohc/interface-words/account";

// Requests to the person's dohc server. Every request names the server's origin and carries the sign-in's Bearer
// token, never a cookie, because the server refuses account requests that carry one. A request belongs to one
// sign-in: when that sign-in ends, its signal aborts every request still in flight, and each answer that arrives
// later rejects as cancelled instead of reaching the screen.

/**
 * Why a request gave no usable answer:
 * - `signed-out`: the server answered 401, so this sign-in has ended;
 * - `not-found`: 404, which the server also answers for something this account doesn't own;
 * - `server-busy`: 429, or any 5xx: the server failed for now, and the same request may work later;
 * - `offline`: no answer, or none in time;
 * - `refused`: any other status, such as a 400 for a request the server won't take;
 * - `invalid`: an answer the phone could not read;
 * - `cancelled`: the sign-in or the request was superseded first.
 */
export type ServerProblem =
  | "signed-out"
  | "not-found"
  | "server-busy"
  | "offline"
  | "refused"
  | "invalid"
  | "cancelled";

export class ServerError extends Error {
  /** `code` is the error code a refusal's answer named, such as `conflict`. */
  constructor(
    readonly problem: ServerProblem,
    readonly status: number | null = null,
    readonly code: string | null = null,
  ) {
    super(status === null ? problem : `${problem} (${status})`);
    this.name = "ServerError";
  }
}

/**
 * The problem a screen shows for a rejection, or null when it shows none: a cancelled request belongs to a sign-in
 * that has ended, and a 401 signs the phone out, which the whole app shows. Anything that isn't a ServerError reads
 * as a refusal.
 */
export function shownProblem(error: unknown): ServerProblemKind | null {
  if (!(error instanceof ServerError)) return "refused";
  switch (error.problem) {
    case "cancelled":
    case "signed-out":
      return null;
    case "not-found":
      return "refused";
    default:
      return error.problem;
  }
}

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** What the client needs of fetch: the app passes expo/fetch, which honours `credentials` and `redirect`. */
export interface FetchInit {
  readonly method: Method;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly credentials: "omit";
  readonly redirect: "error";
  readonly signal: AbortSignal;
}
export type Fetch = (
  url: string,
  init: FetchInit,
) => Promise<{
  readonly status: number;
  readonly headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
  arrayBuffer?(): Promise<ArrayBuffer>;
}>;

export const REQUEST_TIMEOUT_MS = 15_000;

async function fetchTimed(
  fetch: Fetch,
  url: string,
  init: Omit<FetchInit, "credentials" | "redirect" | "signal">,
  signal: AbortSignal,
  timeoutMs: number,
  keepAnswer = false,
): Promise<{
  readonly response: Awaited<ReturnType<Fetch>>;
  readonly timedOut: () => boolean;
  readonly done: () => void;
}> {
  if (signal.aborted) throw new ServerError("cancelled");
  const own = new AbortController();
  const abort = () => own.abort();
  if (!keepAnswer) signal.addEventListener("abort", abort);
  const timer = setTimeout(abort, timeoutMs);
  const done = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  };
  try {
    const response = await fetch(url, {
      ...init,
      credentials: "omit",
      redirect: "error",
      signal: own.signal,
    });
    return { response, timedOut: () => own.signal.aborted && !signal.aborted, done };
  } catch {
    done();
    throw new ServerError(signal.aborted ? "cancelled" : "offline");
  }
}

/**
 * Sends one JSON request and reads its JSON answer, and rejects with `offline` when nothing answers within the
 * timeout. Once `signal` aborts it rejects with `cancelled`, even when the answer has already arrived, unless
 * `keepAnswer` is set. Then a request already sent is never aborted, only timed out, and its answer is returned for
 * the caller to act on: an answer that made something on the server, such as a session, is never lost.
 */
export async function exchange(
  fetch: Fetch,
  url: string,
  request: {
    readonly method: Method;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: unknown;
    readonly signal: AbortSignal;
    readonly timeoutMs?: number;
    readonly keepAnswer?: boolean;
  },
): Promise<{ readonly status: number; readonly body: unknown }> {
  const { signal } = request;
  const { response, timedOut, done } = await fetchTimed(
    fetch,
    url,
    {
      method: request.method,
      headers: {
        accept: "application/json",
        ...(request.body === undefined ? {} : { "content-type": "application/json" }),
        ...request.headers,
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    },
    signal,
    request.timeoutMs ?? REQUEST_TIMEOUT_MS,
    request.keepAnswer,
  );
  try {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
      if (timedOut()) throw new ServerError("offline");
    }
    if (signal.aborted && !request.keepAnswer) throw new ServerError("cancelled");
    return { status: response.status, body };
  } finally {
    done();
  }
}

/** The problem for a status that isn't a success. */
export function statusProblem(
  status: number,
): Exclude<ServerProblem, "offline" | "invalid" | "cancelled"> {
  if (status === 401) return "signed-out";
  if (status === 404) return "not-found";
  if (status === 429 || status >= 500) return "server-busy";
  return "refused";
}

/** What one request adds to the sign-in's: its own signal, which aborts it alone, and a longer wait for a held answer. */
export interface SendOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/** What the phone uses of React Native's WebSocket. */
export interface LiveSocket {
  binaryType: string;
  readonly protocol: string;
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: ArrayBuffer): void;
  close(): void;
  addEventListener(type: "close", listener: () => void): void;
}
/** React Native's WebSocket takes headers as a third argument, which the DOM's type leaves out. */
export type OpenSocket = (
  url: string,
  protocols: readonly string[],
  options: { readonly headers: Readonly<Record<string, string>> },
) => LiveSocket;
const openNativeSocket: OpenSocket = (url, protocols, options) =>
  new (WebSocket as unknown as new (
    url: string,
    protocols: string[],
    options: { headers: Record<string, string> },
  ) => LiveSocket)(url, [...protocols], { headers: { ...options.headers } });

export interface ServerClient {
  readonly origin: string;
  /**
   * Opens a WebSocket to `path` on the server with the sign-in's token in its Authorization header, so the token stays
   * in this client. The socket closes when the sign-in ends.
   */
  liveSocket(path: string, protocols: readonly string[]): LiveSocket;
  /**
   * Sends a request with the sign-in's token, and resolves its answer as `read` validates it. `read` returns null
   * for an answer it can't use. A 401 ends the sign-in.
   */
  send<T>(
    method: Method,
    path: string,
    read: (body: unknown) => T | null,
    body?: unknown,
    options?: SendOptions,
  ): Promise<T>;
  /** Sends a request with the sign-in's Bearer token and returns raw response bytes, bounded by `maxBytes`. */
  bytes(
    method: Method,
    path: string,
    body?: unknown,
    options?: SendOptions & { readonly maxBytes?: number },
  ): Promise<Uint8Array>;
}

/** The error code a refusal's answer names, as the server's errors carry it: `{ ok: false, error, code }`. */
function refusalCode(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("code" in body)) return null;
  return typeof body.code === "string" && body.code.length <= 64 ? body.code : null;
}

async function withScopedSignals<T>(
  signals: readonly (AbortSignal | undefined)[],
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ending = new AbortController();
  const end = () => ending.abort();
  for (const signal of signals) {
    if (signal?.aborted) end();
    signal?.addEventListener("abort", end);
  }
  try {
    return await run(ending.signal);
  } finally {
    for (const signal of signals) signal?.removeEventListener("abort", end);
  }
}

export function createServerClient(options: {
  readonly origin: string;
  readonly token: string;
  readonly fetch: Fetch;
  /** Aborts when the sign-in ends. */
  readonly signal: AbortSignal;
  /** Called on a 401 from this sign-in. */
  readonly onSignedOut?: () => void;
  readonly timeoutMs?: number;
  readonly openSocket?: OpenSocket;
}): ServerClient {
  return {
    origin: options.origin,
    liveSocket(path, protocols) {
      if (options.signal.aborted) throw new ServerError("cancelled");
      const socket = (options.openSocket ?? openNativeSocket)(
        `${options.origin.replace(/^http/, "ws")}${path}`,
        protocols,
        { headers: { authorization: `Bearer ${options.token}` } },
      );
      const abort = () => socket.close();
      options.signal.addEventListener("abort", abort, { once: true });
      socket.addEventListener("close", () => options.signal.removeEventListener("abort", abort));
      return socket;
    },
    send(method, path, read, body, request) {
      return withScopedSignals([options.signal, request?.signal], async (signal) => {
        const answer = await exchange(options.fetch, `${options.origin}${path}`, {
          method,
          body,
          signal,
          timeoutMs: request?.timeoutMs ?? options.timeoutMs,
          headers: { authorization: `Bearer ${options.token}` },
        });
        if (answer.status < 200 || answer.status > 299) {
          const problem = statusProblem(answer.status);
          if (problem === "signed-out") options.onSignedOut?.();
          throw new ServerError(problem, answer.status, refusalCode(answer.body));
        }
        const value = read(answer.body);
        if (value === null) throw new ServerError("invalid", answer.status);
        return value;
      });
    },
    bytes(method, path, body, request) {
      return withScopedSignals([options.signal, request?.signal], async (signal) => {
        const { response, done } = await fetchTimed(
          options.fetch,
          `${options.origin}${path}`,
          {
            method,
            headers: {
              ...(body === undefined ? {} : { "content-type": "application/json" }),
              authorization: `Bearer ${options.token}`,
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          },
          signal,
          request?.timeoutMs ?? options.timeoutMs ?? REQUEST_TIMEOUT_MS,
        );
        try {
          if (response.status < 200 || response.status > 299) {
            const errBody = await response.json().catch(() => undefined);
            if (signal.aborted) throw new ServerError("cancelled");
            const problem = statusProblem(response.status);
            if (problem === "signed-out") options.onSignedOut?.();
            throw new ServerError(problem, response.status, refusalCode(errBody));
          }
          const limit = request?.maxBytes;
          const len = Number(response.headers?.get("content-length") ?? "");
          if (limit !== undefined && Number.isFinite(len) && len > limit)
            throw new ServerError("refused", 413, "payload_too_large");
          if (!response.arrayBuffer) throw new ServerError("invalid", response.status);
          const raw = await response.arrayBuffer().catch(() => {
            throw new ServerError(signal.aborted ? "cancelled" : "offline");
          });
          if (signal.aborted) throw new ServerError("cancelled");
          if (limit !== undefined && raw.byteLength > limit)
            throw new ServerError("refused", 413, "payload_too_large");
          return new Uint8Array(raw);
        } finally {
          done();
        }
      });
    },
  };
}

/** Requests whose results replace each other: each takes the next number, and only the latest may land. */
export function requestGenerations(): { next(): number; isLatest(request: number): boolean } {
  let latest = 0;
  return {
    next: () => ++latest,
    isLatest: (request) => request === latest,
  };
}
