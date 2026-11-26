import {
  readSafeOutboundHttps,
  resolveSafeOutboundDestination,
  SafeOutboundError,
  type SafeOutboundDestination,
  type SafeOutboundRequest,
  type SafeOutboundResponse,
} from "./safeOutboundHttps";

export const DECLARED_HTTPS_USER_AGENT = "dohc-app/1";

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
  const text = response.body.toString("utf8");
  const type = response.contentType.split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json" && !/^application\/[a-z0-9.+-]+\+json$/u.test(type))
    throw new DeclaredHttpsError(
      "unexpected_content_type",
      `The service answered HTTP ${response.status} without JSON.`,
    );
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new DeclaredHttpsError(
      "invalid_json",
      `The service answered HTTP ${response.status} with broken JSON.`,
    );
  }
  if (secret.trim() && echoes(JSON.stringify(data), secret.trim()))
    throw new DeclaredHttpsError(
      "secret_echoed",
      "The service's answer repeated the secret, so dohc withheld it.",
    );
  return { status: response.status, data };
}
