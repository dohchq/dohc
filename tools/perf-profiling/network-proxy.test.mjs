import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, get } from "node:http";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { openNetworkProxy } from "./network-proxy.mjs";

async function fixture(t, response) {
  const server = createServer(response);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const proxy = await openNetworkProxy(`http://127.0.0.1:${server.address().port}`);
  t.after(async () => {
    await proxy.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return proxy;
}

test("shaping preserves status, authorization, query and response bytes", async (t) => {
  const body = Buffer.alloc(128 * 1024, 197);
  const proxy = await fixture(t, (request, response) => {
    assert.equal(request.headers.authorization, "Bearer fixture");
    assert.equal(request.url, "/path?scope=workspace");
    response.writeHead(201, { "Content-Type": "application/octet-stream" });
    response.end(body);
  });
  proxy.configure({ latencyMs: 2, bytesPerSecond: 10_000_000 });
  const response = await fetch(proxy.baseUrl + "/path?scope=workspace", { headers: { authorization: "Bearer fixture" } });
  assert.equal(response.status, 201);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), body);
  assert.equal(proxy.snapshot().bytes, body.length);
});

test("filters hop-by-hop headers in both directions while preserving the HTTP payload", async (t) => {
  let forwarded;
  const proxy = await fixture(t, (request, response) => {
    forwarded = request.headers;
    response.writeHead(201, {
      Connection: "X-Response-Hop, Keep-Alive",
      "X-Response-Hop": "private response hop",
      "Keep-Alive": "timeout=1234",
      "Proxy-Authenticate": "private proxy challenge",
      "Content-Type": "application/octet-stream",
      "X-End-To-End": "retained response",
    });
    response.end(Buffer.from([0, 127, 255]));
  });
  const response = await new Promise((resolve, reject) => {
    get(proxy.baseUrl, { headers: {
      Connection: "X-Request-Hop, Keep-Alive",
      "X-Request-Hop": "private request hop",
      "Keep-Alive": "timeout=1234",
      "Proxy-Authorization": "private proxy credential",
      "Proxy-Connection": "keep-alive",
      TE: "trailers",
      Authorization: "Bearer fixture",
      "X-End-To-End": "retained request",
    } }, async (response) => {
      try {
        const chunks = [];
        for await (const chunk of response) chunks.push(chunk);
        resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) });
      } catch (error) { reject(error); }
    }).once("error", reject);
  });
  assert.equal(forwarded["x-request-hop"], undefined);
  assert.equal(forwarded["proxy-authorization"], undefined);
  assert.equal(forwarded["proxy-connection"], undefined);
  assert.equal(forwarded.te, undefined);
  assert.notEqual(forwarded["keep-alive"], "timeout=1234");
  assert.equal(forwarded.authorization, "Bearer fixture");
  assert.equal(forwarded["x-end-to-end"], "retained request");
  assert.equal(response.headers["x-response-hop"], undefined);
  assert.equal(response.headers["proxy-authenticate"], undefined);
  assert.notEqual(response.headers["keep-alive"], "timeout=1234");
  assert.equal(response.headers["x-end-to-end"], "retained response");
  assert.equal(response.status, 201);
  assert.deepEqual(response.body, Buffer.from([0, 127, 255]));
});

test("fails one counted blob with a query string and then resumes", async (t) => {
  const proxy = await fixture(t, (_, response) => response.end("blob"));
  proxy.configure({ failBlobAt: 2 });
  const url = proxy.baseUrl + "/blobs/" + "a".repeat(64) + "?workspace=fixture";
  for (const status of [200, 503, 200]) {
    const response = await fetch(url);
    assert.equal(response.status, status);
    await response.text();
  }
  assert.deepEqual(proxy.snapshot(), { requests: 3, blobGets: 3, bytes: 8, failures: 1 });
});

test("close cancels a response still waiting for the bandwidth budget", async () => {
  const server = createServer((_, response) => response.end(Buffer.alloc(1024)));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const proxy = await openNetworkProxy(`http://127.0.0.1:${server.address().port}`);
  try {
    proxy.configure({ bytesPerSecond: 1 });
    const requested = once(server, "request");
    const response = fetch(proxy.baseUrl).then((response) => response.arrayBuffer());
    const refused = assert.rejects(response);
    await requested;
    await proxy.close();
    await refused;
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

for (const settings of [{ latencyMs: 60_000 }, { bytesPerSecond: 1 }]) {
  test(`downstream close cancels a pending shaped response ${JSON.stringify(settings)}`, async (t) => {
    const proxy = await fixture(t, (_, response) => response.end(Buffer.alloc(1024)));
    proxy.configure(settings);
    const downstream = get(proxy.baseUrl);
    downstream.on("error", () => {});
    const timeout = AbortSignal.timeout(2_000);
    try {
      while (proxy.pendingResponses() === 0) await setImmediate(undefined, { signal: timeout });
      const closed = new Promise((resolve) => downstream.once("close", resolve));
      downstream.destroy();
      await closed;
      await Promise.race([
        proxy.waitForResponses(),
        once(timeout, "abort").then(() => { throw new Error("Disconnected response did not settle"); }),
      ]);
      assert.equal(proxy.pendingResponses(), 0);
    } finally { downstream.destroy(); }
  });
}

test("canceling a response releases its unused bandwidth", async (t) => {
  const proxy = await fixture(t, (request, response) => response.end(Buffer.alloc(request.url === "/large" ? 1024 : 1)));
  proxy.configure({ bytesPerSecond: 100 });
  const downstream = get(proxy.baseUrl + "/large");
  downstream.on("error", () => {});
  t.after(() => downstream.destroy());
  const timeout = AbortSignal.timeout(2_000);
  while (proxy.pendingResponses() === 0) await setImmediate(undefined, { signal: timeout });
  const closed = new Promise((resolve) => downstream.once("close", resolve));
  downstream.destroy();
  await closed;
  const response = await fetch(proxy.baseUrl + "/small", { signal: timeout });
  assert.equal((await response.arrayBuffer()).byteLength, 1);
  assert.equal(proxy.snapshot().bytes, 1);
});

test("concurrent responses share the bandwidth budget", async (t) => {
  const proxy = await fixture(t, (_, response) => response.end(Buffer.alloc(100)));
  proxy.configure({ bytesPerSecond: 200 });
  const started = performance.now();
  await Promise.all([1, 2].map(async () => {
    const response = await fetch(proxy.baseUrl, { signal: AbortSignal.timeout(5_000) });
    assert.equal((await response.arrayBuffer()).byteLength, 100);
  }));
  assert.ok(performance.now() - started >= 950, "200 bytes must consume the shared 200-byte/second budget");
  assert.equal(proxy.snapshot().bytes, 200);
});

test("canceling a queued response settles before the active turn", async (t) => {
  const proxy = await fixture(t, (_, response) => response.end(Buffer.alloc(1024)));
  proxy.configure({ bytesPerSecond: 1 });
  const timeout = AbortSignal.timeout(2_000);
  const first = get(proxy.baseUrl);
  first.on("error", () => {});
  t.after(() => first.destroy());
  while (proxy.pendingResponses() !== 1) await setImmediate(undefined, { signal: timeout });
  const second = get(proxy.baseUrl);
  second.on("error", () => {});
  t.after(() => second.destroy());
  while (proxy.pendingResponses() !== 2) await setImmediate(undefined, { signal: timeout });
  second.destroy();
  while (proxy.pendingResponses() !== 1) await setImmediate(undefined, { signal: timeout });
  assert.equal(proxy.snapshot().bytes, 0);
});

test("a canceled queued turn does not let its successor bypass active bandwidth", async (t) => {
  const proxy = await fixture(t, (request, response) => response.end(Buffer.alloc(request.url === "/cancel" ? 1024 : 100)));
  proxy.configure({ bytesPerSecond: 200 });
  const timeout = AbortSignal.timeout(5_000);
  const started = performance.now();
  const first = fetch(proxy.baseUrl, { signal: timeout }).then((response) => response.arrayBuffer());
  while (proxy.pendingResponses() !== 1) await setImmediate(undefined, { signal: timeout });
  const canceled = get(proxy.baseUrl + "/cancel");
  canceled.on("error", () => {});
  t.after(() => canceled.destroy());
  while (proxy.pendingResponses() !== 2) await setImmediate(undefined, { signal: timeout });
  canceled.destroy();
  while (proxy.pendingResponses() !== 1) await setImmediate(undefined, { signal: timeout });
  const last = fetch(proxy.baseUrl, { signal: timeout }).then((response) => response.arrayBuffer());
  const bodies = await Promise.all([first, last]);
  assert.deepEqual(bodies.map((body) => body.byteLength), [100, 100]);
  assert.ok(performance.now() - started >= 950, "the successor must consume bandwidth after the active response");
  assert.equal(proxy.snapshot().bytes, 200);
});
