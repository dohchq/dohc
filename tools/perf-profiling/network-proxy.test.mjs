import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
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
