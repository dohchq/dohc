import type { ServerProblemKind } from "@dohc/interface-words/account";

// Requests to the person's dohc server. Every request names the server's origin and carries the sign-in's Bearer
// token, never a cookie, because the server refuses account requests that carry one. A request belongs to one
// sign-in: when that sign-in ends, its signal aborts every request still in flight, and each answer that arrives
// later rejects as cancelled instead of reaching the screen.

/**
 * Why a request gave no usable answer:
 * - `signed-out`: the server answered 401, so this sign-in has ended;
 * - `not-found`: 404, which the server also answers for something this account doesn't own;
 * - `server-busy`: 503 or 429;
 * - `offline`: no answer, or none in time;
 * - `refused`: any other status;
 * - `invalid`: an answer the phone could not read;
 * - `cancelled`: the sign-in or the request was superseded first.
 */
export type ServerProblem = "signed-out" | "not-found" | "server-busy" | "offline" | "refused" | "invalid" | "cancelled";

export class ServerError extends Error {
  constructor(readonly problem: ServerProblem, readonly status: number | null = null) {
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

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Sends one JSON request and reads its JSON answer. It rejects with `cancelled` once `signal` aborts, even when
 * the answer has already arrived, and with `offline` when nothing answers within the timeout.
 */
export async function exchange(fetch: Fetch, url: string, request: {
  readonly method: "GET" | "POST" | "PATCH";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<{ readonly status: number; readonly body: unknown }> {
  const { signal } = request;
  if (signal.aborted) throw new ServerError("cancelled");
  const own = new AbortController();
  const abort = () => own.abort();
  signal.addEventListener("abort", abort);
  const timer = setTimeout(abort, request.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: request.method,
        headers: {
          accept: "application/json",
          ...(request.body === undefined ? {} : { "content-type": "application/json" }),
          ...request.headers,
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        credentials: "omit",
        redirect: "error",
        signal: own.signal,
      });
    } catch {
      throw new ServerError(signal.aborted ? "cancelled" : "offline");
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      // An answer with no JSON, such as an empty one. Its status still says what happened.
      body = undefined;
      if (own.signal.aborted && !signal.aborted) throw new ServerError("offline");
    }
    if (signal.aborted) throw new ServerError("cancelled");
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

/** The problem for a status that isn't a success. */
export function statusProblem(status: number): Exclude<ServerProblem, "offline" | "invalid" | "cancelled"> {
  if (status === 401) return "signed-out";
  if (status === 404) return "not-found";
  if (status === 429 || status === 503) return "server-busy";
  return "refused";
}

export interface ServerClient {
  readonly origin: string;
  /**
   * Sends a request with the sign-in's token, and resolves its answer as `read` validates it. `read` returns null
   * for an answer it can't use. A 401 ends the sign-in.
   */
  send<T>(method: "GET" | "POST" | "PATCH", path: string, read: (body: unknown) => T | null, body?: unknown): Promise<T>;
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
}): ServerClient {
  return {
    origin: options.origin,
    async send(method, path, read, body) {
      const answer = await exchange(options.fetch, `${options.origin}${path}`, {
        method, body, signal: options.signal, timeoutMs: options.timeoutMs,
        headers: { authorization: `Bearer ${options.token}` },
      });
      if (answer.status < 200 || answer.status > 299) {
        const problem = statusProblem(answer.status);
        if (problem === "signed-out") options.onSignedOut?.();
        throw new ServerError(problem, answer.status);
      }
      const value = read(answer.body);
      if (value === null) throw new ServerError("invalid", answer.status);
      return value;
    },
  };
}

/** Requests whose results replace each other: each takes the next number, and only the latest may land. */
export function requestGenerations(): { next(): number; isLatest(request: number): boolean } {
  let latest = 0;
  return {
    next: () => ++latest,
    isLatest: request => request === latest,
  };
}
