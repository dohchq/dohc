import { z } from "zod";
import { readBoundedJson } from "@dohc/service-http";
import { equalRecoveryCursor, parseRecoveryCursor, parseRecoveryJournalRecord, type DatasetReplicaSource } from "@dohc/app-backend-runtime/replica";
import type { DatasetCursor } from "@dohc/app-backend-runtime/journal";
import type { CloudCredentials } from "./cloudCredentialStore";
import { credentialScopedOperation } from "./credentialScopedOperation";

const MAX_BYTES = 1024 * 1024;
export class DatasetCopyOfflineError extends Error {}

/** Only fetch transport failures permit stale reads; invalid responses and lost access never do. */
export function createRemoteDatasetReplicaSource(input: {
  workspaceId: string; datasetId: string; origin: string; credentials: CloudCredentials; credentialGeneration: number;
  currentCredentialGeneration(): number; signal: AbortSignal; assertCurrent(): void;
  relayResponse(credentials: CloudCredentials, path: string, init: RequestInit): Promise<Response>;
  onAccessLost(): void | Promise<void>;
}): DatasetReplicaSource {
  z.string().uuid().parse(input.datasetId);
  const origin = new URL(input.origin);
  if (!["https:", "http:"].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash ||
    !input.credentials.relayUrl || new URL(input.credentials.relayUrl).origin !== origin.origin) throw Error("Reconnect to this Collection's sharing server before downloading its copy.");
  const session = credentialScopedOperation({ capturedGeneration: input.credentialGeneration, currentGeneration: input.currentCredentialGeneration,
    assertCurrent() { input.signal.throwIfAborted(); input.assertCurrent(); } });
  const scoped = (cursor: DatasetCursor) => {
    if (cursor.workspaceId !== input.workspaceId || cursor.datasetId !== input.datasetId) throw Error("The copy belongs to another Collection.");
    return cursor;
  };
  const base = `/sync/${encodeURIComponent(input.workspaceId)}/datasets/${input.datasetId}/replica`;
  const signalFor = (signal?: AbortSignal) => signal ? AbortSignal.any([input.signal, signal]) : input.signal;
  async function request<T>(path: string, body: unknown, signal: AbortSignal, read: (response: Response) => Promise<T>): Promise<T> {
    return session.run(async () => {
      signal.throwIfAborted();
      let response: Response;
      try {
        response = await input.relayResponse(input.credentials, path, { method: body === undefined ? "GET" : "POST", signal, cache: "no-store", redirect: "error",
          headers: { authorization: `Bearer ${input.credentials.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      } catch (error) {
        session.assertCurrent(); signal.throwIfAborted();
        if (error instanceof TypeError) throw new DatasetCopyOfflineError("The sharing server is offline. Showing the saved Collection copy.", { cause: error });
        throw error;
      }
      try {
        session.assertCurrent(); signal.throwIfAborted();
        if ([401,403,404].includes(response.status)) {
          await input.onAccessLost(); throw Error("This Collection copy is no longer available.");
        }
        if (!response.ok) throw Error(`The Collection copy server returned ${response.status}.`);
        const value = await read(response);
        session.assertCurrent(); signal.throwIfAborted(); return value;
      } finally { if (!response.body?.locked) await response.body?.cancel().catch(() => undefined); }
    });
  }
  const json = (path: string, body: unknown, signal: AbortSignal) => request(path, body, signal, response => readBoundedJson(response, MAX_BYTES, signal));
  return {
    async capture(abort) {
      const signal = signalFor(abort), value = z.object({ head: z.unknown(), checkpoint: z.unknown() }).strict().parse(await json(`${base}/capture`, undefined, signal));
      const head = scoped(parseRecoveryCursor(value.head)), checkpoint = parseRecoveryJournalRecord(value.checkpoint);
      scoped(checkpoint.cursor);
      if (checkpoint.kind !== "checkpoint") throw Error("The server returned an invalid Collection checkpoint.");
      return { head, checkpoint };
    },
    async page(page) {
      scoped(page.through); scoped(page.after);
      const limit = Math.min(32, z.number().int().positive().parse(page.limit)), signal = signalFor(page.signal);
      const value = z.object({ through: z.unknown(), after: z.unknown(), records: z.array(z.unknown()).max(limit) }).strict()
        .parse(await json(`${base}/page`, { through: page.through, after: page.after, limit }, signal));
      const through = scoped(parseRecoveryCursor(value.through)), after = scoped(parseRecoveryCursor(value.after));
      if (!equalRecoveryCursor(through,page.through) || !equalRecoveryCursor(after,page.after)) throw Error("The server returned another Collection history page.");
      return { through, after, records: value.records.map(raw => { const record = parseRecoveryJournalRecord(raw); scoped(record.cursor); return record; }) };
    },
    async blob(chunk) {
      scoped(chunk.record.cursor);
      if (!Number.isSafeInteger(chunk.offset) || !Number.isSafeInteger(chunk.length) || chunk.offset < 0 || chunk.length < 1 || chunk.length > MAX_BYTES || chunk.offset + chunk.length > chunk.record.byteLength) throw Error("Invalid Collection copy chunk.");
      const signal = signalFor(chunk.signal);
      return request(`${base}/blob`, { record: chunk.record, offset: chunk.offset, length: chunk.length }, signal, async response => {
        const reader = response.body?.getReader(); if (!reader) throw Error("The Collection copy chunk is missing.");
        const bytes = new Uint8Array(chunk.length); let offset = 0;
        const abort = () => { void reader.cancel().catch(() => undefined); };
        signal.addEventListener("abort", abort, { once: true });
        try {
          while (true) {
            const next = await reader.read(); session.assertCurrent(); signal.throwIfAborted();
            if (next.done) break;
            if (next.value.length > bytes.length - offset) throw Error("The Collection copy chunk exceeds its limit.");
            bytes.set(next.value, offset); offset += next.value.length;
          }
          if (offset !== bytes.length) throw Error("The Collection copy chunk is incomplete.");
          return bytes;
        } finally { signal.removeEventListener("abort",abort); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      });
    },
  };
}
