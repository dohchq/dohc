import { Resolver } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { BlockList, isIP } from "node:net";

const DEFAULT_MAX_URL_LENGTH = 2048;
const DEFAULT_DNS_TIMEOUT_MS = 2000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_HEADER_SIZE = 8192;
const MAX_HEADER_SIZE_CAP = 16 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 8192;
const MAX_RESPONSE_BYTES_CAP = 192 * 1024;

interface VerifiedDestination {
  readonly href: string;
  readonly canonicalHost: string;
  readonly address: string;
  readonly family: 4 | 6;
}

const verifiedDestinations = new WeakMap<SafeOutboundDestination, VerifiedDestination>();

const RESERVED_LOCAL_SUFFIXES = [".local", ".internal", ".localhost", ".home.arpa"] as const;

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const) {
  blocked.addSubnet(address, prefix, "ipv4");
}

const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const) {
  blocked.addSubnet(address, prefix, "ipv6");
}

export type SafeOutboundErrorCode =
  | "unsafe_url"
  | "dns_failed"
  | "unsafe_address"
  | "redirect_refused"
  | "response_too_large"
  | "response_interrupted"
  | "transport_failed"
  | "unsupported_response"
  | "invalid_json";

export class SafeOutboundError extends Error {
  constructor(
    readonly code: SafeOutboundErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SafeOutboundError";
  }
}

export type SafeAddressRecord = {
  readonly address: string;
  readonly family: number;
};

export type SafeAddressLookup = (
  hostname: string,
  signal: AbortSignal,
) => Promise<readonly SafeAddressRecord[]>;

export interface SafeOutboundDestination {
  readonly href: string;
  readonly url: URL;
  readonly canonicalHost: string;
  readonly address: string;
  readonly family: 4 | 6;
}

export interface SafeOutboundUrlOptions {
  readonly maxUrlLength?: number;
  readonly allowedHosts?: ReadonlySet<string>;
  readonly allowSubdomainPatterns?: boolean;
}

export interface SafeOutboundRequest {
  readonly destination: SafeOutboundDestination;
  readonly method?: "POST" | "GET" | "PUT" | "PATCH" | "DELETE";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Buffer;
  readonly timeoutMs?: number;
  readonly maxHeaderSize?: number;
  readonly maxResponseBytes?: number;
  readonly rejectRedirects?: boolean;
}

export interface SafeOutboundResponse {
  readonly status: number;
  readonly contentType: string | null;
  readonly contentEncoding: string | null;
  readonly body: Buffer;
}

export function isPublicInternetAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  return family === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

export function isAllowedPublicHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (
    lower.length === 0 ||
    lower.length > 253 ||
    lower.startsWith(".") ||
    lower.endsWith(".") ||
    lower.includes("..") ||
    !lower.includes(".")
  ) {
    return false;
  }
  if (lower.split(".").some((label) => label.length === 0 || label.length > 63)) return false;
  if (isIP(lower.replace(/^\[|\]$/gu, "")) !== 0) return false;
  if (lower === "home.arpa" || RESERVED_LOCAL_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
    return false;
  }
  return true;
}

function hostMatchesSet(
  hostname: string,
  hosts: ReadonlySet<string>,
  allowSubdomainPatterns: boolean,
): boolean {
  for (const host of hosts) {
    if (allowSubdomainPatterns && host.startsWith(".")) {
      if (hostname.length > host.length && hostname.endsWith(host)) return true;
    } else if (hostname === host) {
      return true;
    }
  }
  return false;
}

export function parseSafeOutboundHttpsUrl(
  rawUrl: string,
  options: SafeOutboundUrlOptions = {},
): URL | null {
  const maxUrlLength = options.maxUrlLength ?? DEFAULT_MAX_URL_LENGTH;
  if (
    rawUrl.length === 0 ||
    rawUrl.length > maxUrlLength ||
    rawUrl.includes("#") ||
    /[\t\r\n\0]/u.test(rawUrl)
  ) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const canonicalHost = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    (url.port !== "" && url.port !== "443") ||
    !isAllowedPublicHostname(canonicalHost)
  ) {
    return null;
  }
  if (
    options.allowedHosts &&
    !hostMatchesSet(canonicalHost, options.allowedHosts, options.allowSubdomainPatterns ?? false)
  ) {
    return null;
  }
  return url;
}

export async function resolveSafeAddresses(
  hostname: string,
  signal: AbortSignal,
): Promise<SafeAddressRecord[]> {
  if (signal.aborted) {
    throw new SafeOutboundError("dns_failed", "Outbound DNS lookup failed.");
  }
  const resolver = new Resolver({ timeout: DEFAULT_DNS_TIMEOUT_MS, tries: 1 });
  const cancel = () => resolver.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const results = await Promise.allSettled([
      resolver.resolve4(hostname),
      resolver.resolve6(hostname),
    ]);
    if (signal.aborted) {
      throw new SafeOutboundError("dns_failed", "Outbound DNS lookup failed.");
    }
    const addresses: SafeAddressRecord[] = [];
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") {
        addresses.push(
          ...result.value.map((address) => ({ address, family: index === 0 ? 4 : 6 })),
        );
      } else if (
        !["ENODATA", "ENOTFOUND"].includes(String((result.reason as NodeJS.ErrnoException)?.code))
      ) {
        throw new SafeOutboundError("dns_failed", "Outbound DNS lookup failed.");
      }
    }
    return addresses;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

export async function resolveSafeOutboundDestination(
  rawUrl: string,
  options: SafeOutboundUrlOptions & {
    readonly lookup?: SafeAddressLookup;
    readonly signal?: AbortSignal;
  } = {},
): Promise<SafeOutboundDestination> {
  const url = parseSafeOutboundHttpsUrl(rawUrl, options);
  if (!url) {
    throw new SafeOutboundError("unsafe_url", "Outbound destination URL is not allowed.");
  }
  const canonicalHost = url.hostname.toLowerCase();
  const signal = options.signal ?? AbortSignal.timeout(DEFAULT_DNS_TIMEOUT_MS);
  const lookup = options.lookup ?? resolveSafeAddresses;
  const addresses = await lookup(canonicalHost, signal);
  if (
    addresses.length === 0 ||
    addresses.some(
      (row) => !isPublicInternetAddress(row.address) || isIP(row.address) !== row.family,
    )
  ) {
    throw new SafeOutboundError("unsafe_address", "Outbound destination resolved to a blocked IP.");
  }
  const first = addresses[0]!;
  const verified: VerifiedDestination = {
    href: url.href,
    canonicalHost,
    address: first.address,
    family: first.family as 4 | 6,
  };
  const destination: SafeOutboundDestination = Object.freeze({
    href: verified.href,
    get url() {
      return new URL(verified.href);
    },
    canonicalHost: verified.canonicalHost,
    address: verified.address,
    family: verified.family,
  });
  verifiedDestinations.set(destination, verified);
  return destination;
}

export async function sendSafeOutboundHttps(
  prepared: SafeOutboundRequest,
  signal?: AbortSignal,
): Promise<number> {
  return (await exchangeSafeOutboundHttps(prepared, signal, false)).status;
}

/** Sends like sendSafeOutboundHttps and keeps the response body, up to maxResponseBytes. */
export function readSafeOutboundHttps(
  prepared: SafeOutboundRequest,
  signal?: AbortSignal,
): Promise<SafeOutboundResponse> {
  return exchangeSafeOutboundHttps(prepared, signal, true);
}

function headerText(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? value.join(", ") : value;
}

function exchangeSafeOutboundHttps(
  prepared: SafeOutboundRequest,
  signal: AbortSignal | undefined,
  keepBody: boolean,
): Promise<SafeOutboundResponse> {
  const verified = verifiedDestinations.get(prepared.destination);
  if (!verified) {
    return Promise.reject(
      new SafeOutboundError("unsafe_url", "Outbound destination was not verified."),
    );
  }
  const { body, headers } = prepared;
  const maxHeaderSize = prepared.maxHeaderSize ?? DEFAULT_MAX_HEADER_SIZE;
  if (
    !Number.isInteger(maxHeaderSize) ||
    maxHeaderSize < 1 ||
    maxHeaderSize > MAX_HEADER_SIZE_CAP
  ) {
    return Promise.reject(
      new SafeOutboundError("unsafe_url", "Outbound maxHeaderSize limit is invalid."),
    );
  }
  const maxResponseBytes = prepared.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (
    !Number.isInteger(maxResponseBytes) ||
    maxResponseBytes < 0 ||
    maxResponseBytes > MAX_RESPONSE_BYTES_CAP
  ) {
    return Promise.reject(
      new SafeOutboundError("unsafe_url", "Outbound maxResponseBytes limit is invalid."),
    );
  }
  const rejectRedirects = prepared.rejectRedirects ?? true;
  const requestedTimeout = prepared.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const timeoutMs =
    Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? Math.min(Math.trunc(requestedTimeout), MAX_REQUEST_TIMEOUT_MS)
      : DEFAULT_REQUEST_TIMEOUT_MS;
  if (signal?.aborted) {
    return Promise.reject(
      new SafeOutboundError("transport_failed", "Outbound HTTPS request failed."),
    );
  }
  const normalizedHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === "host") {
      return Promise.reject(
        new SafeOutboundError("unsafe_url", "Outbound Host header override is not allowed."),
      );
    }
    if (lower === "accept-encoding") continue;
    normalizedHeaders[key] = value;
  }
  normalizedHeaders["accept-encoding"] = "identity";

  return new Promise((resolve, reject) => {
    let completed: SafeOutboundResponse | undefined;
    const chunks: Buffer[] = [];
    let failure: Error | undefined;
    const requestOptions: RequestOptions & { autoSelectFamily: boolean } = {
      method: prepared.method ?? "POST",
      headers: normalizedHeaders,
      ...(signal ? { signal } : {}),
      agent: false,
      servername: verified.canonicalHost,
      rejectUnauthorized: true,
      autoSelectFamily: false,
      maxHeaderSize,
      lookup: (_hostname, options, callback) => {
        if (options.all) {
          callback(null, [{ address: verified.address, family: verified.family }]);
        } else {
          callback(null, verified.address, verified.family);
        }
      },
    };
    let request: ReturnType<typeof httpsRequest>;
    try {
      request = httpsRequest(new URL(verified.href), requestOptions, (response) => {
        const status = response.statusCode ?? 0;
        if (rejectRedirects && status >= 300 && status < 400) {
          const redirectError = new SafeOutboundError(
            "redirect_refused",
            "Outbound redirects are not allowed.",
          );
          failure ??= redirectError;
          response.resume();
          request.destroy(redirectError);
          return;
        }
        response.on("error", () => {
          const transportError = new SafeOutboundError(
            "transport_failed",
            "Outbound HTTPS request failed.",
          );
          failure ??= transportError;
          request.destroy(transportError);
        });
        response.on("aborted", () => {
          const interrupted = new SafeOutboundError(
            "response_interrupted",
            "Outbound HTTPS response interrupted.",
          );
          failure ??= interrupted;
          request.destroy(interrupted);
        });
        let received = 0;
        response.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > maxResponseBytes) {
            const overflow = new SafeOutboundError(
              "response_too_large",
              "Outbound HTTPS response exceeded the size limit.",
            );
            failure ??= overflow;
            request.destroy(overflow);
          } else if (keepBody) {
            chunks.push(chunk);
          }
        });
        response.on("end", () => {
          completed = {
            status,
            contentType: headerText(response.headers["content-type"]),
            contentEncoding: headerText(response.headers["content-encoding"]),
            body: Buffer.concat(chunks),
          };
        });
      });
    } catch {
      reject(new SafeOutboundError("transport_failed", "Outbound HTTPS request failed."));
      return;
    }
    const timer = setTimeout(() => {
      const timeoutError = new SafeOutboundError(
        "transport_failed",
        "Outbound HTTPS request timed out.",
      );
      failure ??= timeoutError;
      request.destroy(timeoutError);
    }, timeoutMs);
    request.on("error", (error) => {
      if (error instanceof SafeOutboundError) {
        failure ??= error;
      } else {
        failure ??= new SafeOutboundError("transport_failed", "Outbound HTTPS request failed.");
      }
    });
    request.on("close", () => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (completed === undefined) {
        reject(
          new SafeOutboundError("response_interrupted", "Outbound HTTPS response interrupted."),
        );
      } else {
        resolve(completed);
      }
    });
    if (body && body.length > 0) request.end(body);
    else request.end();
  });
}

const JSON_MEDIA_TYPE = /^application\/(?:[a-z0-9.-]+\+)?json$/u;

function nestsWithin(value: unknown, maxDepth: number): boolean {
  const pending: Array<[unknown, number]> = [[value, 0]];
  while (pending.length > 0) {
    const [item, depth] = pending.pop()!;
    if (item === null || typeof item !== "object") continue;
    if (depth >= maxDepth) return false;
    for (const child of Array.isArray(item) ? item : Object.values(item)) {
      pending.push([child, depth + 1]);
    }
  }
  return true;
}

/**
 * Decodes a response body as JSON: an uncompressed `application/json` (or
 * `+json`) body in UTF-8 whose lists and objects nest at most `maxDepth` deep.
 */
export function parseSafeOutboundJson(response: SafeOutboundResponse, maxDepth: number): unknown {
  const encoding = response.contentEncoding?.trim().toLowerCase() ?? "identity";
  if (encoding !== "identity") {
    throw new SafeOutboundError(
      "unsupported_response",
      `Outbound HTTPS response is compressed (${encoding}), and dohc reads only uncompressed responses.`,
    );
  }
  const [mediaType = "", ...parameters] = (response.contentType ?? "")
    .split(";")
    .map((part) => part.trim().toLowerCase());
  const charset = parameters
    .find((part) => part.startsWith("charset="))
    ?.slice("charset=".length)
    .replace(/^"(.*)"$/u, "$1");
  if (!JSON_MEDIA_TYPE.test(mediaType) || (charset !== undefined && charset !== "utf-8")) {
    throw new SafeOutboundError(
      "unsupported_response",
      "Outbound HTTPS response is not JSON in UTF-8.",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body));
  } catch {
    throw new SafeOutboundError("invalid_json", "Outbound HTTPS response is not valid JSON.");
  }
  if (!nestsWithin(value, maxDepth)) {
    throw new SafeOutboundError(
      "invalid_json",
      `Outbound HTTPS response nests lists and objects more than ${maxDepth} deep.`,
    );
  }
  return value;
}
