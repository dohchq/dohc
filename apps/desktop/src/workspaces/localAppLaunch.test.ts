import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { createLocalAppLaunchHost, type LocalAppLaunchHost } from "./localAppLaunch";

const publicationId = "a".repeat(64);
const hosts: LocalAppLaunchHost[] = [];
afterEach(async () => { await Promise.all(hosts.splice(0).map(host => host.close())); });
async function fixture() {
  const lifetime = new AbortController(), session = new AbortController();
  let revision = 1, shared = false;
  const bytes = Buffer.from("document.getElementById('root').textContent='Approved app';");
  const backend = {
    browserPublication: vi.fn((id: string) => {
      if (id !== publicationId || shared) throw Error("Unavailable publication");
      return { publicationId, authorityRevision: revision, appRoot: "app", files: [{ path: "bundle.js", contentType: "text/javascript; charset=utf-8", sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length, bytes }] };
    }),
    request: vi.fn(async (_publication: string, _action: string, body: unknown, _signal?: AbortSignal) => ({ result: body, revision: 1, replayed: false })),
    readBrowserFile: vi.fn(async (_publication: string, _body: unknown, _signal?: AbortSignal) => ({ file: { fileId: "file_0123456789abcdef", name: "receipt.pdf", contentType: "application/pdf", byteLength: 4, sha256: "a".repeat(64) }, bytesBase64: "JVBERg==" })),
  };
  const host = await createLocalAppLaunchHost({ backend, lifetime: lifetime.signal }); hosts.push(host);
  const url = await host.launch(publicationId, session.signal), origin = new URL(url).origin, handoff = new URL(url).hash.slice(1);
  const post = (path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(origin + path, { method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const open = async () => {
    const response = await post("/session", { handoff }); expect(response.status).toBe(200);
    return await response.json() as { proof: string; html: string };
  };
  return { host, backend, lifetime, session, url, origin, handoff, post, open, narrow() { revision++; }, share() { shared = true; } };
}
const invoke = { id: "one", op: "backend.invoke", operation: "register", idempotencyKey: "attempt-1", input: { count: 1 } };

it("serves only an approved snapshot after a one-use fragment handoff", async () => {
  const f = await fixture();
  const bootstrap = await fetch(f.origin + "/bootstrap"); expect(bootstrap.status).toBe(200);
  const html = await bootstrap.text();
  expect(html).not.toContain(f.handoff); expect(html).not.toContain("Approved app");
  expect(html).toContain("frame.sandbox='allow-scripts allow-forms allow-downloads'");
  expect(bootstrap.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(bootstrap.headers.get("cross-origin-opener-policy")).toBe("same-origin");
  const opened = await f.open(); expect(opened.html).toContain("Approved app"); expect(opened.html).not.toContain(opened.proof);
  expect((await f.post("/session", { handoff: f.handoff })).status).toBe(404);
  expect((await fetch(f.origin + "/backend.js")).status).toBe(404);
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
