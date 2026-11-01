import type { ServerResponse } from "node:http";

/** How long a full response buffer may wait for its client to take bytes before the response is destroyed. */
export const DRAIN_TIMEOUT_MS = 60_000;
/**
 * A response header that opts the response into {@link DRAIN_TIMEOUT_MS}, for a body that holds scarce
 * capacity until it is sent. The pipe reads it and it never reaches the client.
 */
export const DRAIN_TIMEOUT_HEADER = "x-dohc-drain-timeout";

/**
 * Streams a fetch Response body into a node:http response with backpressure.
 * A closed or errored socket, or a client that takes nothing for
 * {@link DRAIN_TIMEOUT_MS} when the response opts in, cancels the source
 * stream so an upstream relay stops producing bytes that nothing will read.
 */
export async function pipeResponseBody(
  response: Response,
  outgoing: ServerResponse,
): Promise<void> {
  if (!response.body) {
    outgoing.end();
    return;
  }
  const drainTimeout = response.headers.has(DRAIN_TIMEOUT_HEADER);
  const reader = response.body.getReader();
  const cancelOnClose = (): void => {
    if (!outgoing.writableFinished) void reader.cancel().catch(() => undefined);
  };
  const destroyOnError = (): void => {
    if (!outgoing.destroyed) outgoing.destroy();
  };
  outgoing.once("close", cancelOnClose);
  outgoing.on("error", destroyOnError);
  try {
    while (!outgoing.destroyed) {
      const read = await reader.read();
      if (read.done) {
        outgoing.end();
        return;
      }
      if (!outgoing.write(read.value) && !(await waitForDrain(outgoing, drainTimeout))) return;
    }
  } catch {
    if (!outgoing.destroyed) outgoing.destroy();
  } finally {
    outgoing.off("close", cancelOnClose);
    outgoing.off("error", destroyOnError);
    if (!outgoing.writableFinished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function waitForDrain(outgoing: ServerResponse, timeout: boolean): Promise<boolean> {
  if (outgoing.destroyed) return Promise.resolve(false);
  return new Promise((resolve) => {
    // Destroying the response closes it, which resolves this.
    const stalled = timeout ? setTimeout(() => outgoing.destroy(), DRAIN_TIMEOUT_MS) : undefined;
    const cleanup = (): void => {
      clearTimeout(stalled);
      outgoing.off("close", closed);
      outgoing.off("drain", drained);
    };
    const closed = (): void => {
      cleanup();
      resolve(false);
    };
    const drained = (): void => {
      cleanup();
      resolve(true);
    };
    outgoing.once("close", closed);
    outgoing.once("drain", drained);
  });
}
