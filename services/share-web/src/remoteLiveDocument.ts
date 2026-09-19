import {createNamedLiveProvider, type NamedLiveProviderState} from "@dohc/ydoc-projection/named-live-provider";
import {yDocToMarkdown} from "@dohc/ydoc-projection";
import type {NamedLiveBrowserLimits} from "@dohc/ydoc-projection/named-live-browser-transport";
import type {createLinkLiveClient} from "./linkLiveClient";
import {replaceLiveText} from "./liveTextEdit";
import {LIVE_UPDATE_REFUSAL_VALUES} from "@dohc/live-session-contract/live-update-admission";

type Provider = ReturnType<typeof createNamedLiveProvider>;
function waitFor(provider: Provider, predicate: (state: NamedLiveProviderState) => boolean, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const finish = (error?: Error) => {unsubscribe(); signal.removeEventListener("abort", abort); error ? reject(error) : resolve();};
    const abort = () => finish(new Error("The live document request timed out or was cancelled."));
    const check = (state: NamedLiveProviderState) => {
      if (signal.aborted) abort();
      else if (["quarantined", "disconnected", "closed"].includes(state.status)) finish(new Error(state.reason ?? "Live document is unavailable."));
      else if (predicate(state)) finish();
    };
    unsubscribe = provider.subscribe(check);
    signal.addEventListener("abort", abort, {once: true});
    check(provider.state());
  });
}

export async function remoteLiveDocument(options: {
  client: ReturnType<typeof createLinkLiveClient>;
  limits: NamedLiveBrowserLimits;
  discriminator: string;
  cookie: string;
  request(path: string, init?: RequestInit): Promise<Response>;
  signal: AbortSignal;
}, path: string, edit?: {find: string; replacement: string}) {
  const lifetime = new AbortController();
  const signal = AbortSignal.any([options.signal, lifetime.signal, AbortSignal.timeout(30_000)]);
  let provider: Provider | undefined;
  let route: ReturnType<Provider["connect"]> | undefined;
  let changed = false;
  try {
    const document = await options.request("/api/live/link-document", {method: "POST", body: JSON.stringify({discriminator: options.discriminator, path}), signal});
    if (!document.ok) throw new Error("The live document is unavailable or this link cannot edit it.");
    const {objectId} = await document.json() as {objectId: string};
    const ticket = await options.request("/api/live/link-ticket", {method: "POST", body: JSON.stringify({discriminator: options.discriminator, objectId}), signal});
    if (!ticket.ok) throw new Error("The live document is unavailable or this link cannot edit it.");
    const {token} = await ticket.json() as {token: string};
    const frames = options.limits.provider.frames;
    const host = await options.client.openMaterialRoute(options.discriminator, options.cookie, token, signal, {
      maxPayload: frames.receive.maxFrameBytes, maxFragments: 64, maxBufferedChunks: 64,
      closeTimeout: options.limits.sendTimeoutMs, perMessageDeflate: false, autoPong: false,
    });
    if (!host) throw new Error("The live document host is unavailable.");
    provider = createNamedLiveProvider(options.limits.provider, {objectId});
    const current = provider;
    route = provider.connect({
      send(bytes) {
        return new Promise((resolve, reject) => {
          if (host.socket.bufferedAmount + bytes.length > options.limits.maxSocketBufferedBytes) {reject(new Error("Socket buffer limit reached.")); return;}
          host.socket.send(bytes, {binary: true}, error => error ? reject(error) : resolve());
        });
      }, close() {host.socket.terminate();},
    });
    host.socket.on("message", (bytes, binary) => {
      if (!binary || !(bytes instanceof Buffer)) {route!.disconnect(); return;}
      void route!.receive(bytes);
    });
    host.invalidated.addEventListener("abort", () => route!.disconnect(), {once: true});
    if (host.invalidated.aborted) route.disconnect();
    host.socket.resume();
    await waitFor(current, state => state.status === "live", signal);
    if (edit) {
      replaceLiveText(current.body, edit.find, edit.replacement);
      if (current.state().pendingUpdates === 0 && current.state().status !== "live") throw new Error(current.state().reason ?? "The provider refused the edit before sending it.");
      changed = true;
      await waitFor(current, state => state.pendingUpdates === 0 && state.lastApplied !== null, signal);
      return {ok: true, path, source: "live", outcome: "applied", acknowledgement: current.state().lastApplied};
    }
    return {ok: true, path, markdown: yDocToMarkdown(current.doc), source: "live"};
  } catch (error) {
    const state = provider?.state();
    const refused = state?.status === "quarantined" && LIVE_UPDATE_REFUSAL_VALUES.some(reason => reason === state.reason);
    const unknown = changed && !refused;
    return {ok: false, path, outcome: unknown ? "unknown" : "not-applied", error: unknown ? "The edit outcome is unknown. Read the live document before retrying." : error instanceof Error ? error.message : "Live document is unavailable."};
  } finally {
    lifetime.abort();
    provider?.close();
    await route?.settled();
    provider?.doc.destroy();
  }
}
