import { writeSync } from "node:fs";
import type { Server } from "node:http";
import { closeWaitingConnections } from "./serveFetchHandler";

/** Writes `message` to stderr synchronously and exits 1. */
export function fatal(message: string): never {
  writeSync(2, `${message}\n`);
  process.exit(1);
}

/** A non-negative integer grace period from an environment value, else `fallback`. */
export function parseGracePeriodMs(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Stops accepting connections and resolves once every open one has ended.
 * Connections still open after `gracePeriodMs` are closed by force so a
 * stalled response cannot hold the process up.
 *
 * A connection that is kept alive outlives its response, and a proxy in front
 * sends its next request on it. So idle connections are closed every 100 ms,
 * and a request that has ended does not hold the server open. A response is
 * never told to close its connection: a client may already have sent its next
 * request on it. Requests that keep arriving on open connections can still use
 * the whole grace period.
 *
 * A request that only waits for news, as a long poll does, has no work to
 * finish. Its connection is closed as soon as the server stops listening, and
 * so is one that arrives later. Otherwise each would hold the server open for
 * as long as its client was willing to wait.
 */
export function closeServer(server: Server, gracePeriodMs: number): Promise<void> {
  return new Promise((resolve) => {
    const closeQuiet = setInterval(() => {
      server.closeIdleConnections();
      closeWaitingConnections(server);
    }, 100);
    closeQuiet.unref();
    const forceClose = setTimeout(() => server.closeAllConnections(), gracePeriodMs);
    forceClose.unref();
    server.close(() => {
      clearTimeout(forceClose);
      clearInterval(closeQuiet);
      resolve();
    });
    // After `close`, so the request's signal aborts as a shutdown does and not as a client that left.
    closeWaitingConnections(server);
  });
}

/** Closes the server on SIGINT or SIGTERM, once, then runs `onClosed`. */
export function installShutdown(
  server: Server,
  options: { gracePeriodMs: number; onClosed: () => void | Promise<void> },
): void {
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void closeServer(server, options.gracePeriodMs).then(() => options.onClosed());
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, shutdown);
}
