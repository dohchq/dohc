import { describe, expect, it, vi } from "vitest";
import { listWorkspaces } from "./api";
import { createServerClient, requestGenerations, ServerError } from "./client";
import { deferred, testServer, type Answer } from "./testServer";

const WORKSPACES = { ok: true, workspaces: [{ workspaceId: "ws-1", name: "Trip", canOpen: true, showOnPhone: true }] };

function client(server: ReturnType<typeof testServer>, options: { signal?: AbortSignal; onSignedOut?: () => void; timeoutMs?: number } = {}) {
  return createServerClient({ origin: server.origin, token: "tok", fetch: server.fetch, signal: options.signal ?? new AbortController().signal, ...options });
}

async function problemOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => null, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(ServerError);
  return (error as ServerError).problem;
}

describe("the server client", () => {
  it("sends the Bearer token without cookies, and reads a checked answer", async () => {
    const server = testServer();
    server.on("GET", "/sync/account/workspaces", { status: 200, body: WORKSPACES });
    expect(await listWorkspaces(client(server))).toEqual([{ workspaceId: "ws-1", name: "Trip", canOpen: true, showOnPhone: true }]);
    expect(server.calls[0]!.headers.authorization).toBe("Bearer tok");
  });

  it("maps each failure to its problem", async () => {
    const cases: [Answer, string][] = [
      [{ status: 401, body: { ok: false, code: "unauthorized" } }, "signed-out"],
      [{ status: 404, body: { ok: false, code: "not_found" } }, "not-found"],
      [{ status: 503, body: { ok: false, code: "server_busy" } }, "server-busy"],
      [{ status: 429 }, "server-busy"],
      [{ status: 500, body: { ok: false, code: "internal_error" } }, "refused"],
      [{ status: 200, body: { ok: true, workspaces: [{ workspaceId: "ws-1" }] } }, "invalid"],
      [{ status: 200 }, "invalid"],
      ["offline", "offline"],
    ];
    for (const [answer, problem] of cases) {
      const server = testServer();
      server.on("GET", "/sync/account/workspaces", answer);
      expect(await problemOf(listWorkspaces(client(server)))).toBe(problem);
    }
  });

  it("reports a 401 as the end of its sign-in", async () => {
    const server = testServer();
    server.on("GET", "/sync/account/workspaces", { status: 401 });
    const onSignedOut = vi.fn();
    await problemOf(listWorkspaces(client(server, { onSignedOut })));
    expect(onSignedOut).toHaveBeenCalledTimes(1);
  });

  it("reads no answer as offline after its timeout", async () => {
    const server = testServer();
    server.on("GET", "/sync/account/workspaces", () => new Promise<Answer>(() => {}));
    expect(await problemOf(listWorkspaces(client(server, { timeoutMs: 5 })))).toBe("offline");
  });

  it("aborts a request in flight when its sign-in ends, and drops an answer that arrives after", async () => {
    const server = testServer();
    const held = deferred<Answer>();
    server.on("GET", "/sync/account/workspaces", () => held.promise);
    const signIn = new AbortController();
    const pending = listWorkspaces(client(server, { signal: signIn.signal }));
    await vi.waitFor(() => expect(server.calls).toHaveLength(1));
    signIn.abort();
    expect(server.calls[0]!.signal.aborted).toBe(true);
    held.resolve({ status: 200, body: WORKSPACES });
    expect(await problemOf(pending)).toBe("cancelled");
  });

  it("sends nothing once its sign-in has ended", async () => {
    const server = testServer();
    const signIn = new AbortController();
    signIn.abort();
    expect(await problemOf(listWorkspaces(client(server, { signal: signIn.signal })))).toBe("cancelled");
    expect(server.calls).toHaveLength(0);
  });
});

describe("request generations", () => {
  it("lets only the latest of results that replace each other land", () => {
    const requests = requestGenerations();
    const first = requests.next();
    const second = requests.next();
    expect(requests.isLatest(first)).toBe(false);
    expect(requests.isLatest(second)).toBe(true);
  });
});
