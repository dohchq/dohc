import {parseLiveUpdateIdentifier} from "@dohc/live-session-contract/live-update-admission";
import {parseLiveTicketToken} from "@dohc/live-session-contract/live-ticket";
import {createNamedLiveBrowserTransport, parseNamedLiveBrowserLimits} from "@dohc/ydoc-projection/named-live-browser-transport";
import {namedRequest} from "./namedRecipient";

const exact = (value: unknown, keys: string): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join() === keys;

/** The discriminator selects a protected cookie; it never grants access by itself. */
export async function openLinkDocument(discriminator: string, path: string, signal: AbortSignal) {
  if (!/^[A-Za-z0-9_-]{12}$/.test(discriminator) || !/\.md$/i.test(path) || path.length > 1024) throw Error("Invalid file");
  const metadata = await namedRequest("/api/live/link-document", signal, {discriminator, path});
  signal.throwIfAborted();
  if (!exact(metadata, "limits,objectId")) throw Error("Invalid file");
  const objectId = parseLiveUpdateIdentifier(metadata.objectId), limits = parseNamedLiveBrowserLimits(metadata.limits);
  const transport = createNamedLiveBrowserTransport<{objectId: string}>({publicOrigin: location.origin, limits,
    async authorize(selection, attemptSignal) {
      const ticket = await namedRequest("/api/live/link-ticket", attemptSignal, {discriminator, objectId: selection.objectId});
      attemptSignal.throwIfAborted();
      if (!exact(ticket, "expiresAtMs,token") || typeof ticket.expiresAtMs !== "number" ||
        !Number.isSafeInteger(ticket.expiresAtMs) || ticket.expiresAtMs <= Date.now()) throw Error("Invalid ticket");
      parseLiveTicketToken(ticket.token);
      const ticketToken = ticket.token as string;
      const url = new URL("/api/live/link", location.origin); url.protocol = "wss:"; url.searchParams.set("session", discriminator);
      return {ticketToken, discriminator, websocketUrl: url.href};
    },
  });
  return transport.select({objectId});
}
