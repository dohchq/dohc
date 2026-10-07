import { DohcCliError } from "./errors";

export async function readStdinText(
  stream: AsyncIterable<string | Uint8Array>,
  maxBytes?: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let bytesRead = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    bytesRead += bytes.length;
    if (maxBytes !== undefined && bytesRead > maxBytes) {
      throw new DohcCliError(`stdin body is at most ${maxBytes / 1024} KiB as UTF-8`);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}
