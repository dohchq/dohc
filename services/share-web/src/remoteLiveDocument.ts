import {
  createNamedLiveProvider,
  type NamedLiveProviderState,
} from "@dohc/ydoc-projection/named-live-provider";
import { yDocToMarkdown } from "@dohc/ydoc-projection";
import type { NamedLiveBrowserLimits } from "@dohc/ydoc-projection/named-live-browser-transport";
import type { LinkLiveAgentAccess } from "./linkLiveClient";
import type { PersonalLiveClient } from "./personalLiveClient";
import { replaceLiveText } from "./liveTextEdit";
import {
  LIVE_UPDATE_REFUSAL_VALUES,
  parseLiveUpdateIdentifier,
} from "@dohc/live-session-contract/live-update-admission";
import {
  LIVE_CONNECTION_LIMIT_CLOSE_CODE,
  liveConnectionLimitMessage,
} from "@dohc/live-session-contract/live-connection";
import { parseLiveTicketToken } from "@dohc/live-session-contract/live-ticket";
import type { LiveAuthorContext } from "@dohc/live-session-contract/live-authorship";
import { readBoundedJson } from "@dohc/service-http";
import { asRecord } from "@dohc/workspace-core/records";
import { LINK_REFUSALS, parseLinkRefusal } from "@dohc/security-contract/link-refusal";

export const LIVE_DOCUMENT_PREPARING = "The document is still starting. Try again shortly.";
/** The WebSocket close that says to try again later. */
const TRY_AGAIN_LATER_CLOSE_CODE = 1013;

/** A personal agent's live access to one workspace, and its MCP's code and words for a relay refusal. */
export interface PersonalLiveDocumentAccess {
  client: PersonalLiveClient;
  workspaceId: string;
  refused(response: Response, signal: AbortSignal): Promise<{ code: string; error: string }>;
  /** The MCP's code and words for a socket the relay closed as try again later, when it knows the reason. */
  tryAgainLater(reason: string): { code: string; error: string } | undefined;
}

/** A refusal before any edit, with the code the agent acts on. */
class LiveDocumentRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function refusalError(response: Response, signal: AbortSignal): Promise<Error> {
  try {
    const code = parseLinkRefusal(await readBoundedJson(response, 4096, signal), response.status);
    return new Error(code ? LINK_REFUSALS[code].error : "not found");
  } catch {
    return new Error("not found");
  } finally {
    await response.body?.cancel().catch(() => {});
  }
}

type Provider = ReturnType<typeof createNamedLiveProvider>;
function waitFor(
  provider: Provider,
  predicate: (state: NamedLiveProviderState) => boolean,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const finish = (error?: Error) => {
      unsubscribe();
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(new Error("The live document request timed out or was cancelled."));
    const check = (state: NamedLiveProviderState) => {
      if (signal.aborted) abort();
      else if (["quarantined", "disconnected", "closed"].includes(state.status))
        finish(new Error(state.reason ?? "Live document is unavailable."));
      else if (predicate(state)) finish();
    };
    unsubscribe = provider.subscribe(check);
    signal.addEventListener("abort", abort, { once: true });
    check(provider.state());
  });
}

/** A ticket for one document, the context its edits record, and how to open its socket. */
type LiveTicket = {
  objectId: string;
  workspaceId?: string;
  token: string;
  context?: LiveAuthorContext;
  open: LinkLiveAgentAccess["open"];
  tryAgainLater?: PersonalLiveDocumentAccess["tryAgainLater"];
};

async function ticketValue(
  response: Response,
  keys: string,
  maxBytes: number,
  signal: AbortSignal,
  invalid: string,
): Promise<Record<string, unknown>> {
  const value = asRecord(await readBoundedJson(response, maxBytes, signal));
  if (!value || Object.keys(value).sort().join() !== keys) throw new Error(invalid);
  parseLiveTicketToken(value.token);
  if (
    typeof value.expiresAtMs !== "number" ||
    !Number.isSafeInteger(value.expiresAtMs) ||
    value.expiresAtMs <= Date.now()
  )
    throw new Error(invalid);
  return value;
}

// A link agent's edits record the public principal its ticket names.
async function linkTicket(
  live: LinkLiveAgentAccess,
  path: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<LiveTicket> {
  const document = await live.document(path, signal);
  if (!document.ok) throw await refusalError(document, signal);
  const { objectId } = (await document.json()) as { objectId: string };
  const ticket = await live.ticket(objectId, signal);
  if (!ticket.ok) throw await refusalError(ticket, signal);
  const value = await ticketValue(
    ticket,
    "expiresAtMs,publicPrincipalId,token",
    maxBytes,
    signal,
    "Invalid link ticket.",
  );
  return {
    objectId,
    token: value.token as string,
    context: {
      kind: "link",
      publicPrincipalId: parseLiveUpdateIdentifier(value.publicPrincipalId),
    },
    open: (token, openSignal, receive) => live.open(token, openSignal, receive),
  };
}

// A personal agent's open holds until the document is ready, so nothing here
// polls. Its edits declare no context: the relay records the agent from its own tables.
async function personalTicket(
  live: PersonalLiveDocumentAccess,
  path: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<LiveTicket> {
  const { client, workspaceId } = live;
  const refusal = async (response: Response) => {
    const { code, error } = await live.refused(response, signal);
    return new LiveDocumentRefusal(code, error);
  };
  const document = await client.document(workspaceId, path, signal);
  if (document.status === 202) {
    await document.body?.cancel().catch(() => {});
    throw new LiveDocumentRefusal("preparing", LIVE_DOCUMENT_PREPARING);
  }
  if (document.status !== 200) throw await refusal(document);
  const ready = asRecord(await readBoundedJson(document, 64 * 1024, signal));
  if (ready?.status !== "ready") throw new Error("Live document is unavailable.");
  const objectId = parseLiveUpdateIdentifier(ready.objectId);
  const ticket = await client.ticket(workspaceId, objectId, signal);
  if (!ticket.ok) throw await refusal(ticket);
  const value = await ticketValue(
    ticket,
    "expiresAtMs,token",
    maxBytes,
    signal,
    "Invalid live ticket.",
  );
  return {
    objectId,
    workspaceId,
    token: value.token as string,
    open: (token, openSignal, receive) => client.open(workspaceId, token, openSignal, receive),
    tryAgainLater: live.tryAgainLater,
  };
}

export async function remoteLiveDocument(
  options: {
    live: LinkLiveAgentAccess | PersonalLiveDocumentAccess;
    limits: NamedLiveBrowserLimits;
    signal: AbortSignal;
  },
  path: string,
  edit?: { find: string; replacement: string },
) {
  const lifetime = new AbortController();
  const signal = AbortSignal.any([options.signal, lifetime.signal, AbortSignal.timeout(30_000)]);
  let provider: Provider | undefined;
  let route: ReturnType<Provider["connect"]> | undefined;
  let changed = false;
  // The relay closed the socket for a reason the agent can act on: a full connection limit, or try again later.
  let closedFor: LiveDocumentRefusal | undefined,
    closed: Promise<void> | undefined,
    open = () => false;
  try {
    const maxBytes = options.limits.maxHttpResponseBytes;
    const ticket =
      "client" in options.live
        ? await personalTicket(options.live, path, maxBytes, signal)
        : await linkTicket(options.live, path, maxBytes, signal);
    const frames = options.limits.provider.frames;
    const host = await ticket.open(ticket.token, signal, {
      maxPayload: frames.receive.maxFrameBytes,
      maxFragments: 64,
      maxBufferedChunks: 64,
      closeTimeout: options.limits.sendTimeoutMs,
      perMessageDeflate: false,
      autoPong: false,
    });
    if (!host) throw new Error("The live document host is unavailable.");
    provider = createNamedLiveProvider(
      options.limits.provider,
      {
        objectId: ticket.objectId,
        ...(ticket.workspaceId === undefined ? {} : { workspaceId: ticket.workspaceId }),
      },
      ticket.context,
    );
    const current = provider;
    route = provider.connect({
      send(bytes) {
        return new Promise((resolve, reject) => {
          if (host.socket.bufferedAmount + bytes.length > options.limits.maxSocketBufferedBytes) {
            reject(new Error("Socket buffer limit reached."));
            return;
          }
          host.socket.send(bytes, { binary: true }, (error) => (error ? reject(error) : resolve()));
        });
      },
      close() {
        host.socket.terminate();
      },
    });
    host.socket.on("message", (bytes, binary) => {
      if (!binary || !(bytes instanceof Buffer)) {
        route!.disconnect();
        return;
      }
      void route!.receive(bytes);
    });
    closed = new Promise((resolve) =>
      host.socket.once("close", (code, reason) => {
        const words = reason.toString();
        const limit =
          code === LIVE_CONNECTION_LIMIT_CLOSE_CODE ? liveConnectionLimitMessage(words) : undefined;
        const later =
          code === TRY_AGAIN_LATER_CLOSE_CODE ? ticket.tryAgainLater?.(words) : undefined;
        if (limit) closedFor = new LiveDocumentRefusal(words, limit);
        else if (later) closedFor = new LiveDocumentRefusal(later.code, later.error);
        route!.disconnect();
        resolve();
      }),
    );
    open = () => host.socket.readyState === host.socket.OPEN;
    host.invalidated.addEventListener("abort", () => route!.disconnect(), { once: true });
    if (host.invalidated.aborted) route.disconnect();
    host.socket.resume();
    await waitFor(current, (state) => state.status === "live", signal);
    if (edit) {
      replaceLiveText(current.body, edit.find, edit.replacement);
      if (current.state().pendingUpdates === 0 && current.state().status !== "live")
        throw new Error(
          current.state().reason ?? "The provider refused the edit before sending it.",
        );
      changed = true;
      await waitFor(
        current,
        (state) => state.pendingUpdates === 0 && state.lastApplied !== null,
        signal,
      );
      return {
        ok: true,
        path,
        source: "live",
        outcome: "applied",
        acknowledgement: current.state().lastApplied,
      };
    }
    return { ok: true, path, markdown: yDocToMarkdown(current.doc), source: "live" };
  } catch (error) {
    const state = provider?.state();
    const refused =
      state?.status === "quarantined" &&
      LIVE_UPDATE_REFUSAL_VALUES.some((reason) => reason === state.reason);
    const unknown = changed && !refused;
    // The provider can fail on a closing socket before its close arrives, so a closing socket's reason is read first.
    // The provider's terminate and the call's deadline bound the wait.
    if (closed && !changed && !(error instanceof LiveDocumentRefusal) && !open() && !signal.aborted)
      await Promise.race([
        closed,
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
      ]);
    const refusal = error instanceof LiveDocumentRefusal ? error : changed ? undefined : closedFor,
      failure = refusal ?? error;
    return {
      ok: false,
      path,
      outcome: unknown ? "unknown" : "not-applied",
      ...(refusal ? { code: refusal.code } : {}),
      error: unknown
        ? "The edit outcome is unknown. Read the live document before retrying."
        : failure instanceof Error
          ? failure.message
          : "Live document is unavailable.",
    };
  } finally {
    lifetime.abort();
    provider?.close();
    await route?.settled();
    provider?.doc.destroy();
  }
}
