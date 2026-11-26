import {
  parseSafeOutboundHttpsUrl,
  parseSafeOutboundJson,
  readSafeOutboundHttps,
  resolveSafeOutboundDestination,
  SafeOutboundError,
  type SafeOutboundDestination,
  type SafeOutboundRequest,
  type SafeOutboundResponse,
} from "./safeOutboundHttps";

export const DECLARED_HTTPS_USER_AGENT = "dohc-app/1";
const MAX_JSON_DEPTH = 64;

export interface DeclaredHttpsRequest {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

export interface DeclaredHttpsTransport {
  resolve(url: string, allowedHosts: ReadonlySet<string>): Promise<SafeOutboundDestination>;
  read(request: SafeOutboundRequest, signal?: AbortSignal): Promise<SafeOutboundResponse>;
}

export const safeDeclaredHttpsTransport: DeclaredHttpsTransport = {
  resolve: (url, allowedHosts) => resolveSafeOutboundDestination(url, { allowedHosts }),
  read: readSafeOutboundHttps,
};

export type DeclaredHttpsErrorCode =
  | "unsafe_url"
  | "unsafe_address"
  | "dns_failed"
  | "redirect_refused"
  | "response_too_large"
  | "response_interrupted"
  | "transport_failed"
  | "unexpected_content_type"
  | "invalid_json"
  | "secret_echoed";

/** A refusal whose message is fixed text, safe to show an app and its viewers. */
export class DeclaredHttpsError extends Error {
  override readonly name = "DeclaredHttpsError";
  constructor(
    readonly code: DeclaredHttpsErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const transportMessages: Record<string, string> = {
  unsafe_url: "The service's address is not allowed.",
  unsafe_address: "The service's address resolved to a private or blocked network.",
  dns_failed: "The service's address could not be found.",
  redirect_refused: "The service answered with a redirect, which apps can't follow.",
  response_interrupted: "The service closed the connection before it finished answering.",
};

function transportError(error: unknown, maxResponseBytes: number): DeclaredHttpsError {
  if (error instanceof SafeOutboundError) {
    if (error.code === "response_too_large")
      return new DeclaredHttpsError(
        "response_too_large",
        `The service's answer is over this operation's ${maxResponseBytes}-byte limit.`,
      );
    const message = transportMessages[error.code];
    if (message) return new DeclaredHttpsError(error.code as DeclaredHttpsErrorCode, message);
  }
  return new DeclaredHttpsError("transport_failed", "The service didn't answer in time.");
}

function echoes(text: string, secret: string): boolean {
  return [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)].some((form) =>
    text.includes(form),
  );
}

/**
 * Sends one rendered request to `host` only, with the secret in one header, and returns the JSON answer.
 * Any answer that carries the secret back is refused, in the raw, JSON-escaped, URL-encoded, or decoded form.
 */
export async function sendDeclaredHttps(options: {
  readonly request: DeclaredHttpsRequest;
  readonly host: string;
  /** Read after the address is checked and right before sending, so access and the secret are current. */
  readonly secret: () => Promise<{
    readonly header: string;
    readonly prefix: string;
    readonly value: string;
  }>;
  readonly maxResponseBytes: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly transport?: DeclaredHttpsTransport;
}): Promise<{ status: number; data: unknown }> {
  const transport = options.transport ?? safeDeclaredHttpsTransport;
  let destination: SafeOutboundDestination;
  try {
    destination = await transport.resolve(options.request.url, new Set([options.host]));
  } catch (error) {
    throw transportError(error, options.maxResponseBytes);
  }
  const { header, prefix, value: secret } = await options.secret();
  let response: SafeOutboundResponse;
  try {
    response = await transport.read(
      {
        destination,
        method: options.request.method,
        headers: {
          ...options.request.headers,
          "User-Agent": DECLARED_HTTPS_USER_AGENT,
          [header]: `${prefix}${secret}`,
        },
        ...(options.request.body === null ? {} : { body: Buffer.from(options.request.body) }),
        timeoutMs: options.timeoutMs,
        maxResponseBytes: options.maxResponseBytes,
        rejectRedirects: true,
      },
      options.signal,
    );
  } catch (error) {
    throw transportError(error, options.maxResponseBytes);
  }
  let data: unknown;
  try {
    data = parseSafeOutboundJson(response, MAX_JSON_DEPTH);
  } catch (error) {
    throw error instanceof SafeOutboundError && error.code === "invalid_json"
      ? new DeclaredHttpsError(
          "invalid_json",
          `The service answered HTTP ${response.status} with JSON that is broken or nested over ${MAX_JSON_DEPTH} levels deep.`,
        )
      : new DeclaredHttpsError(
          "unexpected_content_type",
          `The service answered HTTP ${response.status} without uncompressed JSON in UTF-8.`,
        );
  }
  if (secret.trim() && echoes(JSON.stringify(data), secret.trim()))
    throw new DeclaredHttpsError(
      "secret_echoed",
      "The service's answer repeated the secret, so dohc withheld it.",
    );
  return { status: response.status, data };
}

/** Sends to a loopback fixture in end-to-end tests, after the same host check. Never used in a release. */
export function loopbackDeclaredHttpsTransport(origin: string): DeclaredHttpsTransport {
  return {
    async resolve(url, allowedHosts) {
      const parsed = parseSafeOutboundHttpsUrl(url);
      if (!parsed || !allowedHosts.has(parsed.hostname)) throw new Error("Host not allowed.");
      return {
        href: parsed.href,
        url: parsed,
        canonicalHost: parsed.hostname,
        address: "127.0.0.1",
        family: 4,
      };
    },
    async read(request, signal) {
      const url = request.destination.url;
      const response = await fetch(`${origin}${url.pathname}${url.search}`, {
        method: request.method ?? "POST",
        headers: { ...request.headers, "x-dohc-test-host": url.hostname },
        ...(request.body ? { body: new Uint8Array(request.body) } : {}),
        redirect: "manual",
        ...(signal ? { signal } : {}),
      });
      const body = Buffer.from(await response.arrayBuffer());
      if (body.byteLength > (request.maxResponseBytes ?? 0))
        throw new SafeOutboundError("response_too_large", "too large");
      return {
        status: response.status,
        contentType: response.headers.get("content-type"),
        contentEncoding: response.headers.get("content-encoding"),
        body,
      };
    },
  };
}
