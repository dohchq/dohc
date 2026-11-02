import { createServer, get, type RequestListener } from "node:http";
import { createConnection } from "node:net";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { startServerProxy } from "../../e2e/helpers/selfHostOnboarding";

async function withProxy(
  handle: RequestListener,
  run: (proxy: Awaited<ReturnType<typeof startServerProxy>>) => Promise<void>,
) {
  const upstream = createServer(handle);
  await new Promise<void>((resolve, reject) => { upstream.once("error", reject); upstream.listen(0, "127.0.0.1", resolve); });
  let proxy: Awaited<ReturnType<typeof startServerProxy>> | undefined;
  try {
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("Upstream did not bind a port.");
    proxy = await startServerProxy();
    proxy.routeRelayTo(`http://127.0.0.1:${address.port}`);
    await run(proxy);
  } finally {
    try { await proxy?.close(); } finally {
      upstream.closeAllConnections();
      await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
    }
  }
}

it("buffers only the chosen workspace and preserves the upstream status, headers and bytes", async () => {
  const body = Buffer.from([0, 255, 13, 10, 128]);
  await withProxy((_request, response) => {
    response.writeHead(207, "Real response", { "content-type": "application/octet-stream",
      "set-cookie": ["one=1", "two=2"], "x-upstream": "retained" });
    response.end(body);
  }, async proxy => {
    const barrier = proxy.holdNextHostedLogResponse("chosen");
    const other = await fetch(`${proxy.origin}/sync/other/hosted/log`);
    expect(Buffer.from(await other.arrayBuffer())).toEqual(body);
    let answered = false;
    const answer = fetch(`${proxy.origin}/sync/chosen/hosted/log`).then(response => { answered = true; return response; });
    try {
      const captured = await barrier.captured;
      expect(answered).toBe(false);
      expect(captured).toMatchObject({ status: 207, statusMessage: "Real response", body });
      barrier.release();
      await barrier.delivered;
      const response = await answer;
      expect(response.status).toBe(captured.status);
      expect(response.statusText).toBe(captured.statusMessage);
      expect(response.headers.getSetCookie()).toEqual(["one=1", "two=2"]);
      expect(response.headers.get("x-upstream")).toBe("retained");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(body);
    } finally { barrier.destroy(); }
  });
});

it("captures a sequential client's next real response when registered before release", async () => {
  let sequence = 0;
  await withProxy((_request, response) => response.end(String(++sequence)), async proxy => {
    const first = proxy.holdNextHostedLogResponse("chosen");
    const answers = (async () => {
      const one = await fetch(`${proxy.origin}/sync/chosen/hosted/log`);
      const firstBody = await one.text();
      const two = await fetch(`${proxy.origin}/sync/chosen/hosted/log`);
      return [firstBody, await two.text()];
    })();
    let next: ReturnType<typeof proxy.holdNextHostedLogResponse> | undefined;
    try {
      expect((await first.captured).body.toString()).toBe("1");
      next = proxy.holdNextHostedLogResponse("chosen");
      first.release();
      expect((await next.captured).body.toString()).toBe("2");
      next.release();
      await Promise.all([first.delivered, next.delivered]);
      expect(await answers).toEqual(["1", "2"]);
    } finally { first.destroy(); next?.destroy(); }
  });
});

it.each([false, true])("rejects the barrier on upstream failure (partial response=%s)", async partial => {
  await withProxy((_request, response) => {
    if (partial) { response.writeHead(200, { "content-length": "100" }); response.flushHeaders(); response.write("partial"); }
    response.destroy();
  }, async proxy => {
    const barrier = proxy.holdNextHostedLogResponse("chosen");
    const answer = fetch(`${proxy.origin}/sync/chosen/hosted/log`);
    try {
      await Promise.all([
        expect(barrier.captured).rejects.toBeInstanceOf(Error),
        expect(answer.then(response => response.arrayBuffer())).rejects.toBeInstanceOf(Error),
      ]);
    } finally { barrier.destroy(); }
  });
});

it("holds later pulls until release and forwards them through the next barrier", async () => {
  let chosen = 0;
  let marker!: () => void;
  const markerReached = new Promise<void>(resolve => { marker = resolve; });
  await withProxy((request, response) => {
    if (request.url === "/sync/other/hosted/log") { marker(); response.end("other"); }
    else response.end(String(++chosen));
  }, async proxy => {
    const first = proxy.holdNextHostedLogResponse("chosen");
    const answer = fetch(`${proxy.origin}/sync/chosen/hosted/log`);
    const socket = createConnection(Number(new URL(proxy.origin).port), "127.0.0.1");
    const connected = once(socket, "connect");
    socket.on("error", () => undefined);
    socket.resume();
    let next: ReturnType<typeof proxy.holdNextHostedLogResponse> | undefined;
    try {
      await first.captured;
      await connected;
      // HTTP parses these in order: reaching the other workspace proves the retry arrived.
      socket.write("GET /sync/chosen/hosted/log HTTP/1.1\r\nHost: proxy.test\r\n\r\n"
        + "GET /sync/other/hosted/log HTTP/1.1\r\nHost: proxy.test\r\n\r\n");
      await markerReached;
      expect(chosen).toBe(1);
      next = proxy.holdNextHostedLogResponse("chosen");
      first.release();
      await first.delivered;
      expect((await next.captured).body.toString()).toBe("2");
      next.release();
      await next.delivered;
      expect(await (await answer).text()).toBe("1");
      expect(chosen).toBe(2);
    } finally { socket.destroy(); first.destroy(); next?.destroy(); }
  });
});

it("reports an abandoned captured client and serves its retry through the next barrier", async () => {
  let requests = 0;
  await withProxy((_request, response) => response.end(String(++requests)), async proxy => {
    const first = proxy.holdNextHostedLogResponse("chosen");
    const request = get(`${proxy.origin}/sync/chosen/hosted/log`);
    request.on("error", () => undefined);
    let next: ReturnType<typeof proxy.holdNextHostedLogResponse> | undefined;
    try {
      await first.captured;
      request.destroy();
      await expect(first.delivered).rejects.toThrow("Hosted-log client closed before the captured response was delivered.");
      next = proxy.holdNextHostedLogResponse("chosen");
      const retry = fetch(`${proxy.origin}/sync/chosen/hosted/log`);
      first.release();
      expect((await next.captured).body.toString()).toBe("2");
      next.release();
      await next.delivered;
      expect(await (await retry).text()).toBe("2");
    } finally { request.destroy(); first.destroy(); next?.destroy(); }
  });
});

// #3089: T7 reads `delayMs` as one delay each way. A request body that
// arrives with its headers must not wait a second time. The proxy's clock is
// faked, so each leg is checked at its deadline and one millisecond before,
// and only loopback I/O runs for real.
it("delays a buffered POST once each way and keeps its chunks in order", async () => {
  const delayMs = 500;
  const ioTurn = () => new Promise<void>(resolve => setImmediate(resolve));
  const until = async (ready: () => boolean) => { while (!ready()) await ioTurn(); };
  const upstreamHeads: string[] = [];
  let received: string | undefined;
  let answer: (() => void) | undefined;
  await withProxy((incoming, response) => {
    upstreamHeads.push(`${incoming.method} ${incoming.url}`);
    const chunks: Buffer[] = [];
    incoming.on("data", chunk => chunks.push(Buffer.from(chunk)));
    incoming.once("end", () => {
      received = Buffer.concat(chunks).toString("utf8");
      answer = () => response.end("answered");
    });
  }, async proxy => {
    proxy.setDelayMs(delayMs);
    const client = createConnection(Number(new URL(proxy.origin).port), "127.0.0.1");
    const replied: Buffer[] = [];
    let closed = false;
    client.on("data", chunk => replied.push(Buffer.from(chunk)));
    client.once("close", () => { closed = true; });
    await once(client, "connect");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      // Headers and three body chunks reach the proxy in one write.
      client.write("POST /sync/workspace/push HTTP/1.1\r\nHost: proxy.test\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
        + "4\r\none,\r\n4\r\ntwo,\r\n5\r\nthree\r\n0\r\n\r\n");
      // The write arrives in one read, so its headers and body set their
      // timers together. A body delayed only after the headers go has none yet.
      await until(() => vi.getTimerCount() > 0);
      expect(vi.getTimerCount()).toBe(2);
      vi.advanceTimersByTime(delayMs - 1);
      expect(vi.getTimerCount()).toBe(2);
      expect(upstreamHeads).toEqual([]);
      vi.advanceTimersByTime(1);
      // At the deadline both leave together: no timer is left, and the
      // upstream gets the headers and the whole body.
      await until(() => received !== undefined || vi.getTimerCount() > 0);
      expect(received).toBe("one,two,three");
      expect(upstreamHeads).toEqual(["POST /sync/workspace/push"]);
      expect(vi.getTimerCount()).toBe(0);

      answer!();
      await until(() => vi.getTimerCount() === 2);
      vi.advanceTimersByTime(delayMs - 1);
      expect(vi.getTimerCount()).toBe(2);
      expect(replied).toEqual([]);
      vi.advanceTimersByTime(1);
      await until(() => closed || vi.getTimerCount() > 0);
      expect(closed).toBe(true);
      const reply = Buffer.concat(replied).toString("utf8");
      expect(reply).toMatch(/^HTTP\/1\.1 200 OK\r\n/u);
      expect(reply.slice(reply.indexOf("\r\n\r\n") + 4)).toBe("answered");
    } finally {
      vi.useRealTimers();
      client.destroy();
    }
  });
});
