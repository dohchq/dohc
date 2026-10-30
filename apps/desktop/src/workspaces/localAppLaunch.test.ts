import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { AppBackendRuntimeError } from "@dohc/app-backend-runtime";
import { createLocalAppLaunchHost, LocalAppUnavailableError, type LocalAppLaunchHost } from "./localAppLaunch";

const publicationId = "a".repeat(64);
const hosts: LocalAppLaunchHost[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await Promise.all(hosts.splice(0).map(host => host.close())); });
async function fixture(keepAlive = false) {
  const lifetime = new AbortController(), session = new AbortController();
  let revision = 1, shared = false;
  const bytes = Buffer.from("document.getElementById('root').textContent='Approved app';");
  const backend = {
    checkBrowserPublication: vi.fn(async (_id: string, _expected: number, _signal: AbortSignal) => {}),
    assertBrowserPublication: vi.fn((id: string, expected: number) => {
      if (id !== publicationId || shared || expected !== revision) throw Error("Unavailable publication");
    }),
    browserPublication: vi.fn((id: string) => {
      if (id !== publicationId || shared) throw Error("Unavailable publication");
      return { publicationId, authorityRevision: revision, appRoot: "app", files: [{ path: "bundle.js", contentType: "text/javascript; charset=utf-8", sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length, bytes }] };
    }),
    request: vi.fn(async (_publication: string, _action: string, body: unknown, _signal?: AbortSignal) => ({ result: body, revision: 1, replayed: false })),
    readBrowserFile: vi.fn(async (_publication: string, _body: unknown, _signal?: AbortSignal) => ({ file: { fileId: "file_0123456789abcdef", name: "receipt.pdf", contentType: "application/pdf", byteLength: 4, sha256: "a".repeat(64) }, bytesBase64: "JVBERg==" })),
  };
  const host = await createLocalAppLaunchHost({ backend, lifetime: lifetime.signal }); hosts.push(host);
  const managed = keepAlive ? await host.launchSession(publicationId, session.signal, { keepAlive: true }) : undefined;
  const url = managed?.url ?? await host.launch(publicationId, session.signal), origin = new URL(url).origin, handoff = new URL(url).hash.slice(1);
  const post = (path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(origin + path, { method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const open = async () => {
    const response = await post("/session", { handoff }); expect(response.status).toBe(200);
    return await response.json() as { proof: string; html: string };
  };
  return { host, backend, lifetime, session, managed, url, origin, handoff, post, open, narrow() { revision++; }, share() { shared = true; } };
}
const invoke = { id: "one", op: "backend.invoke", operation: "register", idempotencyKey: "attempt-1", input: { count: 1 } };

it("serves only an approved snapshot after a one-use fragment handoff", async () => {
  const f = await fixture();
  const bootstrap = await fetch(f.origin + "/bootstrap"); expect(bootstrap.status).toBe(200);
  const html = await bootstrap.text();
  expect(html).not.toContain(f.handoff); expect(html).not.toContain("Approved app");
  expect(html).toContain("frame.sandbox='allow-scripts allow-forms allow-downloads allow-popups allow-popups-to-escape-sandbox'");
  expect(bootstrap.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(bootstrap.headers.get("cross-origin-opener-policy")).toBe("same-origin");
  const opened = await f.open(); expect(opened.html).toContain("Approved app"); expect(opened.html).not.toContain(opened.proof);
  expect((await f.post("/session", { handoff: f.handoff })).status).toBe(404);
  expect((await fetch(f.origin + "/backend.js")).status).toBe(404);
});
it("exposes a managed session that closes its listener and reports approval changes", async () => {
  const f = await fixture();
  const managed = await f.host.launchSession(publicationId, f.session.signal);
  expect(managed.isAlive()).toBe(true);
  f.narrow();
  expect(managed.isAlive()).toBe(false);
  expect(managed.ended.reason).toBe("needs-approval");
  await managed.stop();
  await expect(fetch(managed.url)).rejects.toThrow();
});
it("stops a managed session explicitly and releases its staged slot", async () => {
  const f = await fixture();
  const managed = await f.host.launchSession(publicationId, f.session.signal);
  await managed.stop();
  expect(managed.ended.reason).toBe("ended");
  expect(managed.isAlive()).toBe(false);
  await expect(fetch(managed.url)).rejects.toThrow();
  const next = await f.host.launchSession(publicationId, f.session.signal);
  await next.stop();
});
it("resumes a refreshed parent using its origin-bound proof and freshly checked approved bundle", async () => {
  const f = await fixture();
  expect((await f.post("/resume")).status).toBe(404);
  const opened = await f.open(), headers = { "x-dohc-app-proof": opened.proof };
  const response = await f.post("/resume", undefined, headers);
  expect(response.status).toBe(200); expect(await response.json()).toEqual(opened);
  expect(f.backend.browserPublication).toHaveBeenCalledTimes(2);
  expect((await f.post("/resume", undefined, { ...headers, origin: "null" })).status).toBe(404);
  f.narrow();
  expect((await f.post("/resume", undefined, headers)).status).toBe(404);
});
it("keeps proof only in the trusted parent's session storage and does not close on refresh", async () => {
  const f = await fixture(), response = await fetch(f.origin + "/bootstrap"), html = await response.text();
  expect(html).toContain("sessionStorage.getItem(key)");
  expect(html).toContain("sessionStorage.setItem(key,value)");
  expect(html).toContain("addEventListener('pagehide',()=>{stopped=true;lifetime.abort();frame?.remove();}");
  expect(html).not.toContain("addEventListener('pagehide',stop");
  const opened = await f.open(); expect(opened.html).not.toContain("dohc-local-app-proof");
});
it("routes a scoped pending submission request without accepting renderer authority", async () => {
  const f = await fixture(), opened = await f.open(), headers = { "x-dohc-app-proof": opened.proof };
  const attempt = { id: "attempt", op: "backend.attempt", operation: "submit", request: { action: "save", idempotencyKey: "retry", input: { name: "Mom" } } };
  expect((await f.post("/backend", attempt, headers)).status).toBe(200);
  expect(f.backend.request).toHaveBeenCalledWith(publicationId, "attempt", { authorityRevision: 1, operation: "submit", ...attempt.request }, expect.any(AbortSignal));
  expect((await f.post("/backend", { ...attempt, request: { ...attempt.request, principal: "other" } }, headers)).status).toBe(404);
});

it("requires exact origin, host, handoff, and proof and strips caller authority", async () => {
  const f = await fixture();
  expect((await f.post("/session", { handoff: f.handoff }, { origin: "null" })).status).toBe(404);
  expect((await f.post("/session", { handoff: "x".repeat(43) })).status).toBe(404);
  const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(f.origin + "/bootstrap", { headers: { host: "attacker.example" } }, response => { response.resume(); resolve(response.statusCode); });
    request.once("error", reject); request.end();
  });
  expect(wrongHost).toBe(404);
  const opened = await f.open(), headers = { "x-dohc-app-proof": opened.proof };
  expect((await f.post("/backend", invoke)).status).toBe(404);
  expect((await f.post("/backend", invoke, { ...headers, origin: "null" })).status).toBe(404);
  for (const patch of [{ authorityRevision: 9 }, { publicationId: "b".repeat(64) }, { caller: { kind: "owner" } }, { path: "private.sqlite" }]) {
    expect((await f.post("/backend", { ...invoke, ...patch }, headers)).status).toBe(400);
  }
  expect(f.backend.request).not.toHaveBeenCalled();
  expect((await f.post("/backend", invoke, headers)).status).toBe(200);
  expect(f.backend.request).toHaveBeenCalledWith(publicationId, "invoke", { authorityRevision: 1, operation: "register", idempotencyKey: "attempt-1", input: { count: 1 } }, expect.any(AbortSignal));
});

it("carries exact Collection list and create requests and answers an unavailable engine with 503", async () => {
  const f = await fixture(), opened = await f.open(), headers = { "x-dohc-app-proof": opened.proof };
  const list = { id: "list", op: "collection.list", limit: 10, afterPath: "trip/responses/a.md" };
  const create = { id: "create", op: "collection.create", idempotencyKey: "response-1", fields: { destination: "Tokyo" } };
  expect((await f.post("/backend", list, headers)).status).toBe(200);
  expect(f.backend.request).toHaveBeenLastCalledWith(publicationId, "list", { authorityRevision: 1, limit: 10, afterPath: list.afterPath }, expect.any(AbortSignal));
  expect((await f.post("/backend", create, headers)).status).toBe(200);
  expect(f.backend.request).toHaveBeenLastCalledWith(publicationId, "create", { authorityRevision: 1, idempotencyKey: "response-1", fields: { destination: "Tokyo" } }, expect.any(AbortSignal));
  for (const body of [{ ...list, limit: 0 }, { ...list, authorityRevision: 9 }, { ...create, path: "elsewhere.md" }, { ...create, authorityRevision: 9 }])
    expect((await f.post("/backend", body, headers)).status).toBe(400);
  expect((await f.post("/backend", { ...create, idempotencyKey: "bad key" }, headers)).status).toBe(404);
  expect((await f.post("/backend", { ...create, fields: { note: "x".repeat(17_000) } }, headers)).status).toBe(413);
  expect(f.backend.request).toHaveBeenCalledTimes(2);
  f.backend.request.mockRejectedValueOnce(new LocalAppUnavailableError("The workspace engine did not answer."));
  expect((await f.post("/backend", list, headers)).status).toBe(503);
  f.backend.request.mockRejectedValueOnce(new Error("This app is not approved for document Collection access."));
  expect((await f.post("/backend", list, headers)).status).toBe(404);
});

it("binds upload and authorized file operations to the same approved app", async () => {
  const f = await fixture(), opened = await f.open(), headers = { "x-dohc-app-proof": opened.proof };
  expect((await f.post("/backend", { id: "upload", op: "backend.upload", idempotencyKey: "upload-1", name: "receipt.pdf", contentType: "application/pdf", bytesBase64: "JVBERg==" }, headers)).status).toBe(200);
  expect(f.backend.request.mock.calls.at(-1)?.[1]).toBe("upload");
  const file = { id: "file", op: "backend.file", fileId: "file_0123456789abcdef", operation: "receipt.read", input: {} };
  expect((await f.post("/backend", file, headers)).status).toBe(200);
  expect(f.backend.readBrowserFile).toHaveBeenCalledWith(publicationId, { authorityRevision: 1, fileId: file.fileId, operation: file.operation, input: {} }, expect.any(AbortSignal));
});

it.each(["narrow", "share"] as const)("refuses a stale or transferred approval: %s", async action => {
  const f = await fixture(), opened = await f.open(); f[action]();
  expect((await f.post("/backend", invoke, { "x-dohc-app-proof": opened.proof })).status).toBe(404);
  expect((await f.post("/status", undefined, { "x-dohc-app-proof": opened.proof })).status).toBe(404);
  expect(f.backend.request).not.toHaveBeenCalled();
});

it("separates launch origins and refuses cross-launch proofs", async () => {
  const f = await fixture(), first = await f.open();
  const second = new URL(await f.host.launch(publicationId, f.session.signal));
  expect(second.origin).not.toBe(f.origin);
  const response = await fetch(second.origin + "/session", { method: "POST", headers: { origin: second.origin, "content-type": "application/json" }, body: JSON.stringify({ handoff: second.hash.slice(1) }) });
  expect(response.status).toBe(200);
  expect((await fetch(second.origin + "/backend", { method: "POST", headers: { origin: second.origin, "content-type": "application/json", "x-dohc-app-proof": first.proof }, body: JSON.stringify(invoke) })).status).toBe(404);
});

it("cancels an in-flight operation when its renderer session ends", async () => {
  const f = await fixture(), opened = await f.open();
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  f.backend.request.mockImplementation(async (_pub, _action, body, signal) => { started(); await new Promise<void>(resolve => signal!.addEventListener("abort", () => resolve(), { once: true })); return { result: body, revision: 1, replayed: false }; });
  const response = f.post("/backend", invoke, { "x-dohc-app-proof": opened.proof }).catch(() => null);
  await ready; f.session.abort();
  expect(await response).toBeNull();
  await expect(f.host.launch(publicationId, f.session.signal)).rejects.toThrow();
});

it("limits abandoned staging and stops all launch listeners with workspace lifetime", async () => {
  const f = await fixture();
  await f.host.launch(publicationId, f.session.signal);
  await expect(f.host.launch(publicationId, f.session.signal)).rejects.toThrow("Close another app");
  f.lifetime.abort(); await f.host.close();
  await expect(fetch(f.origin + "/bootstrap")).rejects.toThrow();
});

it("releases an authenticated closed launch and never lets another origin close it", async () => {
  const f = await fixture(), opened = await f.open(), headers = { "x-dohc-app-proof": opened.proof };
  expect((await f.post("/close", undefined, { ...headers, origin: "null" })).status).toBe(404);
  expect((await f.post("/close")).status).toBe(404);
  expect((await f.post("/status", undefined, headers)).status).toBe(204);
  expect((await f.post("/close", undefined, headers)).status).toBe(204);
  await expect.poll(async () => { try { return (await fetch(f.origin + "/bootstrap")).status; } catch { return null; } }).toBeNull();
});

it("renews a short active lease and expires a launch after its browser disappears", async () => {
  const f = await fixture(), opened = await f.open(), headers = { "x-dohc-app-proof": opened.proof };
  let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
  now += 80_000;
  expect((await f.post("/status", undefined, headers)).status).toBe(204);
  now += 80_000;
  expect((await f.post("/status", undefined, headers)).status).toBe(204);
  now += 90_001;
  expect((await f.post("/backend", invoke, headers)).status).toBe(404);
  expect(f.backend.request).not.toHaveBeenCalled();
});
it("never extends the hard session lifetime through resume", async () => {
  const f = await fixture(), opened = await f.open(), headers = { "x-dohc-app-proof": opened.proof };
  const started = Date.now(); let now = started; vi.spyOn(Date, "now").mockImplementation(() => now);
  for (let elapsed = 80_000; elapsed < 30 * 60_000; elapsed += 80_000) {
    now = started + elapsed;
    expect((await f.post("/resume", undefined, headers)).status).toBe(200);
  }
  now = started + 30 * 60_000 + 1;
  expect((await f.post("/resume", undefined, headers)).status).toBe(404);
});
it("keeps an in-dohc session alive without heartbeats or a hard cap", async () => {
  const f = await fixture(true), opened = await f.open();
  const html = await (await fetch(f.origin + "/bootstrap")).text();
  expect(html).not.toContain("setTimeout(stop,1800000)");
  expect(html).not.toContain("setTimeout(poll");
  const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 2 * 60 * 60_000);
  expect(f.managed!.isAlive()).toBe(true);
  expect((await f.post("/resume", undefined, { "x-dohc-app-proof": opened.proof })).status).toBe(200);
  await f.managed!.stop();
  expect(f.managed!.isAlive()).toBe(false);
});
it("ends an in-dohc session when its Collection approval check refuses", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const f = await fixture(true); await f.open();
  f.backend.checkBrowserPublication.mockRejectedValue(Error("The Collection schema changed."));
  await vi.advanceTimersByTimeAsync(15_000);
  expect(f.managed!.ended.reason).toBe("needs-approval");
  await f.managed!.stop();
});
it("keeps an in-dohc session during temporary engine unavailability", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const f = await fixture(true); await f.open();
  f.backend.checkBrowserPublication.mockRejectedValue(new LocalAppUnavailableError("The engine did not answer."));
  await vi.advanceTimersByTimeAsync(15_000);
  expect(f.managed!.isAlive()).toBe(true);
  await f.managed!.stop();
});

it("returns only validated app refusals after rechecking current authority", async () => {
  const f = await fixture(), opened = await f.open(), headers = { "x-dohc-app-proof": opened.proof };
  f.backend.request.mockRejectedValue(new AppBackendRuntimeError({ code: "full", message: "This session is full." }));
  const response = await f.post("/backend", invoke, headers);
  expect(response.status).toBe(409); expect(await response.json()).toEqual({ code: "full", message: "This session is full." });
  f.backend.request.mockRejectedValue(new Error("private implementation failure"));
  const internal = await f.post("/backend", invoke, headers); expect(internal.status).toBe(404); expect(await internal.text()).toBe("");
  f.backend.request.mockImplementation(async () => { f.narrow(); throw new AppBackendRuntimeError({ code: "full", message: "Private data after revocation" }); });
  const stale = await f.post("/backend", invoke, headers); expect(stale.status).toBe(404); expect(await stale.text()).toBe("");
});
