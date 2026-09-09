import type { IncomingMessage } from "node:http";
import { parseLiveTicketAudience, parseLiveTicketToken } from "@dohc/live-session-contract/live-ticket";
import { isSessionDiscriminator } from "./sessionDiscriminator";

const VERSION_PROTOCOL = "dohc-live-v1";
const TICKET_PROTOCOL_PREFIX = "dohc-live-ticket.";

function validHost(value: string): boolean {
  if (!/^(?:[A-Za-z0-9.-]+|\[[A-Fa-f0-9:.]+\])(?::[0-9]+)?$/.test(value)) return false;
  try { return new URL(`http://${value}`).hostname.length > 0; }
  catch { return false; }
}

export function createLiveGatewayRequestParser(config: {
  publicHosts: ReadonlySet<string>;
  publicOrigin: string;
  path?: "/api/live" | "/api/live/link";
}) {
  const publicOrigin = parseLiveTicketAudience(config.publicOrigin);
  const publicHosts = new Set([...config.publicHosts].map(host => {
    if (!validHost(host)) throw new TypeError("Live gateway requires valid configured Host values.");
    return host.toLowerCase();
  }));
  if (!publicHosts.has(new URL(publicOrigin).host)) {
    throw new TypeError("Live gateway origin must use a configured Host.");
  }

  // This parses transport credentials only. The gateway must resolve the browser
  // session and redeem the ticket before treating the request as authorized.
  return (request: Pick<IncomingMessage, "rawHeaders" | "method" | "url">): {
    session: string;
    ticketToken: string;
  } | null => {
    const { rawHeaders, method, url } = request;
    if (rawHeaders.length % 2 !== 0) return null;
    const selected = new Map<string, string>();
    for (let index = 0; index < rawHeaders.length; index += 2) {
      const name = rawHeaders[index]!.toLowerCase();
      if (name !== "host" && name !== "origin" && name !== "sec-websocket-protocol") continue;
      if (selected.has(name)) return null;
      selected.set(name, rawHeaders[index + 1]!);
    }
    const host = selected.get("host");
    if (!host || !validHost(host) || !publicHosts.has(host.toLowerCase())) return null;
    if (selected.get("origin") !== publicOrigin) return null;
    const targetPrefix = `${config.path ?? "/api/live"}?session=`;
    if (method !== "GET" || !url?.startsWith(targetPrefix)) return null;
    const session = url.slice(targetPrefix.length);
    if (!isSessionDiscriminator(session)) return null;
    const protocols = selected.get("sec-websocket-protocol")?.split(",").map(value => value.replace(/^[ \t]+|[ \t]+$/g, ""));
    if (!protocols || protocols.length !== 2 || protocols.filter(value => value === VERSION_PROTOCOL).length !== 1) return null;
    const credential = protocols.find(value => value.startsWith(TICKET_PROTOCOL_PREFIX));
    if (!credential) return null;
    const ticketToken = credential.slice(TICKET_PROTOCOL_PREFIX.length);
    try { parseLiveTicketToken(ticketToken); }
    catch { return null; }
    return { session, ticketToken };
  };
}
