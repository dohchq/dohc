import {type FirstOpenOutcome, type FirstOpenSourceIdentity} from "@dohc/workspace-contracts/first-open";
import {decodeFirstOpenResponse} from "@dohc/workspace-contracts/first-open-wire";
import {parseServiceRelayAttachment} from "./serviceOrdinaryReplication";
import type {ServiceHostedReplicationConfig} from "./serviceHostedReplication";

/** A private host request. No candidate, credentials or receipt enters caller state before the bounded reply passes decoding. */
export function createFirstOpenClient(options: Pick<ServiceHostedReplicationConfig, "relay" | "identity"> & {
  fetch?: typeof fetch; maxResponseBytes?: number; requestTimeoutMs?: number;
}) {
  const relay = parseServiceRelayAttachment(options.relay), identity = Object.freeze({...options.identity});
  const fetcher = options.fetch ?? fetch, limit = options.maxResponseBytes ?? 16 * 1_024, timeoutMs = options.requestTimeoutMs ?? 120_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Invalid first-open client bounds.");
  return async (source: FirstOpenSourceIdentity, callerSignal: AbortSignal): Promise<FirstOpenOutcome> => {
    const expected = {...source};
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs)]);
    signal.throwIfAborted();
    const response = await fetcher(`${relay.baseUrl.replace(/\/$/, "")}/sync/${encodeURIComponent(expected.workspaceId)}/hosted/first-open`, {
      method: "POST", credentials: "omit", redirect: "error", signal,
      headers: {authorization: `Bearer ${relay.bearerToken}`, "content-type": "application/json"},
      body: JSON.stringify({objectId: expected.objectId, path: expected.path, sourceMomentId: expected.sourceMomentId,
        sourceDigest: expected.sourceDigest, replicationEpoch: identity.replicationEpoch, streamIdentity: identity.streamIdentity}),
    });
    const reader = response.body?.getReader();
    const cancel = () => {void reader?.cancel().catch(() => {});};
    signal.addEventListener("abort", cancel, {once: true});
    try {
      signal.throwIfAborted();
      if (response.status !== 200 || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" ||
        Number(response.headers.get("content-length")) > limit || !reader) throw new Error("Invalid first-open response.");
      const bytes = new Uint8Array(limit);
      let size = 0;
      for (;;) {
        const chunk = await reader.read();
        signal.throwIfAborted();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > limit) throw new Error("First-open response exceeds its byte limit.");
        bytes.set(chunk.value, size - chunk.value.byteLength);
      }
      return decodeFirstOpenResponse(JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes.subarray(0, size))), expected);
    } finally {
      signal.removeEventListener("abort", cancel);
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
    }
  };
}
