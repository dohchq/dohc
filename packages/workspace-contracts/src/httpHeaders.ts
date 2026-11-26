export const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,64}$/u;
export const HTTP_HEADER_VALUE_PATTERN = /^[ -~]*$/u;
const FORBIDDEN_HTTP_HEADERS: ReadonlySet<string> = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "cookie",
  "accept-encoding",
  "te",
  "upgrade",
  "keep-alive",
  "trailer",
  "user-agent",
  "__proto__",
  "prototype",
  "constructor",
]);

export function isForbiddenHttpHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    FORBIDDEN_HTTP_HEADERS.has(lower) || lower.startsWith("proxy-") || lower.startsWith("x-dohc-")
  );
}
