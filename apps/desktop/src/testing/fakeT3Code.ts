import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export interface FakeT3Code {
  origin: string;
  registrations: Array<Record<string, unknown>>;
  authorizations: URLSearchParams[];
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
  /** What each tool answers, keyed by name. */
  tools: Record<string, (args: Record<string, unknown>) => unknown>;
  /** The words each tool refuses its calls with, keyed by name. */
  refusals: Record<string, string>;
  decline: boolean;
  /** Answer tool calls as an event stream. */
  eventStream: boolean;
  /** Names every sign-in address under this origin in place of the server's own. */
  metadataOrigin: string | null;
  /** Answers 404 where the sign-in addresses are published, as a T3 Code without the sign-in does. */
  noSignIn: boolean;
  /** Opens a session, then answers the handshake in a shape dohc cannot read. */
  badHandshake: boolean;
  /** How many sessions dohc ended. */
  ended: number;
}

// A stand-in for T3 Code's server: its sign-in addresses and its MCP endpoint,
// with the checks T3 Code makes on the code, the redirect, and the verifier.
export async function startFakeT3Code(): Promise<FakeT3Code & { close(): Promise<void> }> {
  const pending = new Map<
    string,
    { clientId: string; redirectUri: string; challenge: string; resource: string }
  >();
  const fake: FakeT3Code = {
    origin: "",
    registrations: [],
    authorizations: [],
    calls: [],
    tools: {},
    refusals: {},
    decline: false,
    eventStream: false,
    metadataOrigin: null,
    noSignIn: false,
    badHandshake: false,
    ended: 0,
  };
  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", fake.origin);
      const json = (status: number, value: unknown, headers: Record<string, string> = {}) =>
        response
          .writeHead(status, { "content-type": "application/json", ...headers })
          .end(JSON.stringify(value));
      if (request.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
        if (fake.noSignIn) return json(404, { error: "not_found" });
        const at = fake.metadataOrigin ?? fake.origin;
        return json(200, {
          issuer: at,
          authorization_endpoint: `${at}/oauth/mcp/authorize`,
          token_endpoint: `${at}/oauth/mcp/token`,
          registration_endpoint: `${at}/oauth/mcp/register`,
        });
      }
      if (request.method === "POST" && url.pathname === "/oauth/mcp/register") {
        fake.registrations.push(JSON.parse(await bodyOf(request)) as Record<string, unknown>);
        return json(201, { client_id: "client-1" });
      }
      if (request.method === "GET" && url.pathname === "/oauth/mcp/authorize") {
        fake.authorizations.push(url.searchParams);
        const redirect = new URL(url.searchParams.get("redirect_uri")!);
        redirect.searchParams.set("state", url.searchParams.get("state")!);
        redirect.searchParams.set("iss", fake.origin);
        if (fake.decline) redirect.searchParams.set("error", "access_denied");
        else {
          redirect.searchParams.set("code", "code-1");
          pending.set("code-1", {
            clientId: url.searchParams.get("client_id")!,
            redirectUri: url.searchParams.get("redirect_uri")!,
            challenge: url.searchParams.get("code_challenge")!,
            resource: url.searchParams.get("resource")!,
          });
        }
        return response.writeHead(302, { location: redirect.href }).end();
      }
      if (request.method === "POST" && url.pathname === "/oauth/mcp/token") {
        const form = new URLSearchParams(await bodyOf(request));
        const code = pending.get(form.get("code") ?? "");
        pending.delete(form.get("code") ?? "");
        const verified =
          code !== undefined &&
          form.get("grant_type") === "authorization_code" &&
          form.get("client_id") === code.clientId &&
          form.get("redirect_uri") === code.redirectUri &&
          form.get("resource") === code.resource &&
          createHash("sha256")
            .update(form.get("code_verifier") ?? "")
            .digest("base64url") === code.challenge;
        return verified
          ? json(200, {
              access_token: "token-1",
              token_type: "Bearer",
              expires_in: 2_592_000,
              scope: "orchestration:read orchestration:operate",
            })
          : json(400, { error: "invalid_grant" });
      }
      if (url.pathname === "/mcp") {
        if (request.headers.authorization !== "Bearer token-1")
          return json(401, { error: "invalid_mcp_credential" });
        if (request.method === "DELETE") {
          fake.ended += 1;
          return response.writeHead(200).end();
        }
        const message = JSON.parse(await bodyOf(request)) as {
          id?: string;
          method: string;
          params?: { name: string; arguments: Record<string, unknown> };
        };
        if (message.method === "notifications/initialized") return response.writeHead(202).end();
        let result: unknown;
        if (message.method === "initialize")
          result = fake.badHandshake
            ? { capabilities: {} }
            : {
                protocolVersion: "2025-06-18",
                capabilities: {},
                serverInfo: { name: "fake", version: "0" },
              };
        else {
          const { name, arguments: args } = message.params!;
          fake.calls.push({ tool: name, args });
          const answer = fake.tools[name];
          const refusal = fake.refusals[name];
          result = refusal
            ? { isError: true, content: [{ type: "text", text: refusal }] }
            : answer
              ? { structuredContent: answer(args) }
              : {
                  isError: true,
                  content: [{ type: "text", text: `No thread tool named ${name}.` }],
                };
        }
        const envelope = { jsonrpc: "2.0", id: message.id, result };
        // One event's JSON spread over several data lines, as the event stream format allows.
        const dataLines = JSON.stringify(envelope, null, 1)
          .split("\n")
          .map((line) => `data: ${line}`)
          .join("\n");
        if (fake.eventStream)
          return response
            .writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "session-1" })
            .end(`event: message\n${dataLines}\n\n`);
        return json(200, envelope, { "mcp-session-id": "session-1" });
      }
      return response.writeHead(404).end();
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  fake.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return Object.assign(fake, {
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
}

// The person's browser: it opens T3 Code's page and follows where T3 Code sends it.
export async function browser(url: string): Promise<void> {
  const page = await fetch(url, { redirect: "manual" });
  await fetch(page.headers.get("location")!);
}
