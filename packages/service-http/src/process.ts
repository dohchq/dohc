import { writeSync } from "node:fs";
import type { Server } from "node:http";

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
 */
export function closeServer(server: Server, gracePeriodMs: number): Promise<void> {
  return new Promise((resolve) => {
    const forceClose = setTimeout(() => server.closeAllConnections(), gracePeriodMs);
    forceClose.unref();
    server.close(() => {
      clearTimeout(forceClose);
      resolve();
    });
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
