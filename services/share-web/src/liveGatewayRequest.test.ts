import { createServer } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { createLiveGatewayRequestParser } from "./liveGatewayRequest";

const token = "ab".repeat(32);
const session = "abcdefghijkl";
const target = `/api/live?session=${session}`;
const protocol = `dohc-live-v1, dohc-live-ticket.${token}`;
const origin = "https://share.example.test";
const headers = ["Host", "share.example.test", "Origin", origin, "Sec-WebSocket-Protocol", protocol];
const parse = createLiveGatewayRequestParser({ publicHosts: new Set(["share.example.test"]), publicOrigin: origin });

function request(rawHeaders = headers, url = target, method = "GET") {
  return { rawHeaders, url, method };
}

describe("live gateway raw request validation", () => {
  it("isolates the configured public link route and snapshots its path", () => {
    const config: Parameters<typeof createLiveGatewayRequestParser>[0] = {publicHosts: new Set(["share.example.test"]), publicOrigin: origin, path: "/api/live/link"};
    const link = createLiveGatewayRequestParser(config); config.path = "/api/live";
    expect(link(request(headers, `/api/live/link?session=${session}`))).toEqual({session, ticketToken: token});
    expect(link(request())).toBeNull();
    expect(parse(request(headers, `/api/live/link?session=${session}`))).toBeNull();
    expect(link(request(headers, `/api/live/link?session=${session}&ticket=${token}`))).toBeNull();
  });
  it("returns only the session discriminator and unchanged ticket credential", () => {
    expect(parse(request())).toEqual({ session, ticketToken: token });
    expect(parse(request(["hOsT", "SHARE.EXAMPLE.TEST", ...headers.slice(2)]))).toEqual({ session, ticketToken: token });
    expect(parse(request([...headers.slice(0, 4), "Sec-WebSocket-Protocol", `dohc-live-ticket.${token},\tdohc-live-v1`]))).toEqual({ session, ticketToken: token });
    expect(parse(request([...headers, "Cookie", "browser=session-cookie", "Accept-Language", "en"]))).toEqual({ session, ticketToken: token });
  });

  it("accepts a configured IPv6 authority", () => {
    const ipv6 = createLiveGatewayRequestParser({ publicHosts: new Set(["[::1]:4433"]), publicOrigin: "https://[::1]:4433" });
    expect(ipv6(request(["Host", "[::1]:4433", "Origin", "https://[::1]:4433", ...headers.slice(4)]))).toEqual({ session, ticketToken: token });
  });

  it.each(["Host", "Origin", "Sec-WebSocket-Protocol"])("refuses missing, repeated, empty and comma-joined %s fields", name => {
    const index = headers.indexOf(name);
    const missing = headers.filter((_, i) => i !== index && i !== index + 1);
    expect(parse(request(missing))).toBeNull();
    expect(parse(request([...headers, name.toLowerCase(), headers[index + 1]!]))).toBeNull();
    for (const value of ["", `${headers[index + 1]},${headers[index + 1]}`]) {
      const changed = [...headers]; changed[index + 1] = value;
      expect(parse(request(changed))).toBeNull();
    }
  });

  it.each([
    ["hostile.example.test", origin],
    ["share.example.test", "https://hostile.example.test"],
    ["share.example.test", "https://SHARE.example.test"],
    ["share.example.test", `${origin}/`],
    ["share.example.test", "null"],
    ["share.example.test ", origin],
    ["share.example.test:443", origin],
  ])("refuses mismatched authority %s / %s", (host, suppliedOrigin) => {
    expect(parse(request(["Host", host, "Origin", suppliedOrigin, ...headers.slice(4), "Referer", origin, "X-Forwarded-Host", "share.example.test"]))).toBeNull();
  });

  it.each([
    "/api/live", "/api/live?session=", `${target}&session=${session}`, `${target}&extra=1`,
    `${target}#fragment`, `/api/../api/live?session=${session}`, `/api/%6cive?session=${session}`,
    `${origin}${target}`, `//share.example.test${target}`, `/api/live?session=${token}`,
    `/api/live?session=${session}&ticket=${token}`, "/api/live?session=abc%0adefghijk",
    `/api/live?%73ession=${session}`, "/api/live?session=abcdefghijk%6c", `${target}&`,
  ])("refuses non-exact live target %s", url => {
    expect(parse(request(headers, url))).toBeNull();
  });

  it("requires GET and refuses malformed raw pairs", () => {
    expect(parse(request(headers, target, "POST"))).toBeNull();
    expect(parse(request([...headers, "Host"]))).toBeNull();
  });

  it.each([
    "dohc-live-v1", `dohc-live-ticket.${token}`, `${protocol}, other`,
    `dohc-live-v1, dohc-live-v1`, `dohc-live-ticket.${token}, dohc-live-ticket.${token}`,
    `dohc-live-v1,,dohc-live-ticket.${token}`, `dohc-live-v1, dohc-live-ticket.${token.toUpperCase()}`,
    `dohc-live-v1, dohc-live-ticket. ${token}`, `${protocol},`, `dohc-live-v1, dohc-live-ticket.${token.slice(1)}`,
  ])("refuses malformed protocol list %s", value => {
    expect(parse(request([...headers.slice(0, 4), "Sec-WebSocket-Protocol", value]))).toBeNull();
  });

  it("does not accept a cookie credential or retain mutable host configuration", () => {
    expect(parse(request([...headers.slice(0, 4), "Cookie", `ticket=${token}`]))).toBeNull();
    const publicHosts = new Set(["share.example.test"]);
    const isolated = createLiveGatewayRequestParser({ publicHosts, publicOrigin: origin });
    publicHosts.clear(); publicHosts.add("hostile.example.test");
    expect(isolated(request())).toEqual({ session, ticketToken: token });
    expect(isolated(request(["Host", "hostile.example.test", ...headers.slice(2)]))).toBeNull();
  });

  it.each([`${origin}/`, "HTTPS://share.example.test", "null", "https://other.example.test"])("rejects invalid configured origin %s before requests", publicOrigin => {
    expect(() => createLiveGatewayRequestParser({ publicHosts: new Set(["share.example.test"]), publicOrigin })).toThrow();
  });

  it("preserves raw TCP header cardinality before any accepted continuation", async () => {
    let accepted = 0;
    const seen: Array<{ rawHosts: number; normalizedHost: string | undefined }> = [];
    const server = createServer();
    server.on("upgrade", (incoming, socket) => {
      seen.push({ rawHosts: incoming.rawHeaders.filter((name, index) => index % 2 === 0 && name.toLowerCase() === "host").length, normalizedHost: incoming.headers.host });
      const result = parse(incoming);
      if (result) accepted++;
      socket.end(`HTTP/1.1 ${result ? "204 No Content" : "404 Not Found"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    const send = async (fields: string[]) => {
      const socket = connect(address.port, "127.0.0.1");
      let response = "";
      socket.setEncoding("utf8");
      socket.on("data", chunk => { response += chunk; });
      try {
        await once(socket, "connect");
        socket.write([`GET ${target} HTTP/1.1`, "Connection: Upgrade", "Upgrade: websocket", ...fields, "", ""].join("\r\n"));
        await once(socket, "close");
        return response;
      } finally { socket.destroy(); }
    };
    const valid = ["Host: share.example.test", `Origin: ${origin}`, `Sec-WebSocket-Protocol: ${protocol}`];
    try {
      for (const duplicate of valid) {
        expect(await send([...valid, duplicate])).toContain("404 Not Found");
        expect(accepted).toBe(0);
      }
      expect(seen[0]).toEqual({ rawHosts: 2, normalizedHost: "share.example.test" });
      expect(await send(valid)).toContain("204 No Content");
      expect(accepted).toBe(1);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
});
