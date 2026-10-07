import { DohcCliError } from "./errors";

// Reads stdin whole, or stops at `limit` and refuses with its message, so a
// huge pipe is never read in full.
export async function readStdinText(
  stream: AsyncIterable<string | Uint8Array>,
  limit?: { bytes: number; message: string },
): Promise<string> {
  const chunks: Buffer[] = [];
  let bytesRead = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    bytesRead += bytes.length;
    if (limit !== undefined && bytesRead > limit.bytes) {
      throw new DohcCliError(limit.message);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}
