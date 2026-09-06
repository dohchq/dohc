import type { ServerResponse } from "node:http";

/**
 * Streams a fetch Response body into a node:http response with backpressure.
 * A closed or errored socket cancels the source stream so an upstream relay
 * stops producing bytes that nothing will read.
 */
export async function pipeResponseBody(
  body: ReadableStream<Uint8Array>,
  outgoing: ServerResponse,
): Promise<void> {
  const reader = body.getReader();
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
      if (!outgoing.write(read.value) && !(await waitForDrain(outgoing))) return;
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

function waitForDrain(outgoing: ServerResponse): Promise<boolean> {
  if (outgoing.destroyed) return Promise.resolve(false);
  return new Promise((resolve) => {
    const cleanup = (): void => {
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
