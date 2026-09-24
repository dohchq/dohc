import {mkdir, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {normalizeAbsolutePath} from "@dohc/workspace-core";
import {selfHostedLiveProfile} from "@dohc/sync-relay/self-host-live-profile";
import type {ServerOwnerDelivery} from "./desktopEngine";
import type {CloudCredentials} from "./cloudCredentialStore";
import type {RegistryEntry} from "./registryStore";
import {workspaceRemoteMatchesCredentials} from "./chatRelayIdentity";
import {canonicalRelayUrl} from "./syncCode";
import {workspacePathKey} from "./workspacePathKey";
import {OwnerLiveRefusalsResult} from "../ipc/bridgeContract";
import {z} from "zod";

/** The registry keeps the forward-slash spelling of a root; an operation carries realpath's native spelling. */
const rootKey = (rootPath: string) => workspacePathKey(normalizeAbsolutePath(rootPath));

export function createServerOwnerConnection(options: {
  stateDir(): string;
  workspaces(): RegistryEntry[];
  credentials(): {value: CloudCredentials; signal: AbortSignal} | null;
  fetch(input: string, init: RequestInit): Promise<Response>;
  onRefusalsChanged?(workspaceId: string): void;
}): ServerOwnerDelivery {
  const discovery = new Map<string, {credentials: CloudCredentials; until: number; value: unknown}>();
  const refusalScan = new Map<string, {credentials: CloudCredentials; rootKey: string; after?: string; seen: boolean; published: boolean}>();
  const refusalAttempts = new Map<string, {credentials: CloudCredentials; rootKey: string; until: number}>();
  const eligible = (workspace: RegistryEntry, credentials: CloudCredentials) => !!workspace.remote &&
    !workspace.shareView && !workspace.joinBootstrapPending && workspaceRemoteMatchesCredentials(workspace.remote, credentials);
  return {
    hasRefusals(workspaceId) {
      const session = options.credentials(), state = refusalScan.get(workspaceId);
      const workspace = options.workspaces().find(row => row.workspaceId === workspaceId);
      if (!state || !session || session.signal.aborted || state.credentials !== session.value ||
        !workspace || rootKey(workspace.rootPath) !== state.rootKey || !eligible(workspace, session.value)) {
        refusalScan.delete(workspaceId); return undefined;
      }
      return state.published;
    },
    async prepare() {
      const dir = options.stateDir(), nativeConfigPath = join(dir, "owner-live-ingress.json");
      await mkdir(dir, {recursive: true});
      await writeFile(nativeConfigPath, JSON.stringify(selfHostedLiveProfile.nativeIngress), {mode: 0o600});
      const {nativeIngress: _ingress, ...profile} = structuredClone(selfHostedLiveProfile);
      return {...profile, nativeConfigPath};
    },
    workspaceIds() {
      const session = options.credentials();
      if (!session || session.signal.aborted || !session.value.relayUrl) {discovery.clear(); refusalScan.clear(); refusalAttempts.clear(); return [];}
      const ids = options.workspaces().filter(workspace => eligible(workspace, session.value)).map(workspace => workspace.workspaceId);
      for (const [id, cached] of discovery) if (!ids.includes(id) || cached.credentials !== session.value) discovery.delete(id);
      for (const [id, cached] of refusalScan) if (!ids.includes(id) || cached.credentials !== session.value) refusalScan.delete(id);
      for (const [id, cached] of refusalAttempts) if (!ids.includes(id) || cached.credentials !== session.value) refusalAttempts.delete(id);
      return ids;
    },
    async connect(workspace, lifetime) {
      const session = options.credentials();
      if (!session || session.signal.aborted || !eligible(workspace, session.value)) return null;
      const relayUrl = canonicalRelayUrl(session.value.relayUrl ?? "");
      if (!relayUrl) return null;
      const signal = AbortSignal.any([lifetime, session.signal]), root = rootKey(workspace.rootPath);
      const assertCurrent = () => {
        signal.throwIfAborted();
        const current = options.credentials();
        const registered = options.workspaces().find(row => row.workspaceId === workspace.workspaceId);
        if (!current || current.value !== session.value || !registered || rootKey(registered.rootPath) !== root || !eligible(registered, session.value)) {
          throw new Error("Owner delivery connection changed.");
        }
      };
      return {bearer: session.value.token, relayUrl, signal: session.signal, assertCurrent,
        async refusals(attempt) {
          assertCurrent();
          const requestSignal = AbortSignal.any([signal, attempt]); requestSignal.throwIfAborted();
          const priorAttempt = refusalAttempts.get(workspace.workspaceId);
          if (priorAttempt?.credentials === session.value && priorAttempt.rootKey === root && priorAttempt.until > Date.now()) return;
          // The existing serial delivery loop visits one bounded page at most
          // every ten seconds. Failed pages retain the last confirmed state.
          refusalAttempts.set(workspace.workspaceId, {credentials: session.value, rootKey: root, until: Date.now() + 10_000});
          const saved = refusalScan.get(workspace.workspaceId);
          const state = saved?.credentials === session.value && saved.rootKey === root ? saved : undefined;
          const after = state?.after;
          const suffix = after === undefined ? "" : `&after=${encodeURIComponent(after)}`;
          const response = await options.fetch(`${relayUrl}/sync/${encodeURIComponent(workspace.workspaceId)}/live-host?refusals=1${suffix}`, {
            headers: {authorization: `Bearer ${session.value.token}`}, signal: requestSignal, redirect: "error",
          });
          assertCurrent(); requestSignal.throwIfAborted();
          if (!response.ok || !response.body) {await response.body?.cancel(); throw new Error("Owner live refusal discovery failed.");}
          const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
          try { while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > 1_048_576) throw new Error("Owner live refusal response exceeds its byte limit."); chunks.push(next.value); } }
          finally {await reader.cancel().catch(() => undefined); reader.releaseLock();}
          assertCurrent(); requestSignal.throwIfAborted();
          const value = OwnerLiveRefusalsResult.extend({ok: z.literal(true)}).parse(JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")));
          if (value.nextCursor !== null && value.nextCursor === after) throw new Error("Owner live refusal cursor did not advance.");
          const next = value.nextCursor === null ? undefined : value.nextCursor;
          const seen = (state?.seen ?? false) || value.refusals.length > 0;
          const published = next === undefined ? seen : seen || (state?.published ?? false);
          refusalScan.set(workspace.workspaceId, {credentials: session.value, rootKey: root, after: next, seen: next === undefined ? false : seen, published});
          if (state?.published !== published) options.onRefusalsChanged?.(workspace.workspaceId);
        },
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
