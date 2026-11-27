import {
  LIVE_CONNECTION_LIMIT_CLOSE_CODE,
  liveConnectionLimitMessage,
  NOTE_FORMAT_OFF,
  TRY_AGAIN_LATER_CLOSE_CODE,
} from "@dohc/live-session-contract/live-connection";
import { parseLiveUpdateIdentifier } from "@dohc/live-session-contract/live-update-admission";
import { parseLiveTicketToken } from "@dohc/live-session-contract/live-ticket";
import type { LiveAuthorContext } from "@dohc/live-session-contract";
import { isNamedLiveStopped, parseLinkRefusal } from "@dohc/security-contract/link-refusal";
import {
  createNamedLiveProvider,
  LINEAGE_REPLACED,
  type NamedLiveProviderState,
} from "@dohc/ydoc-projection/named-live-provider";
import type { RemovedText } from "@dohc/ydoc-projection/removed-text";
import {
  parseNamedLiveBrowserLimits,
  type NamedLiveBrowserLimits,
} from "@dohc/ydoc-projection/named-live-browser-limits";

export { parseNamedLiveBrowserLimits, type NamedLiveBrowserLimits };

/** Account ID is a stale-selection guard, never an authentication credential. */
export interface NamedLiveSelection {
  accountId: string;
  /** Public named:<grantId> binding, never the source workspace ID. */
  workspaceId: string;
  grantId: string;
  objectId: string;
}
export interface NamedLiveBrowserState extends Omit<NamedLiveProviderState, "status"> {
  status: NamedLiveProviderState["status"] | "authorizing" | "refused";
  /** An attempt to open stopped before the page was live, so typing on the early state waits for live. */
  typingStopped: boolean;
}
/** A page disconnected for one of these reasons doesn't reconnect by itself. */
export const NAMED_LIVE_NO_AUTOMATIC_RETRY: readonly string[] = [
  "authority-unavailable",
  "access-removed",
  "link-full",
  "paused",
  "live-stopped",
  "document-gone",
  "note-format-off",
];
/** How often a page whose note is off checks, while it is visible, whether its owner started it again. */
export const NAMED_LIVE_OFF_CHECK_MS = 30_000;
/**
 * Whether the page takes edits: live, holding the host's early state while it first opens, or reconnecting by
 * itself after it was live. The edits wait in the page until it is live again. A page whose first opening stopped
 * takes none until it is live, so no more words wait on attempts that may never succeed.
 */
export function namedLiveEditable(state: NamedLiveBrowserState): boolean {
  if (state.status === "live") return true;
  if (!state.typingAhead || state.typingStopped) return false;
  return state.status === "disconnected"
    ? !NAMED_LIVE_NO_AUTOMATIC_RETRY.includes(state.reason ?? "")
    : ["authorizing", "connecting", "syncing"].includes(state.status);
}
type BrowserSocket = Pick<
  WebSocket,
  | "readyState"
  | "bufferedAmount"
  | "protocol"
  | "extensions"
  | "binaryType"
  | "send"
  | "close"
  | "addEventListener"
  | "removeEventListener"
>;
export interface LiveSelection {
  objectId: string;
  workspaceId?: string;
}
interface Options<Selection extends LiveSelection> {
  recordingContext?(selection: Selection): LiveAuthorContext;
  authorize?(
    selection: Selection,
    signal: AbortSignal,
    /** The owner's socket names its page in the URL and has no browser session. */
  ): Promise<{ ticketToken: string; discriminator?: string; websocketUrl: string }>;
  publicOrigin: string;
  limits: NamedLiveBrowserLimits;
  fetch?: typeof fetch;
  openSocket?: (url: string, protocols: string[]) => BrowserSocket;
  /** Reopen on a fresh document when the relay replaces the note's lineage. The caller must follow `doc`. */
  reopenOnLineage?: boolean;
}
type Provider = ReturnType<typeof createNamedLiveProvider>;
type Route = ReturnType<Provider["connect"]>;
type Override = Pick<NamedLiveBrowserState, "status" | "reason">;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: unknown, keys: string): value is Record<string, unknown> =>
  record(value) && Object.keys(value).sort().join(",") === keys;
class Refused extends Error {}
/** The server answered and would not authorize this document. The connection works. */
export class LiveAuthorityUnavailableError extends Error {}
/** The server answered that it cannot start editing now. The page tries again by itself. */
export class LiveHostUnavailableError extends Error {}
/** The server answered that live editing of the document stopped until its owner starts it again. */
export class LiveStoppedError extends Error {}
/** The server answered that live editing of the document is starting. The page tries again by itself. */
export class LiveStartingError extends Error {}
/** The server answered that the link can take no more people. Trying again cannot help. */
export class LiveLinkFullError extends Error {}
/** The server answered that its operator turned off the note format the document uses. Trying again cannot help. */
export class LiveNoteFormatOffError extends Error {}
/** The server answered that the owner removed this account's access. */
class AccessRemoved extends Error {}
/** The page has no session and has already asked for a new one in this outage. */
class SessionSpent extends Error {}
// A session or ticket request answers a restarting or busy server the same way as lost access,
// to everyone. After the file was last open, the page keeps trying through such an answer for
// this long, unless the invitation itself says the access ended. Then it stops, so a page that
// can never open doesn't keep asking the server.
const PASSING_REFUSAL_MS = 5 * 60_000;

/** One current selection. Retired handles retain only their in-memory draft for caller-owned recovery. */
export function createNamedLiveBrowserTransport<
  Selection extends LiveSelection = NamedLiveSelection,
>(options: Options<Selection>) {
  const origin = new URL(options.publicOrigin),
    limits = parseNamedLiveBrowserLimits(options.limits);
  if (origin.protocol !== "https:" || origin.origin !== options.publicOrigin)
    throw new TypeError("Named editing requires an HTTPS origin.");
  const request = options.fetch ?? globalThis.fetch.bind(globalThis);
  const openSocket = options.openSocket ?? ((url, protocols) => new WebSocket(url, protocols));
  let selected: ReturnType<typeof session> | undefined;

  function session(selection: Selection) {
    const target = { ...selection };
    for (const value of Object.values(target)) parseLiveUpdateIdentifier(value);
    const recordingContext = options.recordingContext;
    const removedListeners = new Set<(removed: RemovedText) => void>();
    const createProvider = (initial?: Parameters<typeof createNamedLiveProvider>[3]) => {
      const created = createNamedLiveProvider(
        limits.provider,
        target,
        recordingContext ? () => recordingContext(target) : undefined,
        initial,
      );
      created.onRemovedText((removed) => {
        for (const listener of removedListeners) {
          try {
            listener(removed);
          } catch {
            /* A view listener cannot change delivery ownership. */
          }
        }
      });
      return created;
    };
    const first = createProvider();
    let provider = first;
    const listeners = new Set<(state: NamedLiveBrowserState) => void>();
    let override: Override | undefined,
      closed = false,
      retiring = Promise.resolve();
    type Attempt = {
      controller: AbortController;
      route?: Route;
      socket?: BrowserSocket;
      timer?: ReturnType<typeof setTimeout>;
      removeListeners?: () => void;
      writes: Set<Promise<void>>;
      /** Set while the attempt reads the invitation again after a refusal. */
      refused?: boolean;
      /** Set when the attempt uses the session an earlier attempt received. */
      kept?: boolean;
      /** Set while an attempt with no session left reads the invitation, so its deadline stops retries. */
      spent?: boolean;
      /** Set once the attempt asks for its ticket, which waits on the live host. */
      admitting?: boolean;
    };
    let attempt: Attempt | undefined;
    let automatic = false,
      reconnectDelayMs = 250,
      accessStoodAt: number | undefined,
      wasLive = false;
    // Once an attempt has stopped before the page was live, typing on the early state waits for live. A retry that
    // took typing again would show the editor for each attempt and let words join a draft that may never be sent.
    let attempted = false,
      typingStopped = false,
      everLive = false,
      waitingForResume = false;
    // Automatic retries keep the page's session. A refusal of it may mean the server lost it, so
    // the page asks for a new one on its own once in an outage, and again only in an outage that
    // began PASSING_REFUSAL_MS after that request. Each request counts when it is sent.
    let kept: { discriminator: string; expiresAtMs: number } | undefined,
      fresh = false,
      replacedAt: number | undefined;
    const mayReplace = () =>
      replacedAt === undefined ||
      (accessStoodAt !== undefined && accessStoodAt - replacedAt >= PASSING_REFUSAL_MS);
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    function scheduleReconnect() {
      const value = state(),
        off = value.reason === "live-stopped";
      if (
        !automatic ||
        closed ||
        reconnectTimer !== undefined ||
        value.status !== "disconnected" ||
        (!off && NAMED_LIVE_NO_AUTOMATIC_RETRY.includes(value.reason ?? ""))
      )
        return;
      if (off) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = undefined;
          if (globalThis.document?.visibilityState === "hidden") scheduleReconnect();
          else void connect();
        }, NAMED_LIVE_OFF_CHECK_MS);
        return;
      }
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        // A server that restarts is back within seconds. For a minute after the page was last live it waits
        // at most two seconds between failed attempts, so it is live again soon after the server is.
        const longestMs =
          accessStoodAt !== undefined && Date.now() - accessStoodAt < 60_000 ? 2_000 : 10_000;
        reconnectDelayMs = Math.min(longestMs, reconnectDelayMs * 2);
        void connect();
      }, reconnectDelayMs);
    }
    const state = (): NamedLiveBrowserState => ({
      ...provider.state(),
      ...override,
      typingStopped,
    });
    const notify = () => {
      if (attempted && !everLive && { ...provider.state(), ...override }.status === "disconnected")
        typingStopped = true;
      for (const listener of listeners) {
        try {
          listener(state());
        } catch {
          /* Observer owns its failure. */
        }
      }
    };
    const current = (held: Attempt) =>
      attempt === held && !held.controller.signal.aborted && !closed;
    function stop() {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      const previous = attempt;
      attempt = undefined;
      if (!previous) return;
      clearTimeout(previous.timer);
      previous.controller.abort();
      previous.removeListeners?.();
      previous.route?.disconnect();
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      try {
        previous.socket?.close();
      } catch {
        /* The attempt is already retired. */
      }
      const prior = retiring;
      retiring = Promise.allSettled([prior, previous.route?.settled(), ...previous.writes]).then(
        () => undefined,
      );
    }
    function fail(held: Attempt, status: Override["status"], reason: string) {
      if (!current(held)) return;
      if (state().status === "live") accessStoodAt = Date.now();
      if (reason === "live-stopped") {
        waitingForResume = true;
        typingStopped = true;
      } else if (reason === "live-starting" || NAMED_LIVE_NO_AUTOMATIC_RETRY.includes(reason))
        waitingForResume = false;
      else if (waitingForResume) reason = "live-stopped";
      override = { status, reason };
      stop();
      notify();
      scheduleReconnect();
    }
    const reopenOnLineage = (value: NamedLiveProviderState) => {
      const replaced = provider;
      const successor = replaced.replacement();
      if (
        !options.reopenOnLineage ||
        !successor ||
        closed ||
        value.status !== "quarantined" ||
        value.reason !== LINEAGE_REPLACED ||
        value.pendingUpdates > 0 ||
        replaced.unsentText() !== null
      )
        return false;
      unsubscribe();
      provider = createProvider(successor);
      unsubscribe = provider.subscribe(follow);
      replaced.close();
      void connect();
      return true;
    };
    const follow = (value: NamedLiveProviderState) => {
      if (reopenOnLineage(value)) return;
      if (value.status === "live") {
        everLive = true;
        typingStopped = false;
        waitingForResume = false;
        clearTimeout(attempt?.timer);
        reconnectDelayMs = 250;
        accessStoodAt = Date.now();
      } else if (wasLive) accessStoodAt = Date.now();
      wasLive = value.status === "live";
      notify();
      scheduleReconnect();
    };
    let unsubscribe = provider.subscribe(follow);
    async function json(held: Attempt, path: string, body?: unknown): Promise<unknown> {
      const signal = held.controller.signal;
      let response: Response | undefined;
      const work = (async () => {
        try {
          response = await request(new URL(path, origin), {
            method: body === undefined ? "GET" : "POST",
            credentials: "same-origin",
            cache: "no-store",
            redirect: "error",
            signal,
            headers: {
              accept: "application/json",
              ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
          signal.throwIfAborted();
          if ([401, 403].includes(response.status)) throw new LiveAuthorityUnavailableError();
          const refused = response.status === 404,
            starting = response.status === 503;
          if (
            (response.status !== 200 && !refused && !starting) ||
            response.redirected ||
            !response.body ||
            response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
              "application/json"
          )
            throw refused ? new LiveAuthorityUnavailableError() : new Error("Invalid response.");
          const reader = response.body.getReader(),
            decoder = new TextDecoder("utf-8", { fatal: true });
          let bytes = 0,
            text = "";
          const abort = () => {
            void reader.cancel().catch(() => {});
          };
          signal.addEventListener("abort", abort, { once: true });
          try {
            while (true) {
              signal.throwIfAborted();
              const chunk = await reader.read();
              signal.throwIfAborted();
              if (chunk.done) break;
              if (chunk.value.length > limits.maxHttpResponseBytes - bytes)
                throw new Error("Response limit.");
              bytes += chunk.value.length;
              text += decoder.decode(chunk.value, { stream: true });
            }
            const value = JSON.parse(text + decoder.decode()) as unknown;
            if (starting)
              throw parseLinkRefusal(value, response.status) === "link_live_starting"
                ? new LiveStartingError()
                : new Error("Invalid response.");
            if (refused)
              throw record(value) && value.code === "share_access_removed"
                ? new AccessRemoved()
                : isNamedLiveStopped(value, response.status)
                  ? new LiveStoppedError()
                  : new LiveAuthorityUnavailableError();
            return value;
          } catch (error) {
            throw refused && !(error instanceof AccessRemoved || error instanceof LiveStoppedError)
              ? new LiveAuthorityUnavailableError()
              : error;
          } finally {
            signal.removeEventListener("abort", abort);
            await reader.cancel().catch(() => {});
            reader.releaseLock();
          }
        } finally {
          await response?.body?.cancel().catch(() => {});
        }
      })();
      let abort!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error("Attempt retired."));
        signal.addEventListener("abort", abort, { once: true });
      });
      if (signal.aborted) abort();
      try {
        return await Promise.race([work, cancelled]);
      } finally {
        signal.removeEventListener("abort", abort);
      }
    }
    function attach(held: Attempt, socket: BrowserSocket): Promise<void> {
      held.socket = socket;
      socket.binaryType = "arraybuffer";
      return new Promise<void>((resolve, reject) => {
        let opened = false;
        const abort = () => reject(new Error("Attempt retired."));
        const finish = () => {
          held.controller.signal.removeEventListener("abort", abort);
        };
        const onClose = (event: CloseEvent) => {
          const reason =
            event.code === LIVE_CONNECTION_LIMIT_CLOSE_CODE &&
            liveConnectionLimitMessage(event.reason)
              ? event.reason
              : event.code === TRY_AGAIN_LATER_CLOSE_CODE && event.reason === NOTE_FORMAT_OFF
                ? "note-format-off"
                : undefined;
          if (reason) {
            fail(held, "disconnected", reason);
            finish();
            reject(new Error(event.reason));
          } else disconnected();
        };
        const disconnected = () => {
          fail(held, "disconnected", "transport-closed");
          finish();
          reject(new Error("Socket closed."));
        };
        function send(bytes: Uint8Array): Promise<void> {
          const work = new Promise<void>((sent, failed) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const deadline = performance.now() + limits.sendTimeoutMs;
            const cancel = () => {
              clearTimeout(timer);
              held.controller.signal.removeEventListener("abort", cancel);
              failed(new Error("Send retired."));
            };
            held.controller.signal.addEventListener("abort", cancel, { once: true });
            const pump = () => {
              if (!current(held) || socket.readyState !== 1) {
                cancel();
                return;
              }
              if (socket.bufferedAmount > limits.maxSocketBufferedBytes - bytes.byteLength) {
                if (performance.now() >= deadline) {
                  cancel();
                  fail(held, "disconnected", "send-timeout");
                  return;
                }
                timer = setTimeout(
                  pump,
                  Math.min(limits.drainPollMs, Math.max(0, deadline - performance.now())),
                );
                return;
              }
              held.controller.signal.removeEventListener("abort", cancel);
              try {
                socket.send(bytes as Uint8Array<ArrayBuffer>);
                sent();
              } catch (error) {
                failed(error);
              }
            };
            pump();
          });
          held.writes.add(work);
          void work.then(
            () => held.writes.delete(work),
            () => held.writes.delete(work),
          );
          return work;
        }
        const onOpen = () => {
          if (!current(held) || opened) return;
          if (socket.protocol !== "dohc-live-v1" || socket.extensions) {
            fail(held, "quarantined", "invalid-socket-protocol");
            return;
          }
          opened = true;
          try {
            override = undefined;
            held.route = provider.connect({
              send,
              close() {
                stop();
              },
            });
            finish();
            resolve();
          } catch {
            disconnected();
          }
        };
        const onMessage = (event: MessageEvent) => {
          if (!current(held)) return;
          if (!opened || !held.route || !(event.data instanceof ArrayBuffer)) {
            fail(held, "quarantined", "invalid-socket-message");
            return;
          }
          void held.route.receive(new Uint8Array(event.data));
        };
        socket.addEventListener("open", onOpen);
        socket.addEventListener("message", onMessage);
        socket.addEventListener("error", disconnected);
        socket.addEventListener("close", onClose);
        held.controller.signal.addEventListener("abort", abort, { once: true });
        held.removeListeners = () => {
          socket.removeEventListener("open", onOpen);
          socket.removeEventListener("message", onMessage);
          socket.removeEventListener("error", disconnected);
          socket.removeEventListener("close", onClose);
          finish();
        };
      });
    }
    /** Reads the invitation again after a refusal that a passing server state also gives. */
    async function recheck(held: Attempt, grantId: string, checking: boolean): Promise<string> {
      held.refused = true;
      try {
        const listing = await json(held, "/api/live/named-documents", { grantId });
        if (
          !record(listing) ||
          listing.access !== "edit" ||
          listing.grantId !== grantId ||
          !Array.isArray(listing.files)
        )
          return "authority-unavailable";
        if (!listing.files.some((file) => record(file) && file.objectId === target.objectId))
          return "document-gone";
      } catch (error) {
        if (error instanceof AccessRemoved) return "access-removed";
      }
      if (!checking) return passingRefusal();
      kept = undefined;
      return "live-stopped";
    }
    /** Whether the invitation says the owner removed this account's access. */
    async function accessRemoved(held: Attempt, grantId: string): Promise<boolean> {
      held.spent = true;
      try {
        await json(held, "/api/live/named-documents", { grantId });
        return false;
      } catch (error) {
        return error instanceof AccessRemoved;
      }
    }
    const passingRefusal = () =>
      accessStoodAt !== undefined && Date.now() - accessStoodAt < PASSING_REFUSAL_MS
        ? "host-unavailable"
        : "authority-unavailable";
    /** The first open and Try again start with a new session. */
    function reconnect(): Promise<void> {
      kept = replacedAt = undefined;
      fresh = true;
      return connect();
    }
    async function connect(): Promise<void> {
      if (closed || ["quarantined", "refused"].includes(state().status)) return;
      automatic = true;
      attempted = true;
      const reason = state().reason,
        checking = reason === "live-stopped";
      stop();
      const held: Attempt = { controller: new AbortController(), writes: new Set() };
      attempt = held;
      if (!checking && reason !== "live-starting")
        override = { status: "authorizing", reason: null };
      notify();
      held.timer = setTimeout(
        // A busy live host holds the ticket and the socket's upgrade until it has woken the file, so an
        // attempt stalled there reads as the server's, not the connection's.
        () =>
          fail(
            held,
            "disconnected",
            held.spent
              ? "authority-unavailable"
              : held.refused
                ? checking
                  ? "live-stopped"
                  : passingRefusal()
                : !held.route && (held.socket || held.admitting)
                  ? "host-unavailable"
                  : "connect-timeout",
          ),
        limits.connectTimeoutMs,
      );
      try {
        await retiring;
        if (!current(held)) return;
        let admitted: { discriminator?: string; ticketToken: string; websocketUrl: string };
        if (options.authorize) {
          held.admitting = true;
          admitted = await options.authorize(target, held.controller.signal);
        } else {
          if (!("accountId" in target) || !("grantId" in target))
            throw new Error("Named account selection required.");
          const account = await json(held, "/api/account/session");
          // A retired attempt must not spend the session request of the attempt that replaced it.
          if (!current(held)) return;
          if (!exact(account, "user")) throw new Error("Invalid account response.");
          if (account.user === null) throw new Refused();
          if (!exact(account.user, "id,name") || typeof account.user.name !== "string")
            throw new Error("Invalid account response.");
          if (account.user.id !== target.accountId) throw new Refused();
          if (kept && kept.expiresAtMs > Date.now()) held.kept = true;
          else {
            kept = undefined;
            if (!fresh && !checking) {
              // Without a session, no retry in this outage can open the file.
              if (!mayReplace()) throw new SessionSpent();
              replacedAt = Date.now();
            }
            fresh = false;
            const bootstrap = await json(held, "/api/live/named-session", {
              grantId: target.grantId,
            });
            if (
              !exact(bootstrap, "discriminator,expiresAtMs") ||
              typeof bootstrap.discriminator !== "string" ||
              !/^[A-Za-z0-9_-]{12}$/.test(bootstrap.discriminator) ||
              typeof bootstrap.expiresAtMs !== "number" ||
              !Number.isSafeInteger(bootstrap.expiresAtMs) ||
              bootstrap.expiresAtMs <= Date.now()
            )
              throw new Error("Invalid session.");
            if (!current(held)) return;
            kept = { discriminator: bootstrap.discriminator, expiresAtMs: bootstrap.expiresAtMs };
          }
          const session = kept;
          held.admitting = true;
          const ticket = await json(held, "/api/live/named-ticket", {
            discriminator: session.discriminator,
            objectId: target.objectId,
          });
          if (
            !exact(ticket, "expiresAtMs,token") ||
            typeof ticket.expiresAtMs !== "number" ||
            !Number.isSafeInteger(ticket.expiresAtMs) ||
            ticket.expiresAtMs <= Date.now()
          )
            throw new Error("Invalid ticket.");
          const namedUrl = new URL("/api/live", origin);
          namedUrl.protocol = "wss:";
          namedUrl.searchParams.set("session", session.discriminator);
          admitted = {
            discriminator: session.discriminator,
            ticketToken: ticket.token as string,
            websocketUrl: namedUrl.href,
          };
        }
        if (
          admitted.discriminator !== undefined &&
          !/^[A-Za-z0-9_-]{12}$/.test(admitted.discriminator)
        )
          throw new Error("Invalid admission.");
        parseLiveTicketToken(admitted.ticketToken);
        const token = admitted.ticketToken;
        if (!current(held)) return;
        const url = new URL(admitted.websocketUrl);
        if (
          url.protocol !== "wss:" ||
          url.host !== origin.host ||
          url.username ||
          url.password ||
          url.hash ||
          url.searchParams.get("session") !== (admitted.discriminator ?? null)
        )
          throw new Error("Invalid live route.");
        await attach(held, openSocket(url.href, ["dohc-live-v1", `dohc-live-ticket.${token}`]));
      } catch (error) {
        if (
          held.kept &&
          error instanceof LiveAuthorityUnavailableError &&
          current(held) &&
          mayReplace()
        )
          kept = undefined;
        fail(
          held,
          error instanceof Refused
            ? provider.state().pendingUpdates
              ? "quarantined"
              : "refused"
            : "disconnected",
          error instanceof Refused
            ? "account-changed"
            : error instanceof AccessRemoved
              ? "access-removed"
              : error instanceof LiveLinkFullError
                ? "link-full"
                : error instanceof LiveNoteFormatOffError
                  ? "note-format-off"
                  : error instanceof SessionSpent
                    ? "grantId" in target && (await accessRemoved(held, String(target.grantId)))
                      ? "access-removed"
                      : "authority-unavailable"
                    : error instanceof LiveAuthorityUnavailableError
                      ? !options.authorize && "grantId" in target
                        ? await recheck(held, String(target.grantId), checking)
                        : "authority-unavailable"
                      : error instanceof LiveStoppedError
                        ? "live-stopped"
                        : error instanceof LiveStartingError
                          ? "live-starting"
                          : error instanceof LiveHostUnavailableError
                            ? "host-unavailable"
                            : "connection-failed",
        );
      }
    }
    return {
      /** Stays the same for the session's life, while `doc` changes on a reopen. */
      id: first.doc.guid,
      /** Changes when the relay replaces the note's lineage and the page reopens on the new one. */
      get doc() {
        return provider.doc;
      },
      state,
      subscribe(listener: (value: NamedLiveBrowserState) => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      onRemovedText(listener: (removed: RemovedText) => void) {
        removedListeners.add(listener);
        return () => {
          removedListeners.delete(listener);
        };
      },
      unsentText: () => provider.unsentText(),
      /** Editors must use this guard before their synchronous Yjs transaction. */
      edit(change: () => void): boolean {
        if (closed || !namedLiveEditable(state())) return false;
        provider.doc.transact(change);
        return true;
      },
      seed: (bytes: Uint8Array, throughJournalCursor: number) =>
        provider === first && first.seed(bytes, throughJournalCursor),
      reconnect,
      disconnect() {
        if (closed || ["quarantined", "refused"].includes(state().status)) return;
        automatic = false;
        override = { status: "disconnected", reason: "paused" };
        stop();
        notify();
      },
      close() {
        if (closed) return;
        closed = true;
        override = { status: "closed", reason: null };
        stop();
        provider.close();
        unsubscribe();
        notify();
        listeners.clear();
        removedListeners.clear();
      },
    };
  }
  return {
    select(selection: Selection) {
      selected?.close();
      selected = session(selection);
      return selected;
    },
    close() {
      selected?.close();
      selected = undefined;
    },
  };
}
