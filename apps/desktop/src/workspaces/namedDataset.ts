import { createRemoteDatasetData, type OwnerDatasetData } from "./remoteDataset";
import { recordedShareSelector } from "./shareViewRecords";
import type { CloudCredentials } from "./cloudCredentialStore";
import { readDatasetResponse } from "../ipc/readDatasetResponse";
import { DatasetInvocationResult, DatasetResult } from "@dohc/cli/dataset";
import { parseDatasetDescription } from "@dohc/security-contract/dataset";
import type { NamedDatasetPageCache } from "./namedDatasetCache";
import { NamedDatasetOfflineError } from "./namedDatasetTransport";

/** Source View/Edit and Collection data permissions are separate. The relay resolves the named grant. */
export function createNamedDatasetData(input: {
  workspaceId: string; shareView: unknown; credentials: CloudCredentials; credentialGeneration: number; signal: AbortSignal;
  currentCredentialGeneration(): number; assertCurrent(): void;
  relayJson(credentials: CloudCredentials, path: string, init: RequestInit): Promise<unknown>;
  offline?: { cache: NamedDatasetPageCache; relayResponse(credentials: CloudCredentials, path: string, init: RequestInit): Promise<Response> };
}): Pick<OwnerDatasetData, "list" | "describe" | "inspect" | "invoke" | "upload" | "file"> {
  const marker = input.shareView as { shareId?: unknown; relayUrl?: unknown; grantedSelector?: unknown; ended?: unknown } | null;
  if (!marker || typeof marker !== "object" || Array.isArray(marker) || typeof marker.shareId !== "string" || !marker.shareId || marker.shareId.length > 200 ||
    marker.ended !== undefined && marker.ended !== false || !recordedShareSelector(marker.grantedSelector) || typeof marker.relayUrl !== "string" || !input.credentials.relayUrl) {
    throw new Error("This shared workspace is unavailable. Open its current share again.");
  }
  const relay = new URL(marker.relayUrl), credentialsRelay = new URL(input.credentials.relayUrl);
  if (!["http:", "https:"].includes(relay.protocol) || relay.username || relay.password || relay.search || relay.hash ||
    relay.href.replace(/\/+$/, "") !== credentialsRelay.href.replace(/\/+$/, "")) throw new Error("Sign in to the server this shared workspace uses.");
  const data = createRemoteDatasetData({ ...input, shareId: marker.shareId });
  const exposed = { list: data.list, describe: data.describe, invoke: data.invoke, upload: data.upload, file: data.file };
  if (!input.offline) return exposed;
  const { cache, relayResponse } = input.offline;
  const current = () => {
    input.signal.throwIfAborted(); input.assertCurrent();
    if (input.currentCredentialGeneration() !== input.credentialGeneration) throw Error("Your server session changed. Reopen this workspace.");
  };
  const copy = (savedAtMs: number) => ({ offline: true, savedAtMs, coverage: "saved-pages" as const });
  async function request<T>(key: unknown, read: (remote: OwnerDatasetData) => Promise<T>, parse: (value: unknown) => T, save: boolean) {
    current();
    const epoch = await cache.begin();
    let fingerprint: string | null = null;
    const remote = createRemoteDatasetData({ ...input, shareId: marker!.shareId as string, relayJson: async (credentials, path, init) => {
      const response = await relayResponse(credentials, path, init);
      try {
        current();
        const action = path.includes("/invoke") ? "invoke" : path.includes("/file") ? "file" : path.includes("/upload") ? "upload"
          : /\/datasets(?:\?|$)/.test(path) ? "list" : "describe";
        if ([401, 403, 404, 409].includes(response.status)) {
          await cache.clear();
          if (response.status === 409) await readDatasetResponse(response, action, input.signal);
          throw Error("Collection access or rules changed. Reconnect and refresh this view.");
        }
        if (!response.ok) throw Error(`The sharing server returned ${response.status}. Try again.`);
        fingerprint = response.headers.get("x-dohc-dataset-access");
        if (!fingerprint || !/^[a-f0-9]{64}$/.test(fingerprint)) throw Error("The sharing server cannot save permitted pages. Update the server and try again.");
        await cache.accept(fingerprint, epoch);
        const value = await readDatasetResponse(response, action, input.signal);
        current(); return value;
      } finally { if (!response.body?.locked) await response.body?.cancel().catch(() => undefined); }
    } });
    try {
      const value = await read(remote); current();
      // Saving is optional background work. Only a durable offline read advertises saved pages.
      if (save && fingerprint) void cache.put(key, value, fingerprint).catch(() => undefined);
      return { value };
    } catch (error) {
      current();
      if (!(error instanceof NamedDatasetOfflineError)) throw error;
      if (!save) throw Error("This Collection is offline. Connect to change records or open attachments.");
      const page = await cache.read(key); current();
      if (!page) throw Error("This view is not saved on this device. Connect to the sharing server and open it first.");
      return { value: parse(page.value), copy: copy(page.savedAtMs) };
    }
  }
  const inspect: NonNullable<OwnerDatasetData["inspect"]> = async datasetId => {
    const result = await request(["describe", datasetId], remote => remote.describe(datasetId), parseDatasetDescription, true);
    return { dataset: result.value, copy: result.copy };
  };
  return {
    async list(page) {
      const result = await request(["list", page], remote => remote.list(page), value => {
        const result = DatasetResult.parse({ ...(value as object), kind: "list" });
        if (result.kind !== "list") throw Error("The saved Collection list is damaged. Reconnect and refresh it.");
        return { datasets: result.datasets, nextCursor: result.nextCursor };
      }, true);
      return result.value;
    },
    inspect,
    describe: async datasetId => (await inspect(datasetId)).dataset,
    async invoke(invocation) {
      current(); invocation.signal?.throwIfAborted();
      const description = await cache.peek(["describe", invocation.datasetId]);
      const dataset = description ? parseDatasetDescription(description) : (await inspect(invocation.datasetId)).dataset;
      const eligible = dataset.revision === invocation.revision && dataset.revisionSha256 === invocation.revisionSha256 &&
        dataset.operations.some(operation => operation.operationId === invocation.operationId && operation.readOnly);
      const key = ["invoke", invocation.datasetId, invocation.revision, invocation.revisionSha256, invocation.operationId, invocation.input];
      const result = await request(key, remote => remote.invoke(invocation), value => DatasetInvocationResult.parse(value), eligible);
      current(); invocation.signal?.throwIfAborted();
      return { ...result.value, ...(result.copy ? { copy: result.copy } : {}) };
    },
    async upload(value) { return (await request(null, remote => remote.upload(value), value => value as Awaited<ReturnType<OwnerDatasetData["upload"]>>, false)).value; },
    async file(value) { return (await request(null, remote => remote.file(value), value => value as Awaited<ReturnType<OwnerDatasetData["file"]>>, false)).value; },
  };
}
