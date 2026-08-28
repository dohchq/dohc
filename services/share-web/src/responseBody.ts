import type { ServerResponse } from "node:http";

export async function pipeResponseBody(
  body: ReadableStream<Uint8Array>,
  outgoing: ServerResponse,
  emitResponseErrorDuringPipeTestSeam: boolean,
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
      const needsDrain = !outgoing.write(read.value);
      if (emitResponseErrorDuringPipeTestSeam) {
        emitResponseErrorDuringPipeTestSeam = false;
        queueMicrotask(() => {
          outgoing.emit("error", new Error("controlled response error during pipe"));
        });
      }
      if (needsDrain) {
        const drained = await waitForDrain(outgoing);
        if (!drained) return;
      }
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
