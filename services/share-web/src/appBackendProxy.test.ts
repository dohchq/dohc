import { expect, it } from "vitest";
import { APP_BACKEND_REQUEST_BYTES, APP_BACKEND_UPLOAD_BYTES, APP_BACKEND_UPLOAD_REQUEST_BYTES } from "@dohc/security-contract/app-backend";
import { forwardAppBackend } from "./appBackendProxy";

const invoke = { id: "one", op: "backend.invoke", operation: "register", idempotencyKey: "attempt-1", input: { quantity: 2 } };
const file = { fileId: "file_0123456789abcdef", name: "receipt.pdf", contentType: "application/pdf", byteLength: 4, sha256: "a".repeat(64) };
const upload = { id: "one", op: "backend.upload", idempotencyKey: "upload-1", name: file.name, contentType: file.contentType, bytesBase64: "JVBERg==" };
const readFile = { id: "one", op: "backend.file", fileId: file.fileId, operation: "receipt.read", input: { registrationId: "registration-1" } };

function forward(body: unknown, fetchRelay: (request: Request) => Promise<Response>, contentType = "application/json", signal = new AbortController().signal) {
  return forwardAppBackend({
    request: new Request("https://app.example.net/backend", { method: "POST", body: JSON.stringify(body), headers: { "content-type": contentType, cookie: "app=cookie", "x-dohc-app-proof": "proof", authorization: "Bearer attacker" } }),
    relayUrl: "https://relay.example.org", publicationId: "a".repeat(64), authorityRevision: 7,
    capability: "server-cap", profileSecret: "server-profile", signal, fetchRelay,
  });
}

it("forwards to fixed backend routes with launch authority and no browser credentials", async () => {
  for (const [body, action, expected, reply] of [
    [invoke, "invoke", { authorityRevision: 7, operation: "register", idempotencyKey: "attempt-1", input: { quantity: 2 } }, { result: { registrationId: "registration-1" }, revision: 1, replayed: false }],
    [upload, "upload", { authorityRevision: 7, idempotencyKey: "upload-1", name: file.name, contentType: file.contentType, bytesBase64: "JVBERg==" }, { file, replayed: false }],
    [readFile, "file", { authorityRevision: 7, fileId: file.fileId, operation: "receipt.read", input: readFile.input }, { file, bytesBase64: "JVBERg==" }],
  ] as const) {
    const response = await forward(body, async request => {
      expect(request.url).toBe(`https://relay.example.org/sync/link/app-publications/${"a".repeat(64)}/backend/${action}`);
      expect(request.method).toBe("POST"); expect(request.redirect).toBe("manual");
      expect(Object.fromEntries(request.headers)).toEqual({ authorization: "LinkCapability server-cap", "content-type": "application/json", "x-dohc-link-profile-secret": "server-profile" });
      expect(await request.json()).toEqual(expected);
      return Response.json(reply);
    });
    expect(response.status).toBe(200); expect(await response.json()).toEqual(reply);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.has("content-disposition")).toBe(false);
  }
});

it("rejects caller identities, authority revisions, paths, and other extra input before relay access", async () => {
  let calls = 0; const relay = async () => { calls++; return Response.json({ result: null, revision: 1, replayed: false }); };
  for (const body of [
    { ...invoke, authorityRevision: 99 }, { ...invoke, caller: { kind: "owner", userId: "owner" } },
    { ...invoke, url: "https://private" }, { ...invoke, operation: "constructor" }, { ...invoke, idempotencyKey: "" },
    { ...upload, path: "private/receipt.pdf" }, { ...upload, fileId: file.fileId }, { ...upload, name: "../receipt" },
    { ...readFile, idempotencyKey: "extra" }, { ...readFile, fileId: "../private" },
    { ...readFile, readOnly: false }, { ...readFile, operation: "__proto__" },
    { ...invoke, op: "collection.create" }, { ...invoke, id: "one\n" },
  ]) expect((await forward(body, relay)).status).toBe(400);
  expect((await forward(invoke, relay, "text/plain")).status).toBe(400);
  expect(calls).toBe(0);
});

it("bounds operation bodies separately from file uploads", async () => {
  let calls = 0; const relay = async () => { calls++; return Response.json({ file, replayed: false }); };
  expect((await forward({ ...invoke, input: "x".repeat(APP_BACKEND_REQUEST_BYTES) }, relay)).status).toBe(413);
  expect((await forward({ ...upload, bytesBase64: "x".repeat(APP_BACKEND_UPLOAD_REQUEST_BYTES) }, relay)).status).toBe(413);
  expect((await forward({ ...upload, bytesBase64: Buffer.alloc(APP_BACKEND_UPLOAD_BYTES + 1).toString("base64") }, relay)).status).toBe(400);
  expect(calls).toBe(0);
  expect((await forward({ ...upload, bytesBase64: Buffer.alloc(APP_BACKEND_UPLOAD_BYTES).toString("base64") }, relay)).status).toBe(200);
});

it("preserves refusals and conflicts while hiding authentication details and server errors", async () => {
  for (const status of [400, 401, 403, 404, 409, 413, 429, 500]) {
    let cancelled = false;
    const response = await forward(invoke, async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status }));
    expect(response.status).toBe(status === 401 || status === 403 ? 404 : status === 500 ? 503 : status);
    expect(cancelled).toBe(true);
  }
  expect((await forward(invoke, async () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example" } }))).status).toBe(503);
  expect((await forward(invoke, async () => { throw Error("connection failed"); })).status).toBe(503);
});

it("rejects malformed envelopes and prototype-bearing operation results", async () => {
  for (const value of [
    { result: null, revision: 1, replayed: false, capability: "secret" },
    { result: {}, revision: -1, replayed: false }, { result: {}, revision: 1, replayed: "false" },
    { result: JSON.parse('{"constructor":"bad"}'), revision: 1, replayed: false },
  ]) expect((await forward(invoke, async () => Response.json(value))).status).toBe(503);
  expect((await forward(upload, async () => Response.json({ file, replayed: false, caller: "owner" }))).status).toBe(503);
  expect((await forward(upload, async () => Response.json({ file: { ...file, path: "private" }, replayed: false }))).status).toBe(503);
});

it("checks file identity, byte length, and encoding before returning a file", async () => {
  for (const value of [
    { file: { ...file, fileId: "another_0123456789abcdef" }, bytesBase64: "JVBERg==" },
    { file: { ...file, byteLength: 5 }, bytesBase64: "JVBERg==" },
    { file, bytesBase64: "JVBERh==" }, { file, bytesBase64: "JVBERg==", url: "https://private" },
  ]) expect((await forward(readFile, async () => Response.json(value))).status).toBe(503);
  const bytesBase64 = Buffer.alloc(APP_BACKEND_UPLOAD_BYTES).toString("base64");
  expect((await forward(readFile, async () => Response.json({ file: { ...file, byteLength: APP_BACKEND_UPLOAD_BYTES }, bytesBase64 }))).status).toBe(200);
});

it("bounds relay bodies and refuses a response after launch cancellation", async () => {
  expect((await forward(invoke, async () => new Response("x".repeat(1024 * 1024 + 1)))).status).toBe(503);
  expect((await forward(readFile, async () => new Response("x".repeat(APP_BACKEND_UPLOAD_REQUEST_BYTES + 1)))).status).toBe(503);
  const controller = new AbortController();
  const response = await forward(invoke, async () => { controller.abort(); return Response.json({ result: null, revision: 1, replayed: false }); }, "application/json", controller.signal);
  expect(response.status).toBe(503);
});
