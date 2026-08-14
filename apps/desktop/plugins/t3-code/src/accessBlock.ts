// The t3 server prints a headless access block on stdout:
//
//   T3 Code server is ready.
//   Connection string: http://127.0.0.1:<port>
//   Token: <credential>
//   Pairing URL: http://127.0.0.1:<port>/pair#token=<credential>
//
// The pairing token is an orchestration credential. It is parsed in memory
// and handed only to the host's guest navigation; every other surface — the
// plugin log, error messages, anything derived from child output — sees only
// redacted text.

const TOKEN_LINE = /(Token:\s*)\S+/g;
const TOKEN_FRAGMENT = /#token=[^\s"'&#]+/g;

export function redactT3Output(text: string): string {
  return text
    .replace(TOKEN_LINE, "$1[redacted]")
    .replace(TOKEN_FRAGMENT, "#token=[redacted]");
}

// The trailing \r?\n is load-bearing: a stream chunk can end mid-token, and
// matching an unterminated line would hand out a truncated credential.
const PAIRING_URL_LINE = /^Pairing URL: (http:\/\/127\.0\.0\.1:\d{1,5}\/pair#token=\S+)\r?\n/m;

/** The pairing URL from raw child output, or null until its line is complete.
 * Callers feed the accumulated buffer, not single chunks — the line can split
 * across stream chunks. */
export function findPairingUrl(buffer: string): string | null {
  const match = PAIRING_URL_LINE.exec(buffer);
  return match?.[1] ?? null;
}
