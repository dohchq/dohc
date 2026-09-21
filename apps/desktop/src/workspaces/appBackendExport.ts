import { randomUUID } from "node:crypto";
import { link, lstat, open, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

export const APP_BACKEND_EXPORT_MAX_BYTES = 128 * 1024 * 1024;

export async function readAppBackendRecovery(path: string, signal: AbortSignal): Promise<unknown> {
  if (!isAbsolute(path) || !path.toLowerCase().endsWith(".json")) throw new Error("Choose an absolute recovery JSON path.");
  signal.throwIfAborted();
  const handle = await open(path, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > APP_BACKEND_EXPORT_MAX_BYTES) throw new Error("This recovery file exceeds the supported size.");
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new Error("The recovery file changed while reading. Try again.");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset)));
  } finally { await handle.close(); }
}

/** The save dialog or CLI caller owns the destination; app source never selects it. */
export async function writeAppBackendExport(input: { path: string; overwrite: boolean; bundle: unknown; signal: AbortSignal }): Promise<string> {
  if (!isAbsolute(input.path) || !input.path.toLowerCase().endsWith(".json")) throw new Error("Choose an absolute path ending in .json for the recovery export.");
  const text = JSON.stringify(input.bundle);
  if (!text || Buffer.byteLength(text) > APP_BACKEND_EXPORT_MAX_BYTES) throw new Error("This recovery export exceeds the supported size.");
  input.signal.throwIfAborted();
  const existing = await lstat(input.path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (existing && (!input.overwrite || !existing.isFile() || existing.isSymbolicLink())) throw new Error("The recovery export already exists. Choose another location.");
  const temporary = join(dirname(input.path), `.${basename(input.path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, text, { flag: "wx", mode: 0o600, signal: input.signal });
    input.signal.throwIfAborted();
    if (input.overwrite) await rename(temporary, input.path);
    else await link(temporary, input.path);
    return input.path;
  } finally { await rm(temporary, { force: true }); }
}
