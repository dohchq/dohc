import * as Y from "yjs";
import { WebSocket as NodeWebSocket } from "ws";
import { readBoundedJson } from "@dohc/service-http";
import { parseLiveUpdateIdentifier } from "@dohc/live-session-contract/live-update-admission";
import { createNamedLiveBrowserTransport, parseNamedLiveBrowserLimits, type NamedLiveSelection } from "@dohc/ydoc-projection/named-live-browser-transport";
import { ENGINE_YDOC_UPDATE_MAX_BYTES } from "../ipc/channels";
import { RELAY_FETCH_TIMEOUT_MS, relayApiFetch } from "./sharedChannels";
import type { NamedLiveDraft } from "./namedLiveDraftRecovery";
import type { ShareViewSelector } from "./shareViewInfo";
import type { EngineYDocSessionCapture, EngineYDocSessionProvider } from "./engineYDocSessionIpc";

interface Credentials { relayUrl: string; token: string; userId: string; signal: AbortSignal }
export function createNamedDesktopLiveCapture(options: {
  shareId: string; selector: ShareViewSelector; credentials: Credentials; assertCurrent(): void; fetch?: typeof fetch;
  preserveDraft(draft: NamedLiveDraft): Promise<void>;
}): EngineYDocSessionCapture {
  const credentials = { ...options.credentials }, origin = new URL(credentials.relayUrl);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash) throw new Error("Invalid live relay.");
  const request = options.fetch ?? relayApiFetch();
  async function admit(path: string, signal: AbortSignal) {
    options.assertCurrent(); signal.throwIfAborted();
    const response = await request(new URL("/sync/live/desktop-open", origin), {
      method: "POST", redirect: "error", cache: "no-store", signal,
      headers: { authorization: `Bearer ${credentials.token}`, "content-type": "application/json" },
      body: JSON.stringify({ shareId: options.shareId, path }),
    });
    try {
      if (response.status !== 200 || response.redirected || response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") throw new Error("Live editing is unavailable.");
      const value = await readBoundedJson(response, ENGINE_YDOC_UPDATE_MAX_BYTES, signal);
      options.assertCurrent(); signal.throwIfAborted();
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid live admission.");
      const row = value as Record<string, unknown>;
      if (row.kind !== "named" || row.userId !== credentials.userId || row.shareId !== options.shareId || row.path !== path ||
        typeof row.discriminator !== "string" || typeof row.expiresAtMs !== "number" || row.expiresAtMs <= Date.now() ||
        !row.ticket || typeof row.ticket !== "object" || Array.isArray(row.ticket)) throw new Error("Invalid live admission.");
      const ticket = row.ticket as Record<string, unknown>;
      if (typeof ticket.token !== "string" || typeof ticket.expiresAtMs !== "number" || ticket.expiresAtMs <= Date.now()) throw new Error("Invalid live ticket.");
      return { selection: { accountId: credentials.userId, workspaceId: parseLiveUpdateIdentifier(row.workspaceId),
        grantId: parseLiveUpdateIdentifier(row.grantId), objectId: parseLiveUpdateIdentifier(row.objectId) },
        discriminator: row.discriminator, token: ticket.token, limits: parseNamedLiveBrowserLimits(row.editorLimits) };
    } finally { await response.body?.cancel().catch(() => {}); }
  }
  return {
    async openYDocSession(input): Promise<EngineYDocSessionProvider> {
      if (options.selector.access !== "edit" || (options.selector.versionId !== null && options.selector.versionId !== "main") ||
        !(options.selector.paths.length === 0 ? options.selector.versionId === "main" : options.selector.paths.some(path => input.path === path || input.path.startsWith(`${path}/`)))) throw new Error("The shared file is outside this view.");
      if (input.contentKind !== "richdoc" || !/\.md$/i.test(input.path)) throw new Error("Only shared Markdown supports live editing.");
      const opening = AbortSignal.any([credentials.signal, AbortSignal.timeout(RELAY_FETCH_TIMEOUT_MS)]);
      const first = await admit(input.path, opening);
      let initial: typeof first | undefined = first;
      const transport = createNamedLiveBrowserTransport<NamedLiveSelection>({ publicOrigin: origin.origin, limits: first.limits,
        authorize: async (selection, signal) => {
          const next = initial ?? await admit(input.path, AbortSignal.any([signal, credentials.signal]));
          initial = undefined;
          if (JSON.stringify(next.selection) !== JSON.stringify(selection)) throw new Error("The shared file changed.");
          const url = new URL("/sync/live/desktop", origin); url.protocol = "wss:"; url.searchParams.set("session", next.discriminator);
          return { ticketToken: next.token, discriminator: next.discriminator, websocketUrl: url.href };
        },
        openSocket: (url, protocols) => new NodeWebSocket(url, protocols, { headers: { authorization: `Bearer ${credentials.token}` },
          perMessageDeflate: false, maxPayload: first.limits.provider.frames.receive.maxFrameBytes }) as unknown as WebSocket,
      });
      const session = transport.select(first.selection);
      let active = false, closed = false, token = 0;
      const pendingTokens: number[] = [];
      const abort = () => session.disconnect();
      credentials.signal.addEventListener("abort", abort, { once: true });
      let announce!: () => void;
      const ready = new Promise<void>((resolve, reject) => {
        announce = () => {
          const state = session.state();
          if (state.status === "live") resolve();
          else if (!["authorizing", "connecting", "syncing"].includes(state.status)) reject(new Error("Live editing is paused. Open the file again to retry."));
        };
      });
      void ready.catch(() => {});
      const unsubscribe = session.subscribe(state => {
        if (!active) { announce(); return; }
        if (closed) return;
        if (state.status !== "live") input.onSaveState?.("read-only", token);
        else if (state.pendingUpdates === 0) for (const accepted of pendingTokens.splice(0)) input.onSaveState?.("saved", accepted);
      });
      try { await session.reconnect(); announce(); await ready; options.assertCurrent(); credentials.signal.throwIfAborted(); }
      catch (error) { unsubscribe(); credentials.signal.removeEventListener("abort", abort); transport.close(); throw error; }
      active = true;
      let localTransaction = false;
      const update = (bytes: Uint8Array) => { if (!localTransaction && !closed) input.onRemoteUpdate(bytes); };
      session.doc.on("update", update);
      return {
        doc: session.doc, initialUpdate: Y.encodeStateAsUpdate(session.doc), contentKind: "richdoc", path: input.path,
        objectId: first.selection.objectId, versionId: "main", artifactAssets: [],
        get lineageClaimId() { return session.state().binding?.lineageClaimId; },
        liveWritable: () => {
          try { options.assertCurrent(); return !closed && !credentials.signal.aborted && session.state().status === "live"; }
          catch { return false; }
        },
        applyLocalUpdate(bytes, onArmed) {
          options.assertCurrent(); credentials.signal.throwIfAborted();
          if (closed || session.state().status !== "live") throw new Error("Live editing is paused.");
          onArmed?.(); token++; pendingTokens.push(token); input.onSaveState?.("settling", token);
          localTransaction = true;
          try { session.edit(() => Y.applyUpdate(session.doc, bytes)); }
          finally { localTransaction = false; }
          if (session.state().status === "live" && session.state().pendingUpdates === 0) {
            for (const accepted of pendingTokens.splice(0)) input.onSaveState?.("saved", accepted);
          }
          return Promise.resolve();
        },
        async readArtifactAsset() { throw new Error("Shared Markdown has no live artifact assets."); },
        async close() {
          if (session.state().pendingUpdates > 0 || pendingTokens.length > 0) {
            session.disconnect();
            await options.preserveDraft({ path: input.path, objectId: first.selection.objectId,
              remoteWorkspaceId: first.selection.workspaceId, update: Y.encodeStateAsUpdate(session.doc) });
          }
          closed = true; unsubscribe(); credentials.signal.removeEventListener("abort", abort); session.doc.off("update", update); transport.close();
        },
      };
    },
  };
}
