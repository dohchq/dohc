import { randomUUID } from "node:crypto";
import { link, lstat, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

export const DATASET_RECOVERY_EXTENSION = ".dohc-recovery";

/** The owner chooses the destination; app source never receives this filesystem capability. */
export async function writeDatasetRecoveryExport(input: {
  path: string; overwrite?: boolean; stream: AsyncIterable<Uint8Array>; maxBytes: number;
  signal: AbortSignal; authorize(): void;
}): Promise<{ savedPath: string; byteLength: number }> {
  if (!isAbsolute(input.path) || !input.path.toLowerCase().endsWith(DATASET_RECOVERY_EXTENSION)) {
    throw new Error("Choose an absolute path ending in .dohc-recovery.");
  }
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1) throw new Error("The recovery export has an invalid size limit.");
  const current = () => { input.signal.throwIfAborted(); input.authorize(); };
  current();
  const parent = await realpath(dirname(input.path)); current();
  const destination = join(parent, basename(input.path));
  const exists = () => lstat(destination).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  const original = await exists(); current();
  if (original && (!input.overwrite || !original.isFile() || original.isSymbolicLink())) throw new Error("A file already exists there. Choose another location.");
  const temporary = join(parent, `.${basename(destination)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  let closed = false, byteLength = 0;
  try {
    for await (const chunk of input.stream) {
      current();
      if (!(chunk instanceof Uint8Array) || chunk.byteLength > 1024 * 1024 + 5 || byteLength + chunk.byteLength > input.maxBytes) {
        throw new Error("The recovery export exceeds its size limit.");
      }
      let offset = 0;
      while (offset < chunk.byteLength) {
        current();
        const result = await handle.write(chunk, offset, chunk.byteLength - offset, byteLength + offset);
        if (!result.bytesWritten) throw new Error("dohc could not finish writing the recovery export.");
        offset += result.bytesWritten;
      }
      byteLength += chunk.byteLength;
    }
    if (!byteLength) throw new Error("The recovery export is empty.");
    current(); await handle.sync(); current();
    await handle.close(); closed = true; current();
    const latest = await exists(); current();
    if (!original ? latest : (!latest || !latest.isFile() || latest.isSymbolicLink() ||
        latest.dev !== original.dev || latest.ino !== original.ino || latest.mtimeMs !== original.mtimeMs || latest.size !== original.size)) {
      throw new Error("The destination changed during export. Choose another location.");
    }
    if (input.overwrite) await rename(temporary, destination);
    else await link(temporary, destination);
    return { savedPath: destination, byteLength };
  } finally {
    if (!closed) await handle.close();
    await rm(temporary, { force: true });
  }
}
