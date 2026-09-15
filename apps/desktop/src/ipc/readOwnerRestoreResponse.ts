import {DEFAULT_MAX_BLOB_BYTES} from "@dohc/workspace-engine-client/daemon";

export async function readOwnerRestoreResponse(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("The restore response is unavailable.");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const row = await reader.read();
      if (row.done) break;
      if (row.value.byteLength > DEFAULT_MAX_BLOB_BYTES - bytes) throw new Error("The restore response exceeds its byte limit.");
      chunks.push(row.value); bytes += row.value.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(Buffer.concat(chunks, bytes))) as unknown;
  } catch (error) {await reader.cancel(error).catch(() => undefined); throw error;}
  finally {reader.releaseLock();}
}
