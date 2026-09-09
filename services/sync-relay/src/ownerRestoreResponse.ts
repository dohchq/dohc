type ReviewLease = {close(): void; invalidated: AbortSignal; maxOutputBytes: number};

/** The host keeps its review reservation until the response is consumed or retired. */
export function ownerRestoreReviewResponse(value: unknown, {close, invalidated, maxOutputBytes}: ReviewLease): Response {
  let bytes: Uint8Array | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let offset = 0, finished = false;
  const finish = () => {
    if (finished) return;
    finished = true; bytes = undefined;
    invalidated.removeEventListener("abort", expired);
    close();
  };
  const expired = () => {controller?.error(invalidated.reason); finish();};
  try {
    invalidated.throwIfAborted();
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) > maxOutputBytes) throw new Error("The complete restore response exceeds its output budget.");
    bytes = Buffer.from(json);
    invalidated.throwIfAborted();
    const body = new ReadableStream<Uint8Array>({
      start(stream) {controller = stream; invalidated.addEventListener("abort", expired, {once: true});},
      pull(stream) {
        if (!bytes) return;
        if (offset === bytes.byteLength) {stream.close(); finish(); return;}
        const end = Math.min(offset + 64 * 1024, bytes.byteLength);
        stream.enqueue(bytes.subarray(offset, end)); offset = end;
      },
      cancel() {finish();},
    }, {highWaterMark: 0});
    return new Response(body, {headers: {"content-type": "application/json", "cache-control": "private, no-store"}});
  } catch (error) {finish(); throw error;}
}
