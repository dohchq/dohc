import { liveConnectionLimitMessage } from "@dohc/live-session-contract/live-connection";
import { SharedDocumentWaitingError } from "../ipc/sharedDocumentOpenState";
import type { ShareRecordStatus } from "./shareRecordStatus";
import * as Y from "yjs";
import { WebSocket as NodeWebSocket } from "ws";
import { readBoundedJson } from "@dohc/service-http";
import { visibleSharePath } from "@dohc/security-contract/share-selector";
import { parseLiveUpdateIdentifier } from "@dohc/live-session-contract/live-update-admission";
import {
  createNamedLiveBrowserTransport,
  LiveAuthorityUnavailableError,
  parseNamedLiveBrowserLimits,
  type NamedLiveSelection,
} from "@dohc/ydoc-projection/named-live-browser-transport";
import { ENGINE_YDOC_UPDATE_MAX_BYTES } from "../ipc/channels";
import { RELAY_FETCH_TIMEOUT_MS, relayApiFetch } from "./sharedChannels";
import type { LiveDraft } from "./liveDraftRecovery";
import type { ShareViewSelector } from "./shareViewInfo";
import type { EngineYDocSessionCapture, EngineYDocSessionProvider } from "./engineYDocSessionIpc";

/** Only main is live. The relay decides again at admission. A joined
 * workspace edits live where its path takes Edit (`levelAt`). */
function editsLive(
  selector: ShareViewSelector,
  path: string,
  levelAt?: (path: string) => string | null,
): boolean {
  const access = levelAt ? levelAt(path) : selector.access;
  return (
    access === "edit" &&
    (selector.versionId === null || selector.versionId === "main") &&
    visibleSharePath(selector, path) === path
  );
}

// Why the relay's live host would not take a document, as a person reads it.
// A code dohc does not know gets no reason, rather than a guess.
const HOST_REFUSAL_REASONS: Readonly<Record<string, string>> = {
  live_host_full: "The server is editing too many pages right now.",
  live_paused_by_owner: "The owner paused live editing for this page.",
  "document-unavailable": "The page moved or was deleted.",
  // The owner's desktop starts the page's live history by itself once it is online.
  "live-document-without-lineage": "Editing starts once the owner's dohc is online.",
};

/**
 * The host's answer ends the open read-only. Only a page waiting for its
 * owner's desktop waits for the host again; any other waits for Try again.
 */
function hostRefused(code: string): SharedDocumentWaitingError {
  const reason = Object.hasOwn(HOST_REFUSAL_REASONS, code) ? HOST_REFUSAL_REASONS[code] : undefined;
  return new SharedDocumentWaitingError({
    state: "host-refused",
    message: reason
      ? `dohc could not open this page for editing. ${reason}`
      : "dohc could not open this page for editing.",
    ...(reason ? { reason } : {}),
    ...(code === "live-document-without-lineage" ? { awaitsHost: true as const } : {}),
  });
}

interface Credentials {
  relayUrl: string;
  token: string;
  userId: string;
  signal: AbortSignal;
}
export function createNamedDesktopLiveCapture(options: {
  shareId: string;
  selector: ShareViewSelector;
  credentials: Credentials;
  assertCurrent(): void;
  fetch?: typeof fetch;
  preserveDraft(draft: LiveDraft): Promise<void>;
  accessEnded(): boolean;
  recordDelivery?(path: string): Promise<ShareRecordStatus | null>;
  isOnline?(): boolean;
  levelAt?(path: string): string | null;
}): EngineYDocSessionCapture {
  const credentials = { ...options.credentials },
    origin = new URL(credentials.relayUrl);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  )
    throw new Error("Invalid live relay.");
  const request = options.fetch ?? relayApiFetch();
  async function admit(path: string, signal: AbortSignal) {
    options.assertCurrent();
    signal.throwIfAborted();
    const response = await request(new URL("/sync/live/desktop-open", origin), {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      signal,
      headers: { authorization: `Bearer ${credentials.token}`, "content-type": "application/json" },
      body: JSON.stringify({ shareId: options.shareId, path }),
    });
    try {
      if (response.status === 409 && !response.redirected) {
        const refusal = await readBoundedJson(response, 1024, signal).catch(() => null);
        const code =
          refusal && typeof refusal === "object" && !Array.isArray(refusal)
            ? (refusal as Record<string, unknown>).code
            : undefined;
        if (typeof code === "string") throw hostRefused(code);
      }
      if (
        response.status !== 200 ||
        response.redirected ||
        response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json"
      )
        throw new Error("Live editing is unavailable.");
      const value = await readBoundedJson(response, ENGINE_YDOC_UPDATE_MAX_BYTES, signal);
      options.assertCurrent();
      signal.throwIfAborted();
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid live admission.");
      const row = value as Record<string, unknown>;
      if (
        row.kind !== "named" ||
        row.userId !== credentials.userId ||
        row.shareId !== options.shareId ||
        row.path !== path ||
        typeof row.discriminator !== "string" ||
        typeof row.expiresAtMs !== "number" ||
        row.expiresAtMs <= Date.now() ||
        !row.ticket ||
        typeof row.ticket !== "object" ||
        Array.isArray(row.ticket)
      )
        throw new Error("Invalid live admission.");
      const ticket = row.ticket as Record<string, unknown>;
      if (
        typeof ticket.token !== "string" ||
        typeof ticket.expiresAtMs !== "number" ||
        ticket.expiresAtMs <= Date.now()
      )
        throw new Error("Invalid live ticket.");
      const grantId = parseLiveUpdateIdentifier(row.grantId),
        workspaceId = `named:${grantId}`;
      if (row.workspaceId !== workspaceId) throw new Error("Invalid live admission.");
      return {
        selection: {
          accountId: credentials.userId,
          workspaceId,
          grantId,
          objectId: parseLiveUpdateIdentifier(row.objectId),
        },
        discriminator: row.discriminator,
        token: ticket.token,
        limits: parseNamedLiveBrowserLimits(row.editorLimits),
      };
    } finally {
      await response.body?.cancel().catch(() => {});
    }
  }
  return {
    async waitForAdmission(path, signal) {
      options.assertCurrent();
      signal.throwIfAborted();
      if (!editsLive(options.selector, path, options.levelAt)) return false;
      const ready = await waitForNamedDesktopAdmission({
        relayUrl: credentials.relayUrl,
        token: credentials.token,
        shareId: options.shareId,
        path,
        signal: AbortSignal.any([signal, credentials.signal]),
        fetch: request,
      });
      options.assertCurrent();
      signal.throwIfAborted();
      return ready;
    },
    async openYDocSession(input): Promise<EngineYDocSessionProvider> {
      if (!editsLive(options.selector, input.path, options.levelAt))
        throw new Error("The shared file is outside this view.");
      if (input.contentKind !== "richdoc" || !/\.md$/i.test(input.path))
        throw new Error("Only shared Markdown supports live editing.");
      const opening = AbortSignal.any([
        credentials.signal,
        AbortSignal.timeout(RELAY_FETCH_TIMEOUT_MS),
      ]);
      if (options.isOnline?.() === false)
        throw new SharedDocumentWaitingError({
          state: "offline",
          message: "This device is offline. Connect to edit this file.",
        });
      const delivery = await options.recordDelivery?.(input.path);
      if (delivery?.state === "pending")
        throw new SharedDocumentWaitingError({
          state: "pending",
          message: "Record saved on this device. Waiting to send.",
        });
      if (delivery?.state === "refused")
        throw new SharedDocumentWaitingError({
          state: "refused",
          message: delivery.reason ?? "The sync relay did not accept this file.",
        });
      let first: Awaited<ReturnType<typeof admit>>;
      try {
        first = await admit(input.path, opening);
      } catch (error) {
        if (error instanceof SharedDocumentWaitingError) throw error;
        const offline = error instanceof TypeError;
        throw new SharedDocumentWaitingError({
          state: "failed",
          message: offline
            ? "dohc could not connect. Check your connection."
            : "dohc could not open this file for editing.",
          reason: offline
            ? "dohc could not connect to the server. Check your connection."
            : "The server did not start live editing for this page.",
        });
      }
      let initial: typeof first | undefined = first;
      const transport = createNamedLiveBrowserTransport<NamedLiveSelection>({
        publicOrigin: origin.origin,
        limits: first.limits,
        recordingContext: () => ({ kind: "account", accountId: credentials.userId }),
        authorize: async (selection, signal) => {
          if (options.accessEnded())
            throw new LiveAuthorityUnavailableError("Live editing is unavailable.");
          const next =
            initial ?? (await admit(input.path, AbortSignal.any([signal, credentials.signal])));
          initial = undefined;
          if (JSON.stringify(next.selection) !== JSON.stringify(selection))
            throw new Error("The shared file changed.");
          const url = new URL("/sync/live/desktop", origin);
          url.protocol = "wss:";
          url.searchParams.set("session", next.discriminator);
          return {
            ticketToken: next.token,
            discriminator: next.discriminator,
            websocketUrl: url.href,
          };
        },
        openSocket: (url, protocols) =>
          new NodeWebSocket(url, protocols, {
            headers: { authorization: `Bearer ${credentials.token}` },
            perMessageDeflate: false,
            maxPayload: first.limits.provider.frames.receive.maxFrameBytes,
          }) as unknown as WebSocket,
      });
      const session = transport.select(first.selection);
      let active = false,
        closed = false,
        token = 0;
      const pendingTokens: number[] = [];
      const abort = () => session.disconnect();
      credentials.signal.addEventListener("abort", abort, { once: true });
      let announce!: () => void;
      const ready = new Promise<void>((resolve, reject) => {
        announce = () => {
          const state = session.state();
          if (state.status === "live") resolve();
          else if (!["authorizing", "connecting", "syncing"].includes(state.status)) {
            const limit = liveConnectionLimitMessage(state.reason);
            reject(
              new SharedDocumentWaitingError({
                state: "failed",
                message: limit ?? "Live editing is paused. Open the file again to retry.",
                reason: limit ?? "The live connection to the server closed.",
              }),
            );
          }
        };
      });
      void ready.catch(() => {});
      const unsubscribe = session.subscribe((state) => {
        if (!active) {
          announce();
          return;
        }
        if (closed) return;
        const limitMessage = liveConnectionLimitMessage(state.reason);
        if (limitMessage && state.reason) input.onEditRefused?.(state.reason, limitMessage);
        if (state.status !== "live")
          input.onSaveState?.(
            "read-only",
            token,
            "status",
            undefined,
            options.accessEnded() ? "access-ended" : "reconnecting",
          );
        else if (state.pendingUpdates === 0)
          for (const accepted of pendingTokens.splice(0))
            input.onSaveState?.("saved-to-host", accepted, "outcome");
      });
      try {
        await session.reconnect();
        announce();
        await ready;
        options.assertCurrent();
        credentials.signal.throwIfAborted();
      } catch (error) {
        unsubscribe();
        credentials.signal.removeEventListener("abort", abort);
        transport.close();
        throw error;
      }
      active = true;
      const stopRemoved = session.onRemovedText(({ text }) => {
        if (!closed) input.onTextRemoved?.(text);
      });
      let localTransaction = false;
      // Each update keeps the head null too, so a teammate's change to the source is judged, not left unknown.
      const update = (bytes: Uint8Array) => {
        if (!localTransaction && !closed) input.onRemoteUpdate(bytes, { sha256: null });
      };
      session.doc.on("update", update);
      const provider: EngineYDocSessionProvider = {
        doc: session.doc,
        initialUpdate: Y.encodeStateAsUpdate(session.doc),
        contentKind: "richdoc",
        path: input.path,
        objectId: first.selection.objectId,
        versionId: "main",
        artifactAssets: [],
        // This device holds no file head, so the note check judges the witnessed source.
        headSha256: null,
        get lineageClaimId() {
          return session.state().binding?.lineageClaimId;
        },
        liveWritable: () => {
          try {
            options.assertCurrent();
            return !closed && !credentials.signal.aborted && session.state().status === "live";
          } catch {
            return false;
          }
        },
        applyLocalUpdate(bytes, onArmed) {
          options.assertCurrent();
          credentials.signal.throwIfAborted();
          if (closed || session.state().status !== "live")
            throw new Error("Live editing is paused.");
          onArmed?.();
          token++;
          pendingTokens.push(token);
          input.onSaveState?.("settling", token, "start");
          localTransaction = true;
          try {
            session.edit(() => Y.applyUpdate(session.doc, bytes));
          } finally {
            localTransaction = false;
          }
          if (session.state().status === "live" && session.state().pendingUpdates === 0) {
            for (const accepted of pendingTokens.splice(0))
              input.onSaveState?.("saved-to-host", accepted, "outcome");
          }
        },
        // A shared session applies each edit at once, so the decision and
        // the edit see the same doc.
        async applyDecidedLocalUpdate(decide, onArmed, applyOptions) {
          const bytes = decide(session.doc);
          if (bytes === null) return false;
          provider.applyLocalUpdate(bytes, onArmed, applyOptions);
          return true;
        },
        // Done once the host holds every edit sent so far. A session that
        // stops first keeps the edit in its draft, and says why it stopped.
        savedToHost: () =>
          new Promise<void>((resolve, reject) => {
            const check = (state = session.state()) => {
              if (state.status === "live" && state.pendingUpdates === 0) {
                stop();
                resolve();
              } else if (!["live", "authorizing", "connecting", "syncing"].includes(state.status)) {
                stop();
                reject(
                  new Error(
                    liveConnectionLimitMessage(state.reason) ??
                      "The live connection to the server closed.",
                  ),
                );
              }
            };
            const stop = session.subscribe(check);
            check();
          }),
        async readArtifactAsset() {
          throw new Error("Shared Markdown has no live artifact assets.");
        },
        async close() {
          if (session.state().pendingUpdates > 0 || pendingTokens.length > 0) {
            session.disconnect();
            await options.preserveDraft({
              path: input.path,
              objectId: first.selection.objectId,
              remoteWorkspaceId: first.selection.workspaceId,
              update: Y.encodeStateAsUpdate(session.doc),
            });
          }
          closed = true;
          unsubscribe();
          stopRemoved();
          credentials.signal.removeEventListener("abort", abort);
          session.doc.off("update", update);
          transport.close();
        },
      };
      return provider;
    },
  };
}

/** One readiness subscription, driven by the relay's existing live-host signal. */
export async function waitForNamedDesktopAdmission(options: {
  relayUrl: string;
  token: string;
  shareId: string;
  path: string;
  signal: AbortSignal;
  fetch?: typeof fetch;
}): Promise<boolean> {
  const response = await (options.fetch ?? relayApiFetch())(
    new URL("/sync/live/desktop-ready", options.relayUrl),
    {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      signal: options.signal,
      headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
      body: JSON.stringify({ shareId: options.shareId, path: options.path }),
    },
  );
  const reader = response.body?.getReader();
  try {
    if (
      response.status !== 200 ||
      response.redirected ||
      response.headers.get("content-type") !== "text/plain" ||
      !reader
    )
      return false;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let text = "";
    for (;;) {
      const chunk = await reader.read();
      options.signal.throwIfAborted();
      if (chunk.done) return text === "waiting\nready\n";
      if (text.length + chunk.value.byteLength > 32) return false;
      text += decoder.decode(chunk.value, { stream: true });
      if (text === "waiting\nready\n") return true;
      if (!"waiting\nready\n".startsWith(text)) return false;
    }
  } finally {
    await reader?.cancel().catch(() => {});
  }
}
