import { parseLiveUpdateIdentifier } from "@dohc/live-session-contract/live-update-admission";
import { parseLiveTicketToken } from "@dohc/live-session-contract/live-ticket";
import { createNamedLiveProvider, type NamedLiveProviderLimits, type NamedLiveProviderState } from "./namedLiveProvider";

/** Account ID is a stale-selection guard, never an authentication credential. */
export interface NamedLiveSelection {
  accountId: string;
  workspaceId: string;
  grantId: string;
  objectId: string;
}
export interface NamedLiveBrowserLimits {
  provider: NamedLiveProviderLimits;
  maxHttpResponseBytes: number;
  maxSocketBufferedBytes: number;
  connectTimeoutMs: number;
  sendTimeoutMs: number;
  drainPollMs: number;
}
export interface NamedLiveBrowserState extends Omit<NamedLiveProviderState, "status"> {
  status: NamedLiveProviderState["status"] | "authorizing" | "refused";
}
type BrowserSocket = Pick<WebSocket, "readyState" | "bufferedAmount" | "protocol" | "extensions" | "binaryType" |
  "send" | "close" | "addEventListener" | "removeEventListener">;
interface Options {
  publicOrigin: string;
  limits: NamedLiveBrowserLimits;
  fetch?: typeof fetch;
  openSocket?: (url: string, protocols: string[]) => BrowserSocket;
}
type Provider = ReturnType<typeof createNamedLiveProvider>;
type Route = ReturnType<Provider["connect"]>;
type Override = Pick<NamedLiveBrowserState, "status" | "reason">;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: unknown, keys: string): value is Record<string, unknown> => record(value) && Object.keys(value).sort().join(",") === keys;
class Refused extends Error {}
class Unavailable extends Error {}

/** One current selection. Retired handles retain only their in-memory draft for caller-owned recovery. */
export function createNamedLiveBrowserTransport(options: Options) {
  const origin = new URL(options.publicOrigin), limits = structuredClone(options.limits);
  if (origin.protocol !== "https:" || origin.origin !== options.publicOrigin) throw new TypeError("Named editing requires an HTTPS origin.");
  for (const value of [limits.maxHttpResponseBytes, limits.maxSocketBufferedBytes, limits.connectTimeoutMs, limits.sendTimeoutMs, limits.drainPollMs]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
      throw new TypeError("Invalid browser transport limits.");
    }
  }
  if (limits.maxSocketBufferedBytes < limits.provider.frames.receive.maxFrameBytes) throw new TypeError("Socket capacity cannot hold a frame.");
  const request = options.fetch ?? globalThis.fetch.bind(globalThis);
  const openSocket = options.openSocket ?? ((url, protocols) => new WebSocket(url, protocols));
  let selected: ReturnType<typeof session> | undefined;

  function session(selection: NamedLiveSelection) {
    const target = { ...selection };
    for (const value of Object.values(target)) parseLiveUpdateIdentifier(value);
    const provider = createNamedLiveProvider(limits.provider, target);
    const listeners = new Set<(state: NamedLiveBrowserState) => void>();
    let override: Override | undefined, closed = false, retiring = Promise.resolve();
    type Attempt = { controller: AbortController; route?: Route; socket?: BrowserSocket; timer?: ReturnType<typeof setTimeout>;
      removeListeners?: () => void; writes: Set<Promise<void>> };
    let attempt: Attempt | undefined;
    const state = (): NamedLiveBrowserState => ({ ...provider.state(), ...override });
    const notify = () => { for (const listener of listeners) { try { listener(state()); } catch { /* Observer owns its failure. */ } } };
    const current = (held: Attempt) => attempt === held && !held.controller.signal.aborted && !closed;
    function stop() {
      const previous = attempt; attempt = undefined;
      if (!previous) return;
      clearTimeout(previous.timer);
      previous.controller.abort();
      previous.removeListeners?.();
      previous.route?.disconnect();
      try { previous.socket?.close(); } catch { /* The attempt is already retired. */ }
      const prior = retiring;
      retiring = Promise.allSettled([prior, previous.route?.settled(), ...previous.writes]).then(() => undefined);
    }
    function fail(held: Attempt, status: Override["status"], reason: string) {
      if (!current(held)) return;
      override = { status, reason }; stop(); notify();
    }
    const unsubscribe = provider.subscribe(value => {
      if (value.status === "live") clearTimeout(attempt?.timer);
      notify();
    });
    async function json(held: Attempt, path: string, body?: unknown): Promise<unknown> {
      const signal = held.controller.signal;
      let response: Response | undefined;
      const work = (async () => {
        try {
          response = await request(new URL(path, origin), { method: body === undefined ? "GET" : "POST",
            credentials: "same-origin", cache: "no-store", redirect: "error", signal,
            headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
          signal.throwIfAborted();
          if ([401, 403, 404].includes(response.status)) throw new Unavailable();
          if (response.status !== 200 || response.redirected || !response.body ||
              response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new Error("Invalid response.");
          const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
          let bytes = 0, text = "";
          const abort = () => { void reader.cancel().catch(() => {}); };
          signal.addEventListener("abort", abort, { once: true });
          try {
            while (true) {
              signal.throwIfAborted();
              const chunk = await reader.read(); signal.throwIfAborted();
              if (chunk.done) break;
              if (chunk.value.length > limits.maxHttpResponseBytes - bytes) throw new Error("Response limit.");
              bytes += chunk.value.length; text += decoder.decode(chunk.value, { stream: true });
            }
            return JSON.parse(text + decoder.decode()) as unknown;
          } finally { signal.removeEventListener("abort", abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
        } finally { await response?.body?.cancel().catch(() => {}); }
      })();
      let abort!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(new Error("Attempt retired.")); signal.addEventListener("abort", abort, { once: true }); });
      if (signal.aborted) abort();
      try { return await Promise.race([work, cancelled]); }
      finally { signal.removeEventListener("abort", abort); }
    }
    function attach(held: Attempt, socket: BrowserSocket): Promise<void> {
      held.socket = socket; socket.binaryType = "arraybuffer";
      return new Promise<void>((resolve, reject) => {
        let opened = false;
        const abort = () => reject(new Error("Attempt retired."));
        const finish = () => { held.controller.signal.removeEventListener("abort", abort); };
        const disconnected = () => { fail(held, "disconnected", "transport-closed"); finish(); reject(new Error("Socket closed.")); };
        function send(bytes: Uint8Array): Promise<void> {
          const work = new Promise<void>((sent, failed) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const deadline = performance.now() + limits.sendTimeoutMs;
            const cancel = () => { clearTimeout(timer); held.controller.signal.removeEventListener("abort", cancel); failed(new Error("Send retired.")); };
            held.controller.signal.addEventListener("abort", cancel, { once: true });
            const pump = () => {
              if (!current(held) || socket.readyState !== 1) { cancel(); return; }
              if (socket.bufferedAmount > limits.maxSocketBufferedBytes - bytes.byteLength) {
                if (performance.now() >= deadline) { cancel(); fail(held, "disconnected", "send-timeout"); return; }
                timer = setTimeout(pump, Math.min(limits.drainPollMs, Math.max(0, deadline - performance.now()))); return;
              }
              held.controller.signal.removeEventListener("abort", cancel);
              try { socket.send(bytes as Uint8Array<ArrayBuffer>); sent(); } catch (error) { failed(error); }
            };
            pump();
          });
          held.writes.add(work); void work.then(() => held.writes.delete(work), () => held.writes.delete(work));
          return work;
        }
        const onOpen = () => {
          if (!current(held) || opened) return;
          if (socket.protocol !== "dohc-live-v1" || socket.extensions) { fail(held, "quarantined", "invalid-socket-protocol"); return; }
          opened = true;
          try {
            override = undefined;
            held.route = provider.connect({ send, close() { stop(); } });
            finish(); resolve();
          } catch { disconnected(); }
        };
        const onMessage = (event: MessageEvent) => {
          if (!current(held)) return;
          if (!opened || !held.route || !(event.data instanceof ArrayBuffer)) { fail(held, "quarantined", "invalid-socket-message"); return; }
          void held.route.receive(new Uint8Array(event.data));
        };
        socket.addEventListener("open", onOpen);
        socket.addEventListener("message", onMessage);
        socket.addEventListener("error", disconnected);
        socket.addEventListener("close", disconnected);
        held.controller.signal.addEventListener("abort", abort, { once: true });
        held.removeListeners = () => {
          socket.removeEventListener("open", onOpen); socket.removeEventListener("message", onMessage);
          socket.removeEventListener("error", disconnected); socket.removeEventListener("close", disconnected); finish();
        };
      });
    }
    return {
      doc: provider.doc, body: provider.body, state,
      subscribe(listener: (value: NamedLiveBrowserState) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      /** Editors must use this guard before their synchronous Yjs transaction. */
      edit(change: () => void): boolean {
        if (closed || state().status !== "live") return false;
        provider.doc.transact(change); return true;
      },
      /** One explicit attempt. Opening the socket does not make the document editable. */
      async reconnect(): Promise<void> {
        if (closed || ["quarantined", "refused"].includes(state().status)) return;
        stop();
        const held: Attempt = { controller: new AbortController(), writes: new Set() };
        attempt = held; override = { status: "authorizing", reason: null }; notify();
        held.timer = setTimeout(() => fail(held, "disconnected", "connect-timeout"), limits.connectTimeoutMs);
        try {
          await retiring;
          if (!current(held)) return;
          const account = await json(held, "/api/account/session");
          if (!exact(account, "user")) throw new Error("Invalid account response.");
          if (account.user === null) throw new Refused();
          if (!exact(account.user, "id,name") || typeof account.user.name !== "string") throw new Error("Invalid account response.");
          if (account.user.id !== target.accountId) throw new Refused();
          const bootstrap = await json(held, "/api/live/named-session", { grantId: target.grantId });
          if (!exact(bootstrap, "discriminator,expiresAtMs") || typeof bootstrap.discriminator !== "string" || !/^[A-Za-z0-9_-]{12}$/.test(bootstrap.discriminator) ||
              typeof bootstrap.expiresAtMs !== "number" || !Number.isSafeInteger(bootstrap.expiresAtMs) || bootstrap.expiresAtMs <= Date.now()) throw new Error("Invalid session.");
          const ticket = await json(held, "/api/live/named-ticket", { discriminator: bootstrap.discriminator, objectId: target.objectId });
          if (!exact(ticket, "expiresAtMs,token") || typeof ticket.expiresAtMs !== "number" || !Number.isSafeInteger(ticket.expiresAtMs) || ticket.expiresAtMs <= Date.now()) throw new Error("Invalid ticket.");
          parseLiveTicketToken(ticket.token);
          const token = ticket.token as string;
          if (!current(held)) return;
          const url = new URL("/api/live", origin); url.protocol = "wss:"; url.searchParams.set("session", bootstrap.discriminator);
          await attach(held, openSocket(url.href, ["dohc-live-v1", `dohc-live-ticket.${token}`]));
        } catch (error) {
          fail(held, error instanceof Refused ? (provider.state().pendingUpdates ? "quarantined" : "refused") : "disconnected",
            error instanceof Refused ? "account-changed" : error instanceof Unavailable ? "authority-unavailable" : "connection-failed");
        }
      },
      disconnect() {
        if (closed || ["quarantined", "refused"].includes(state().status)) return;
        override = { status: "disconnected", reason: "paused" }; stop(); notify();
      },
      close() {
        if (closed) return;
        closed = true; override = { status: "closed", reason: null }; stop(); provider.close(); unsubscribe(); notify(); listeners.clear();
      },
    };
  }
  return {
    select(selection: NamedLiveSelection) { selected?.close(); selected = session(selection); return selected; },
    close() { selected?.close(); selected = undefined; },
  };
}
