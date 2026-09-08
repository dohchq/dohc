const LINK_STREAM_CHUNK_BYTES = 64 * 1024;
const LINK_BLOB_INFLIGHT_BYTES_PER_GRANT = 64 * 1024 * 1024;

export function createLinkResponseStreams(nowMs: () => number) {
  type ActiveLinkStream = {
    shareId: string;
    terminate: () => void;
  };
  // The relay runs as one process and main.ts creates one handler, so this
  // intentionally per-process registry reaches every open accountless link
  // response.
  const activeLinkStreams = new Map<string, Set<ActiveLinkStream>>();
  const activeLinkBlobBytes = new Map<string, number>();
  const admitLinkBlobBytes = (
    grantId: string,
    byteLength: number,
  ): (() => void) | null => {
    const retainedBytes = activeLinkBlobBytes.get(grantId) ?? 0;
    if (byteLength > LINK_BLOB_INFLIGHT_BYTES_PER_GRANT - retainedBytes) {
      return null;
    }
    activeLinkBlobBytes.set(grantId, retainedBytes + byteLength);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (activeLinkBlobBytes.get(grantId) ?? byteLength) - byteLength;
      if (remaining > 0) activeLinkBlobBytes.set(grantId, remaining);
      else activeLinkBlobBytes.delete(grantId);
    };
  };
  const registerLinkStream = (
    grantId: string,
    stream: ActiveLinkStream,
  ): (() => void) => {
    let streams = activeLinkStreams.get(grantId);
    if (!streams) {
      streams = new Set();
      activeLinkStreams.set(grantId, streams);
    }
    streams.add(stream);
    return () => {
      const registered = activeLinkStreams.get(grantId);
      if (!registered) return;
      registered.delete(stream);
      if (registered.size === 0) activeLinkStreams.delete(grantId);
    };
  };
  const terminateLinkStreamsForGrant = (grantId: string): void => {
    const streams = activeLinkStreams.get(grantId);
    if (!streams) return;
    activeLinkStreams.delete(grantId);
    for (const stream of streams) stream.terminate();
  };
  const terminateLinkStreamsForShare = (shareId: string): void => {
    const grantIds = [...activeLinkStreams]
      .filter(([, streams]) => [...streams].some((stream) => stream.shareId === shareId))
      .map(([grantId]) => grantId);
    for (const grantId of grantIds) terminateLinkStreamsForGrant(grantId);
  };
  const respondWithLinkBytes = (
    bytes: Uint8Array,
    shareId: string,
    grantId: string,
    releaseRetainedBytes: () => void,
    settleEgress: (emittedByteLength: number, settledAtMs: number) => void,
    headers: Record<string, string>,
  ): Response => {
    let offset = 0;
    let active = true;
    let unregister = (): void => undefined;
    const release = (): void => {
      if (!active) return;
      active = false;
      unregister();
      releaseRetainedBytes();
      settleEgress(offset, nowMs());
    };
    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          const stream: ActiveLinkStream = {
            shareId,
            terminate: () => {
              if (!active) return;
              release();
              controller.error(new Error("link grant changed during stream"));
            },
          };
          unregister = registerLinkStream(grantId, stream);
        },
        pull(controller) {
          if (!active) return;
          if (offset >= bytes.byteLength) {
            release();
            controller.close();
            return;
          }
          const end = Math.min(offset + LINK_STREAM_CHUNK_BYTES, bytes.byteLength);
          controller.enqueue(bytes.subarray(offset, end));
          offset = end;
        },
        cancel() {
          if (!active) return;
          release();
        },
      },
      // Pull only when the transport asks for another chunk. This keeps one
      // bounded view, rather than the full response, queued ahead of backpressure.
      { highWaterMark: 0 },
    );
    return new Response(body, {
      status: 200,
      headers,
    });
  };

  return {
    admitLinkBlobBytes,
    respondWithLinkBytes,
    terminateLinkStreamsForGrant,
    terminateLinkStreamsForShare,
  };
}
