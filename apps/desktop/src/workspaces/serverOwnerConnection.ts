import {mkdir, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {selfHostedLiveProfile} from "@dohc/sync-relay/self-host-live-profile";
import type {ServerOwnerDelivery} from "./desktopEngine";
import type {CloudCredentials} from "./cloudCredentialStore";
import type {RegistryEntry} from "./registryStore";
import {workspaceRemoteMatchesCredentials} from "./chatRelayIdentity";
import {canonicalRelayUrl} from "./syncCode";

export function createServerOwnerConnection(options: {
  stateDir(): string;
  workspaces(): RegistryEntry[];
  credentials(): {value: CloudCredentials; signal: AbortSignal} | null;
  fetch(input: string, init: RequestInit): Promise<Response>;
}): ServerOwnerDelivery {
  const discovery = new Map<string, {credentials: CloudCredentials; until: number; value: unknown}>();
  const eligible = (workspace: RegistryEntry, credentials: CloudCredentials) => !!workspace.remote &&
    !workspace.shareView && !workspace.joinBootstrapPending && workspaceRemoteMatchesCredentials(workspace.remote, credentials);
  return {
    async prepare() {
      const dir = options.stateDir(), nativeConfigPath = join(dir, "owner-live-ingress.json");
      await mkdir(dir, {recursive: true});
      await writeFile(nativeConfigPath, JSON.stringify(selfHostedLiveProfile.nativeIngress), {mode: 0o600});
      const {nativeIngress: _ingress, ...profile} = structuredClone(selfHostedLiveProfile);
      return {...profile, nativeConfigPath};
    },
    workspaceIds() {
      const session = options.credentials();
      if (!session || session.signal.aborted || !session.value.relayUrl) {discovery.clear(); return [];}
      const ids = options.workspaces().filter(workspace => eligible(workspace, session.value)).map(workspace => workspace.workspaceId);
      for (const [id, cached] of discovery) if (!ids.includes(id) || cached.credentials !== session.value) discovery.delete(id);
      return ids;
    },
    async connect(workspace, lifetime) {
      const session = options.credentials();
      if (!session || session.signal.aborted || !eligible(workspace, session.value)) return null;
      const relayUrl = canonicalRelayUrl(session.value.relayUrl ?? "");
      if (!relayUrl) return null;
      const signal = AbortSignal.any([lifetime, session.signal]);
      const assertCurrent = () => {
        signal.throwIfAborted();
        const current = options.credentials();
        const registered = options.workspaces().find(row => row.workspaceId === workspace.workspaceId);
        if (!current || current.value !== session.value || !registered || registered.rootPath !== workspace.rootPath || !eligible(registered, session.value)) {
          throw new Error("Owner delivery connection changed.");
        }
      };
      return {bearer: session.value.token, relayUrl, signal: session.signal, assertCurrent,
        async documents(attempt) {
          assertCurrent();
          const requestSignal = AbortSignal.any([signal, attempt]);
          requestSignal.throwIfAborted();
          const cached = discovery.get(workspace.workspaceId);
          if (cached?.credentials === session.value && cached.until > Date.now()) return cached.value;
          const response = await options.fetch(`${relayUrl}/sync/${encodeURIComponent(workspace.workspaceId)}/live-host`, {
            headers: {authorization: `Bearer ${session.value.token}`}, signal: requestSignal, redirect: "error",
          });
          assertCurrent(); requestSignal.throwIfAborted();
          if (!response.ok || !response.body) {await response.body?.cancel(); throw new Error("Owner live document discovery failed.");}
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = []; let bytes = 0;
          try {
            while (true) {
              const next = await reader.read();
              assertCurrent(); requestSignal.throwIfAborted();
              if (next.done) break;
              bytes += next.value.byteLength;
              if (bytes > 1_048_576) throw new Error("Owner live document response exceeds its byte limit.");
              chunks.push(next.value);
            }
          } finally {await reader.cancel().catch(() => undefined); reader.releaseLock();}
          const value: unknown = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
          discovery.set(workspace.workspaceId, {credentials: session.value, until: Date.now() + 2_000, value});
          return value;
        },
      };
    },
  };
}
