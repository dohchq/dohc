import {readBoundedJson} from "@dohc/service-http";
import {mkdir, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {selfHostedLiveProfile} from "@dohc/sync-relay/self-host-live-profile";
import type {ServerOwnerDelivery} from "./desktopEngine";
import type {CloudCredentials} from "./cloudCredentialStore";
import type {RegistryEntry} from "./registryStore";
import {workspaceRemoteMatchesCredentials} from "./chatRelayIdentity";
import {canonicalRelayUrl} from "./syncCode";
import {OwnerLiveRefusalsResult} from "../ipc/bridgeContract";
import {ServerKeptEditsConflict, ServerRecoveryCopyRefusedError} from "./ownerLiveQuarantine";
import {z} from "zod";

// A list page holds up to 256 rows of edits the server kept. A row is at most
// about 13 KiB: its 4096-character path alone can take 12 KiB of UTF-8.
const KEPT_EDITS_PAGE_BYTES = 256 * 13 * 1024 + 64 * 1024;
// The live document list carries its documents and the first such page.
const LIVE_DOCUMENTS_BYTES = 1_048_576 + KEPT_EDITS_PAGE_BYTES;

export function createServerOwnerConnection(options: {
  stateDir(): string;
  workspaces(): RegistryEntry[];
  credentials(): {value: CloudCredentials; signal: AbortSignal} | null;
  fetch(input: string, init: RequestInit): Promise<Response>;
  onRefusalsChanged?(workspaceId: string): void;
}): ServerOwnerDelivery {
  const discovery = new Map<string, {credentials: CloudCredentials; until: number; value: unknown}>();
  const refusalScan = new Map<string, {credentials: CloudCredentials; rootPath: string; after?: string; seen: boolean; published: boolean}>();
  const refusalAttempts = new Map<string, {credentials: CloudCredentials; rootPath: string; until: number}>();
  const eligible = (workspace: RegistryEntry, credentials: CloudCredentials) => !!workspace.remote &&
    !workspace.shareView && !workspace.joinBootstrapPending && workspaceRemoteMatchesCredentials(workspace.remote, credentials);
  return {
    hasRefusals(workspaceId) {
      const session = options.credentials(), state = refusalScan.get(workspaceId);
      const workspace = options.workspaces().find(row => row.workspaceId === workspaceId);
      if (!state || !session || session.signal.aborted || state.credentials !== session.value ||
        !workspace || workspace.rootPath !== state.rootPath || !eligible(workspace, session.value)) {
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
      // The operation carries realpath's spelling of the root. The authority operation has just matched
      // the registry row against its registered spelling, so the session pins that one and compares it exactly.
      const rootPath = options.workspaces().find(row => row.workspaceId === workspace.workspaceId)?.rootPath;
      if (rootPath === undefined) return null;
      const signal = AbortSignal.any([lifetime, session.signal]);
      const assertCurrent = () => {
        signal.throwIfAborted();
        const current = options.credentials();
        const registered = options.workspaces().find(row => row.workspaceId === workspace.workspaceId);
        if (!current || current.value !== session.value || !registered || registered.rootPath !== rootPath || !eligible(registered, session.value)) {
          throw new Error("Owner delivery connection changed.");
        }
      };
      return {bearer: session.value.token, accountId: session.value.userId, relayUrl, signal: session.signal, assertCurrent,
        async refusals(attempt) {
          assertCurrent();
          const requestSignal = AbortSignal.any([signal, attempt]); requestSignal.throwIfAborted();
          const priorAttempt = refusalAttempts.get(workspace.workspaceId);
          if (priorAttempt?.credentials === session.value && priorAttempt.rootPath === rootPath && priorAttempt.until > Date.now()) return;
          // The existing serial delivery loop visits one bounded page at most
          // every ten seconds. Failed pages retain the last confirmed state.
          refusalAttempts.set(workspace.workspaceId, {credentials: session.value, rootPath, until: Date.now() + 10_000});
          const saved = refusalScan.get(workspace.workspaceId);
          const state = saved?.credentials === session.value && saved.rootPath === rootPath ? saved : undefined;
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
          refusalScan.set(workspace.workspaceId, {credentials: session.value, rootPath, after: next, seen: next === undefined ? false : seen, published});
          if (state?.published !== published) options.onRefusalsChanged?.(workspace.workspaceId);
        },
        // A page carries at most one engine response frame of the queue, 8 MiB, in base64.
        async keptEdits(input, attempt) {
          assertCurrent();
          const requestSignal = AbortSignal.any([signal, attempt]);
          const response = await options.fetch(`${relayUrl}/sync/${encodeURIComponent(workspace.workspaceId)}/live-host/kept-edits`, {
            method: "POST", headers: {authorization: `Bearer ${session.value.token}`, "content-type": "application/json"},
            body: JSON.stringify(input), signal: requestSignal, redirect: "error",
          });
          assertCurrent(); requestSignal.throwIfAborted();
          const value = await readBoundedJson(response, 9 * 1024 * 1024, requestSignal);
          assertCurrent();
          if (response.status === 409) {
            const code = value && typeof value === "object" && "code" in value ? value.code : undefined;
            if (code === "kept-edits-changed" || code === "kept-edits-earlier") throw new ServerKeptEditsConflict(code === "kept-edits-earlier");
            if (code === "kept-edits-unrecoverable") throw new ServerRecoveryCopyRefusedError(value && typeof value === "object" && "reason" in value ? value.reason : undefined);
            throw new Error(value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error
              : "This document changed. Open Live documents to check it.");
          }
          if (!response.ok) throw new Error("dohc could not reach your kept edits on the server. Try again.");
          // The next pass reads the list the action changed, not one cached before it.
          if (input.action !== "page") discovery.delete(workspace.workspaceId);
          return value;
        },
        // A later page of the list of edits the server kept, after the cursor its previous page named.
        async keptEditsPage(after, attempt) {
          assertCurrent();
          const requestSignal = AbortSignal.any([signal, attempt]);
          const response = await options.fetch(`${relayUrl}/sync/${encodeURIComponent(workspace.workspaceId)}/live-host?kept=1&after=${after}`, {
            headers: {authorization: `Bearer ${session.value.token}`}, signal: requestSignal, redirect: "error",
          });
          assertCurrent(); requestSignal.throwIfAborted();
          if (!response.ok) {await response.body?.cancel(); throw new Error("Owner kept edits discovery failed.");}
          const value = await readBoundedJson(response, KEPT_EDITS_PAGE_BYTES, requestSignal);
          assertCurrent();
          return value;
        },
        async retire(binding, attempt) {
          assertCurrent();const requestSignal=AbortSignal.any([signal,attempt]);
          const response=await options.fetch(`${relayUrl}/sync/${encodeURIComponent(workspace.workspaceId)}/live-host`,{
            method:"DELETE",headers:{authorization:`Bearer ${session.value.token}`,"content-type":"application/json"},
            body:JSON.stringify({path:binding.currentPath,objectId:binding.objectId,retire:true,restoreFenceGeneration:binding.restoreFenceGeneration}),signal:requestSignal,redirect:"error",
          });
          assertCurrent();requestSignal.throwIfAborted();
          if (!response.ok && response.status!==409) {await response.body?.cancel();throw new Error("dohc could not stop live editing. Try again.");}
          const value=await readBoundedJson(response,16*1024,requestSignal);
          if (response.status===409 && value && typeof value==="object" && "code" in value && ["restore-fenced","restore-in-progress"].includes(String(value.code))) return null;
          if (!response.ok) throw new Error("dohc could not stop live editing. Try again.");
          const retired=z.object({ok:z.literal(true),path:z.string().min(1),objectId:z.literal(binding.objectId),status:z.literal("retired"),acceptedCursor:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)}).parse(value);
          discovery.delete(workspace.workspaceId);return retired.acceptedCursor;
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
              if (bytes > LIVE_DOCUMENTS_BYTES) throw new Error("Owner live document response exceeds its byte limit.");
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
