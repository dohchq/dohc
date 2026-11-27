import { parseLiveUpdateIdentifier } from "@dohc/live-session-contract/live-update-admission";
import { parseLiveTicketToken } from "@dohc/live-session-contract/live-ticket";
import {
  createNamedLiveBrowserTransport,
  parseNamedLiveBrowserLimits,
} from "@dohc/ydoc-projection/named-live-browser-transport";
import { fetchShareWeb } from "./apiVersion";
import { namedRequest } from "./namedRecipient";

const exact = (value: unknown, keys: string): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join() === keys;

// What the note's host applied, when it holds the note awake. Anything else is no state, and the page opens as
// before.
async function earlyState(discriminator: string, path: string, signal: AbortSignal) {
  try {
    const response = await fetchShareWeb("/api/live/link-document-state", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal,
      headers: { accept: "application/octet-stream", "content-type": "application/json" },
      body: JSON.stringify({ discriminator, path }),
    });
    const through = response.headers.get("x-dohc-live-applied-through") ?? "";
    if (
      response.status !== 200 ||
      response.redirected ||
      response.headers.get("content-type") !== "application/octet-stream" ||
      !/^\d+$/.test(through)
    ) {
      await response.body?.cancel().catch(() => {});
      return undefined;
    }
    return {
      objectId: response.headers.get("x-dohc-live-object-id"),
      through: Number(through),
      bytes: new Uint8Array(await response.arrayBuffer()),
    };
  } catch {
    return undefined;
  }
}

// The state the page fetched when it showed a note. A press uses it only while it is this young, counted from when the
// request left, so nobody types on a copy much older than the press's own fetch would give. After that the press
// fetches its own.
export const SHOWN_STATE_FRESH_MS = 3_000;
let shown:
  | {
      key: string;
      startedAt: number;
      request: AbortController;
      state: ReturnType<typeof earlyState>;
    }
  | undefined;
const shownKey = (discriminator: string, path: string) => JSON.stringify([discriminator, path]);
function dropShown() {
  shown?.request.abort();
  shown = undefined;
}

/**
 * Fetch the state of a note an Edit link can change while the page shows it, for a press soon after. The returned
 * function lets the state go, unless a press has taken it.
 */
export function showLinkDocument(discriminator: string, path: string) {
  dropShown();
  const request = new AbortController();
  const entry = {
    key: shownKey(discriminator, path),
    startedAt: Date.now(),
    request,
    state: earlyState(discriminator, path, request.signal),
  };
  shown = entry;
  return () => {
    if (shown === entry) dropShown();
  };
}

function takeShown(discriminator: string, path: string, signal: AbortSignal) {
  const taken = shown;
  // A clock set back since the request left gives no age the page can trust.
  const age = taken ? Date.now() - taken.startedAt : -1;
  if (taken?.key !== shownKey(discriminator, path) || age < 0 || age > SHOWN_STATE_FRESH_MS) {
    dropShown();
    return undefined;
  }
  shown = undefined;
  signal.addEventListener("abort", () => taken.request.abort(), { once: true });
  return taken.state;
}

/** The discriminator selects a protected cookie; it never grants access by itself. */
export async function openLinkDocument(discriminator: string, path: string, signal: AbortSignal) {
  if (!/^[A-Za-z0-9_-]{12}$/.test(discriminator) || !/\.md$/i.test(path) || path.length > 1024)
    throw Error("Invalid file");
  const state = takeShown(discriminator, path, signal) ?? earlyState(discriminator, path, signal);
  const metadata = await namedRequest("/api/live/link-document", signal, { discriminator, path });
  signal.throwIfAborted();
  if (!exact(metadata, "limits,objectId")) throw Error("Invalid file");
  const objectId = parseLiveUpdateIdentifier(metadata.objectId),
    limits = parseNamedLiveBrowserLimits(metadata.limits);
  let publicPrincipalId: string | undefined;
  const transport = createNamedLiveBrowserTransport<{ objectId: string }>({
    publicOrigin: location.origin,
    limits,
    reopenOnLineage: true,
    recordingContext() {
      if (!publicPrincipalId) throw Error("Link identity is unavailable");
      return { kind: "link", publicPrincipalId };
    },
    async authorize(selection, attemptSignal) {
      const ticket = await namedRequest("/api/live/link-ticket", attemptSignal, {
        discriminator,
        objectId: selection.objectId,
      });
      attemptSignal.throwIfAborted();
      if (
        !exact(ticket, "expiresAtMs,publicPrincipalId,token") ||
        typeof ticket.expiresAtMs !== "number" ||
        !Number.isSafeInteger(ticket.expiresAtMs) ||
        ticket.expiresAtMs <= Date.now()
      )
        throw Error("Invalid ticket");
      parseLiveTicketToken(ticket.token);
      const principal = parseLiveUpdateIdentifier(ticket.publicPrincipalId);
      if (publicPrincipalId !== undefined && publicPrincipalId !== principal)
        throw Error("Link identity changed");
      publicPrincipalId = principal;
      const ticketToken = ticket.token as string;
      const url = new URL("/api/live/link", location.origin);
      url.protocol = "wss:";
      url.searchParams.set("session", discriminator);
      return { ticketToken, discriminator, websocketUrl: url.href };
    },
  });
  const session = transport.select({ objectId });
  // The provider takes the state only before it asks the host for one, so a late answer is dropped.
  void state
    .then((value) => {
      if (value?.objectId === objectId) session.seed(value.bytes, value.through);
    })
    // An early state the page cannot apply leaves it to open as before.
    .catch(() => {});
  return session;
}
