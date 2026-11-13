import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  T3CodeError,
  listT3CodeProjects,
  listT3CodeThreads,
  openT3CodeSession,
  readT3CodeAddress,
  readT3CodeThread,
  sendToT3CodeThread,
  signInToT3Code,
  t3CodeOriginOnThisComputer,
} from "./t3Code";
import { T3CodeSignInNotKept, createT3CodeSignInStore } from "./t3CodeSignInStore";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

interface FakeT3Code {
  origin: string;
  registrations: Array<Record<string, unknown>>;
  authorizations: URLSearchParams[];
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
  /** What each tool answers, keyed by name. */
  tools: Record<string, (args: Record<string, unknown>) => unknown>;
  decline: boolean;
  /** Answer tool calls as an event stream. */
  eventStream: boolean;
  /** Names every sign-in address under this origin in place of the server's own. */
  metadataOrigin: string | null;
}

// A stand-in for T3 Code's server: its sign-in addresses and its MCP endpoint,
// with the checks T3 Code makes on the code, the redirect, and the verifier.
async function fakeT3Code(): Promise<FakeT3Code> {
  const pending = new Map<string, { clientId: string; redirectUri: string; challenge: string; resource: string }>();
  const fake: FakeT3Code = { origin: "", registrations: [], authorizations: [], calls: [], tools: {}, decline: false, eventStream: false, metadataOrigin: null };
  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", fake.origin);
      const json = (status: number, value: unknown, headers: Record<string, string> = {}) =>
        response.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(value));
      if (request.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
        const at = fake.metadataOrigin ?? fake.origin;
        return json(200, { issuer: at, authorization_endpoint: `${at}/oauth/mcp/authorize`, token_endpoint: `${at}/oauth/mcp/token`, registration_endpoint: `${at}/oauth/mcp/register` });
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
          pending.set("code-1", { clientId: url.searchParams.get("client_id")!, redirectUri: url.searchParams.get("redirect_uri")!, challenge: url.searchParams.get("code_challenge")!, resource: url.searchParams.get("resource")! });
        }
        return response.writeHead(302, { location: redirect.href }).end();
      }
      if (request.method === "POST" && url.pathname === "/oauth/mcp/token") {
        const form = new URLSearchParams(await bodyOf(request));
        const code = pending.get(form.get("code") ?? "");
        pending.delete(form.get("code") ?? "");
        const verified = code !== undefined && form.get("grant_type") === "authorization_code" && form.get("client_id") === code.clientId &&
          form.get("redirect_uri") === code.redirectUri && form.get("resource") === code.resource &&
          createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") === code.challenge;
        return verified ? json(200, { access_token: "token-1", token_type: "Bearer", expires_in: 2_592_000, scope: "orchestration:read orchestration:operate" }) : json(400, { error: "invalid_grant" });
      }
      if (url.pathname === "/mcp") {
        if (request.headers.authorization !== "Bearer token-1") return json(401, { error: "invalid_mcp_credential" });
        if (request.method === "DELETE") return response.writeHead(200).end();
        const message = JSON.parse(await bodyOf(request)) as { id?: string; method: string; params?: { name: string; arguments: Record<string, unknown> } };
        if (message.method === "notifications/initialized") return response.writeHead(202).end();
        let result: unknown;
        if (message.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "0" } };
        else {
          const { name, arguments: args } = message.params!;
          fake.calls.push({ tool: name, args });
          const answer = fake.tools[name];
          result = answer ? { structuredContent: answer(args) } : { isError: true, content: [{ type: "text", text: `No thread tool named ${name}.` }] };
        }
        const envelope = { jsonrpc: "2.0", id: message.id, result };
        if (fake.eventStream) return response.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "session-1" }).end(`event: message\ndata: ${JSON.stringify(envelope)}\n\n`);
        return json(200, envelope, { "mcp-session-id": "session-1" });
      }
      return response.writeHead(404).end();
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  fake.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return fake;
}

// The person's browser: it opens T3 Code's page and follows where T3 Code sends it.
async function browser(url: string): Promise<void> {
  const page = await fetch(url, { redirect: "manual" });
  await fetch(page.headers.get("location")!);
}

describe("T3 Code's address", () => {
  it("takes plain http on this computer by number and nothing else", () => {
    expect(t3CodeOriginOnThisComputer("http://127.0.0.1:3773")).toBe("http://127.0.0.1:3773");
    expect(t3CodeOriginOnThisComputer("http://[::1]:3773")).toBe("http://[::1]:3773");
    for (const elsewhere of [
      "http://localhost:3773", "https://127.0.0.1:3773", "http://127.0.0.2:3773", "http://192.168.1.4:3773", "http://example.com:3773",
      "http://user@127.0.0.1:3773", "http://127.0.0.1:3773/mcp", "http://127.0.0.1.example.com:3773", "not a url",
    ]) expect(t3CodeOriginOnThisComputer(elsewhere), elsewhere).toBeNull();
  });

  it("reads the file T3 Code keeps while it runs, and refuses a server that is not on this computer", async () => {
    const home = await mkdtemp(join(tmpdir(), "dohc-t3-home-"));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    await expect(readT3CodeAddress(home)).resolves.toBeNull();
    await mkdir(join(home, "userdata"));
    const write = (file: unknown) => writeFile(join(home, "userdata", "server-runtime.json"), JSON.stringify(file));
    await write({ version: 1, host: "127.0.0.1", port: 3773, origin: "http://127.0.0.1:3773", serverVersion: "0.1.10" });
    await expect(readT3CodeAddress(home)).resolves.toEqual({ origin: "http://127.0.0.1:3773", version: "0.1.10" });
    await write({ origin: "http://collector.example:3773" });
    await expect(readT3CodeAddress(home)).rejects.toMatchObject({ problem: "not-this-computer" });
    await writeFile(join(home, "userdata", "server-runtime.json"), "{ not json");
    await expect(readT3CodeAddress(home)).resolves.toBeNull();
  });
});

describe("signing in to T3 Code", () => {
  it("signs in after the person allows, proving the code is its own", async () => {
    const t3 = await fakeT3Code();
    const signIn = await signInToT3Code({ origin: t3.origin, open: browser, nowMs: () => 1_000 });
    expect(signIn).toEqual({ token: "token-1", expiresAtMs: 1_000 + 2_592_000_000 });
    // The redirect is on this computer by number, and dohc registers as a client with no secret.
    expect(t3.registrations).toEqual([{ client_name: "dohc", redirect_uris: [expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/t3-code$/u)], token_endpoint_auth_method: "none" }]);
    const asked = t3.authorizations[0]!;
    expect(Object.fromEntries(asked)).toMatchObject({ response_type: "code", client_id: "client-1", code_challenge_method: "S256", resource: `${t3.origin}/mcp` });
    expect(asked.get("code_challenge")).toMatch(/^[\w-]{43}$/u);
  });

  it("rejects when the person declines, does not answer in time, or cancels", async () => {
    const t3 = await fakeT3Code();
    t3.decline = true;
    await expect(signInToT3Code({ origin: t3.origin, open: browser })).rejects.toMatchObject({ problem: "not-allowed" });
    await expect(signInToT3Code({ origin: t3.origin, open: () => undefined, timeoutMs: 20 })).rejects.toMatchObject({ problem: "not-allowed" });
    const cancel = new AbortController();
    await expect(signInToT3Code({ origin: t3.origin, open: () => cancel.abort(), signal: cancel.signal })).rejects.toMatchObject({ problem: "not-allowed" });
  });

  it("takes only the answer that carries its own state", async () => {
    const t3 = await fakeT3Code();
    const signIn = await signInToT3Code({
      origin: t3.origin,
      open: async (url) => {
        const redirect = new URL(new URL(url).searchParams.get("redirect_uri")!);
        // Another page on this computer guesses the address but not the state.
        expect((await fetch(`${redirect.href}?code=stolen&state=guess`)).status).toBe(404);
        await browser(url);
      },
    });
    expect(signIn.token).toBe("token-1");
  });

  it("sends nothing when T3 Code's sign-in is not on this computer", async () => {
    const t3 = await fakeT3Code();
    t3.metadataOrigin = "http://collector.example";
    let opened = false;
    await expect(signInToT3Code({ origin: t3.origin, open: () => { opened = true; } })).rejects.toMatchObject({ problem: "not-this-computer" });
    expect(opened).toBe(false);
    expect(t3.registrations).toEqual([]);
    await expect(signInToT3Code({ origin: "http://collector.example", open: () => undefined })).rejects.toMatchObject({ problem: "not-this-computer" });
    await expect(openT3CodeSession({ origin: "http://collector.example", token: "token-1" })).rejects.toMatchObject({ problem: "not-this-computer" });
  });

  it("says T3 Code is not running when nothing answers", async () => {
    const t3 = await fakeT3Code();
    const origin = t3.origin;
    await cleanups.pop()!();
    await expect(signInToT3Code({ origin, open: () => undefined })).rejects.toMatchObject({ problem: "not-running" });
    await expect(openT3CodeSession({ origin, token: "token-1" })).rejects.toMatchObject({ problem: "not-running" });
  });
});

describe("T3 Code's thread tools", () => {
  it("lists projects and threads, gives a thread a message once, and reads what it is doing", async () => {
    const t3 = await fakeT3Code();
    t3.tools.t3_project_list = ({ cursor }) => cursor === 0
      ? { projects: [{ id: "p1", title: "dohc", archivedAt: null, deletedAt: null }, { id: "p2", title: "Old", archivedAt: "2026-01-01T00:00:00.000Z", deletedAt: null }], nextCursor: 2 }
      : { projects: [{ id: "p3", title: "garage", archivedAt: null, deletedAt: null }], nextCursor: null };
    t3.tools.t3_thread_list = () => ({ threads: [{ threadId: "t1", projectId: "p1", title: "Chief of Staff", status: "running", updatedAt: "2026-11-13T10:00:00.000Z", extra: 1 }], nextCursor: 50, total: 11_552 });
    t3.tools.t3_thread_send = () => ({ threadId: "t1", runId: "run-9", status: "starting", delivery: "started" });
    t3.tools.t3_thread_read = () => ({ thread: { title: "Chief of Staff", activeRunId: "run-9", pendingRequestCount: 1, archived: false, settled: false } });
    const session = await openT3CodeSession({ origin: t3.origin, token: "token-1" });
    cleanups.push(() => session.close());

    await expect(listT3CodeProjects(session)).resolves.toEqual([{ id: "p1", title: "dohc" }, { id: "p3", title: "garage" }]);
    await expect(listT3CodeThreads(session, { projectId: "p1", titleContains: "chief", cursor: 50 })).resolves.toEqual({
      threads: [{ id: "t1", projectId: "p1", title: "Chief of Staff", status: "running", updatedAt: "2026-11-13T10:00:00.000Z" }],
      nextCursor: 50,
    });
    await expect(sendToT3CodeThread(session, { threadId: "t1", message: "status?", how: "line", forwardId: "f1" })).resolves.toEqual({ runId: "run-9" });
    await sendToT3CodeThread(session, { threadId: "t1", message: "now", how: "steer", forwardId: "f2" });
    await expect(readT3CodeThread(session, "t1")).resolves.toEqual({ title: "Chief of Staff", working: true, waitingOnPerson: true, closed: false });

    expect(t3.calls.filter((call) => call.tool === "t3_thread_list")).toEqual([{ tool: "t3_thread_list", args: { projectId: "p1", limit: 50, includeSubagents: false, settled: false, cursor: 50, titleContains: "chief" } }]);
    // The forward's own id travels with it, so T3 Code can tell a second send of the same message.
    expect(t3.calls.filter((call) => call.tool === "t3_thread_send").map((call) => call.args)).toEqual([
      { threadId: "t1", message: "status?", mode: "queue", clientRequestId: "f1" },
      { threadId: "t1", message: "now", mode: "steer", clientRequestId: "f2" },
    ]);
  });

  it("reads an answer sent as an event stream", async () => {
    const t3 = await fakeT3Code();
    t3.eventStream = true;
    t3.tools.t3_thread_read = () => ({ thread: { title: "Quiet", activeRunId: null, pendingRequestCount: 0, archived: true, settled: false } });
    const session = await openT3CodeSession({ origin: t3.origin, token: "token-1" });
    await expect(readT3CodeThread(session, "t1")).resolves.toEqual({ title: "Quiet", working: false, waitingOnPerson: false, closed: true });
  });

  it("tells a sign-in T3 Code no longer takes from a call it refused and an answer it cannot read", async () => {
    const t3 = await fakeT3Code();
    await expect(openT3CodeSession({ origin: t3.origin, token: "old-token" })).rejects.toMatchObject({ problem: "not-allowed" });
    const session = await openT3CodeSession({ origin: t3.origin, token: "token-1" });
    await expect(session.call("t3_thread_delete", {})).rejects.toMatchObject({ problem: "refused", message: "No thread tool named t3_thread_delete." });
    t3.tools.t3_thread_read = () => ({ thread: { title: 7 } });
    const unread = await readT3CodeThread(session, "t1").catch((error: unknown) => error);
    expect(unread).toBeInstanceOf(T3CodeError);
    expect(unread).toMatchObject({ problem: "unexpected" });
  });
});

describe("keeping the sign-in to T3 Code", () => {
  const cipher = (available: boolean) => ({
    isAvailable: () => available,
    encrypt: (plain: string) => Buffer.from(`sealed:${plain}`).toString("base64"),
    decrypt: (sealed: string) => Buffer.from(sealed, "base64").toString("utf8").slice("sealed:".length),
  });

  it("keeps it encrypted, gives it back until it runs out, and drops it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dohc-t3-store-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    let now = 1_000;
    const store = createT3CodeSignInStore({ dir, cipher: cipher(true), nowMs: () => now });
    await expect(store.load()).resolves.toBeNull();
    await store.save({ token: "token-1", expiresAtMs: 5_000 });
    expect(await readFile(join(dir, "dohc-t3-code.json"), "utf8")).not.toContain("token-1");
    await expect(store.load()).resolves.toEqual({ token: "token-1", expiresAtMs: 5_000 });
    now = 5_000;
    await expect(store.load()).resolves.toBeNull();
    await store.clear();
    await store.clear();
    now = 1_000;
    await expect(store.load()).resolves.toBeNull();
  });

  it("keeps nothing when this computer cannot encrypt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dohc-t3-store-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    for (const store of [createT3CodeSignInStore({ dir, cipher: cipher(false) }), createT3CodeSignInStore({ dir })]) {
      expect(store.canKeep()).toBe(false);
      await expect(store.save({ token: "token-1", expiresAtMs: 5_000 })).rejects.toBeInstanceOf(T3CodeSignInNotKept);
      await expect(store.load()).resolves.toBeNull();
    }
    await expect(readFile(join(dir, "dohc-t3-code.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
