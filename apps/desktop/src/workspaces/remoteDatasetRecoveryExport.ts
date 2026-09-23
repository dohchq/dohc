import type { CloudCredentials } from "./cloudCredentialStore";
import { credentialScopedOperation } from "./credentialScopedOperation";

const MAX_CHUNK_BYTES = 1024 * 1024 + 5;

/** A single-use authenticated download. The caller must dispose it if the save dialog is cancelled. */
export async function openRemoteDatasetRecoveryExport(input: {
  workspaceId: string; datasetId: string; origin: string; credentials: CloudCredentials;
  credentialGeneration: number; currentCredentialGeneration(): number;
  signal: AbortSignal; assertCurrent(): void; maxBytes: number;
  relayResponse(credentials: CloudCredentials, path: string, init: RequestInit): Promise<Response>;
}): Promise<{ stream: AsyncIterable<Uint8Array>; maxBytes: number; dispose(): Promise<void> }> {
  if (!input.workspaceId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.datasetId)) throw Error("Choose a Collection to export.");
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1) throw Error("The recovery export has an invalid size limit.");
  const origin = new URL(input.origin), configured = input.credentials.relayUrl ? new URL(input.credentials.relayUrl) : null;
  if (!["https:","http:"].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash ||
      !configured || configured.origin !== origin.origin || configured.username || configured.password) throw Error("Reconnect to this Collection's sharing server before exporting it.");
  const session = credentialScopedOperation({ capturedGeneration: input.credentialGeneration, currentGeneration: input.currentCredentialGeneration,
    assertCurrent() { input.signal.throwIfAborted(); input.assertCurrent(); } });
  const path = `/sync/${encodeURIComponent(input.workspaceId)}/datasets/${input.datasetId}/export`;
  session.assertCurrent();
  const response = await input.relayResponse(input.credentials,path,{method:"GET",signal:input.signal,credentials:"omit",redirect:"error",cache:"no-store",headers:{authorization:`Bearer ${input.credentials.token}`,accept:"application/octet-stream"}});
  let accepted = false;
  try {
    session.assertCurrent();
    if (!response.ok) throw Error(`The sharing server could not export this Collection (${response.status}).`);
    if (response.redirected || (response.url && new URL(response.url).href !== new URL(path,origin).href)) throw Error("The sharing server returned another Collection export.");
    if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/octet-stream" || !response.body) throw Error("The sharing server returned an invalid recovery export.");
    const declared = response.headers.get("x-dohc-dataset-export-bytes"), maxBytes = declared && /^[1-9][0-9]*$/.test(declared) ? Number(declared) : NaN;
    if (!Number.isSafeInteger(maxBytes) || maxBytes > input.maxBytes || !/^[a-f0-9]{64}$/.test(response.headers.get("x-dohc-dataset-manifest-sha256") ?? "")) throw Error("The recovery export has an invalid size or integrity header.");
    const reader = response.body.getReader();
    let disposal:Promise<void>|undefined, started=false;
    const dispose = ():Promise<void> => {
      if (!disposal) {
        input.signal.removeEventListener("abort",aborted);
        disposal = reader.cancel().catch(()=>undefined).finally(()=>reader.releaseLock());
      }
      return disposal;
    };
    const aborted = () => { void dispose(); };
    input.signal.addEventListener("abort",aborted,{once:true});
    if (input.signal.aborted) await dispose();
    const stream = {
      async *[Symbol.asyncIterator]() {
        if (started || disposal) throw Error("This recovery download ended. Start the export again.");
        started=true;let received=0;
        try {
          for (;;) {
            session.assertCurrent();
            const item=await reader.read();session.assertCurrent();
            if (item.done) break;
            if (!(item.value instanceof Uint8Array) || !item.value.byteLength || item.value.byteLength > MAX_CHUNK_BYTES || received + item.value.byteLength > maxBytes) throw Error("The recovery export exceeds its size limit.");
            received+=item.value.byteLength;yield item.value;
          }
          if (received !== maxBytes) throw Error("The recovery download was interrupted. Export the Collection again.");
        } finally { await dispose(); }
      },
    };
    accepted=true;return {stream,maxBytes,dispose};
  } finally { if (!accepted && !response.body?.locked) await response.body?.cancel().catch(()=>undefined); }
}
