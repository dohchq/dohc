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

/**
 * Holds a stream's trailing partial segment until its newline arrives, then
 * emits complete lines. A chunk boundary can fall anywhere — inside the
 * credential, inside the word `Token` — and redaction anchored on those words
 * cannot see across it, so nothing may be redacted or logged per chunk. One
 * buffer per stream; `flush` emits the remainder when the child exits.
 *
 * The desktop install runner buffers its child streams the same way. The two
 * cannot share code: this plugin ships as a standalone package whose only
 * runtime dependency is `t3`.
 */
export function createStreamLineBuffer(onLine: (line: string) => void): {
  push: (text: string) => void;
  flush: () => void;
} {
  let pending = "";
  return {
    push(text: string): void {
      pending += text;
      const lastNewline = pending.lastIndexOf("\n");
      if (lastNewline === -1) return;
      for (const line of pending.slice(0, lastNewline).split("\n")) onLine(line);
      pending = pending.slice(lastNewline + 1);
    },
    flush(): void {
      if (pending.length === 0) return;
      const remainder = pending;
      pending = "";
      onLine(remainder);
    },
  };
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
