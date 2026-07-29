import type { Writable } from "node:stream";

/**
 * Makes a diagnostic stream unable to kill the process that writes to it.
 *
 * When stdout/stderr is a pipe, Node writes it synchronously, so a reader that
 * has gone away (a launcher that exited, a closed terminal) turns the next
 * `console.log` into a THROWN `EPIPE` inside whatever code happened to be
 * logging. In Electron's main process an uncaught throw is a
 * "A JavaScript error occurred in the main process" dialog, so a dead log pipe
 * could take the whole app down mid-recovery.
 *
 * Returns a restore function.
 */
export function makeStreamWriteNonFatal(stream: Writable): () => void {
  const hadOwnWrite = Object.hasOwn(stream, "write");
  const original = stream.write as (
    this: Writable,
    ...args: unknown[]
  ) => boolean;
  const guarded = (...args: unknown[]): boolean => {
    try {
      return original.call(stream, ...args);
    } catch {
      // The log has nowhere to go. Report "written" so the caller neither
      // retries nor waits for a drain that will never arrive.
      const callback = args.at(-1);
      if (typeof callback === "function") callback();
      return true;
    }
  };
  stream.write = guarded;
  // A pipe can also fail asynchronously; without a listener that is an
  // uncaught 'error' event.
  const swallow = (): void => undefined;
  stream.on("error", swallow);
  return () => {
    if (hadOwnWrite) stream.write = original;
    else Reflect.deleteProperty(stream, "write");
    stream.off("error", swallow);
  };
}

/** Applies {@link makeStreamWriteNonFatal} to this process's stdout + stderr. */
export function makeProcessDiagnosticsNonFatal(): () => void {
  const restores = [process.stdout, process.stderr].map((stream) =>
    makeStreamWriteNonFatal(stream),
  );
  return () => {
    for (const restore of restores) restore();
  };
}
