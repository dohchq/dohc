import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  request as requestHttp,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { shareWebRefusalBody } from "./server";

const PUBLIC_HOST = "share.example.test";
const EXCHANGE_SECRET = Buffer.alloc(32, 11).toString("base64url");
const CAPABILITY_TOKEN = Buffer.alloc(32, 12).toString("base64url");
const BLOB_SHA = "a".repeat(64);
const PNG_CHUNK = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8,
]);
const children = new Set<ChildProcessWithoutNullStreams>();
const relayServers = new Set<Server>();

interface RunningShareWeb {
  child: ChildProcessWithoutNullStreams;
  port: number;
  stderr: () => string;
}

interface LinkSession {
  cookie: string;
  discriminator: string;
}

interface PendingBlobRequest {
  destroy: () => void;
  response: Promise<IncomingMessage>;
}

interface ControlledBlobRelay {
  url: string;
  finishBlob: (index: number) => void;
  finishAllBlobs: () => void;
  startBlob: (index: number) => void;
  waitForBlobCancellations: (count: number) => Promise<void>;
  waitForBlobRequests: (count: number) => Promise<void>;
}

type RawSocketResult =
  | { kind: "response"; raw: string; status: number | null }
  | { kind: "socket-close" }
  | { kind: "socket-error"; error: string };

afterEach(async () => {
  await Promise.all([...children].map(stopShareWeb));
  await Promise.all([...relayServers].map(stopRelay));
});

describe("share-web Node request adapter", () => {
  it("keeps serving after a request with an invalid Host authority", async () => {
    const server = await startShareWeb();

    const malformed = await sendRawRequest(
      server.port,
      "GET / HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n",
    );
    expect(isRefusalOrSocketClose(malformed)).toBe(true);

    const followUp = await sendRawRequest(
      server.port,
      `GET /not-found HTTP/1.1\r\nHost: ${PUBLIC_HOST}\r\nConnection: close\r\n\r\n`,
    );
    expect(
      followUp,
      `share-web stopped responding after the invalid Host request\n${server.stderr()}`,
    ).toMatchObject({ kind: "response", status: 404 });
  });

  it.each(["GET", "HEAD"] as const)(
    "drops body bytes from %s requests and keeps serving",
    async (method) => {
      const server = await startShareWeb();

      const malformed = await sendRawRequest(
        server.port,
        `${method} /not-found HTTP/1.1\r\n` +
          `Host: ${PUBLIC_HOST}\r\n` +
          "Content-Length: 4\r\n" +
          "Connection: close\r\n\r\ntest",
      );
      const followUp = await sendRawRequest(
        server.port,
        `GET /not-found HTTP/1.1\r\nHost: ${PUBLIC_HOST}\r\nConnection: close\r\n\r\n`,
      );

      expect(
        { malformed, followUp },
        `share-web did not adapt the ${method} request safely\n${server.stderr()}`,
      ).toMatchObject({
        malformed: { kind: "response", status: 404 },
        followUp: { kind: "response", status: 404 },
      });
    },
  );

  it("ignores X-Forwarded-For from an untrusted peer", async () => {
    const server = await startShareWeb();

    for (let exchangeNumber = 1; exchangeNumber <= 12; exchangeNumber += 1) {
      const response = await sendExchange(
        server.port,
        `198.51.100.${exchangeNumber}`,
      );
      expect(response, `exchange ${exchangeNumber}`).toMatchObject({
        kind: "response",
        status: 200,
      });
    }

    const limited = await sendExchange(server.port, "203.0.113.99");
    expect(limited).toMatchObject({ kind: "response", status: 404 });
  });

  it("uses the rightmost untrusted address from a trusted proxy", async () => {
    const server = await startShareWeb({ trustedProxies: "127.0.0.1,10.0.0.2" });

    for (let exchangeNumber = 1; exchangeNumber <= 12; exchangeNumber += 1) {
      const response = await sendExchange(
        server.port,
        `198.51.100.${exchangeNumber}, 203.0.113.5, 10.0.0.2`,
      );
      expect(response, `exchange ${exchangeNumber}`).toMatchObject({
        kind: "response",
        status: 200,
      });
    }

    const limited = await sendExchange(
      server.port,
      "198.51.100.99, 203.0.113.5, 10.0.0.2",
    );
    expect(limited).toMatchObject({ kind: "response", status: 404 });
  });

  it("keeps two forwarded clients in distinct buckets behind one trusted proxy", async () => {
    const server = await startShareWeb({ trustedProxies: "127.0.0.1" });

    for (let exchangeNumber = 1; exchangeNumber <= 12; exchangeNumber += 1) {
      const response = await sendExchange(server.port, "198.51.100.1");
      expect(response, `first client exchange ${exchangeNumber}`).toMatchObject({
        kind: "response",
        status: 200,
      });
    }

    const secondClient = await sendExchange(server.port, "198.51.100.2");
    expect(secondClient).toMatchObject({ kind: "response", status: 200 });
  });

  it("limits each session to 8 blob proxies and releases settled slots", async () => {
    const relay = await startControlledBlobRelay();
    const server = await startShareWeb({ relayUrl: relay.url });
    const session = await exchangeSession(server.port);
    const firstEight = Array.from({ length: 8 }, () =>
      requestBlob(server.port, session),
    );
    const ninth = requestBlob(server.port, session);
    let admitted: PendingBlobRequest | undefined;

    try {
      const ninthRelayRequest = relay.waitForBlobRequests(9);
      const outcome = await Promise.race([
        ninth.response.then((response) => ({ kind: "response" as const, response })),
        ninthRelayRequest.then(() => ({ kind: "proxied" as const })),
      ]);

      expect(outcome.kind).toBe("response");
      if (outcome.kind !== "response") return;
      expect(outcome.response.statusCode).toBe(429);
      expect(await readResponse(outcome.response)).toBe(shareWebRefusalBody);

      relay.finishBlob(0);
      const settled = await firstEight[0]!.response;
      expect(settled.statusCode).toBe(200);
      await readResponse(settled);

      admitted = requestBlob(server.port, session);
      await ninthRelayRequest;
      relay.finishBlob(8);
      const admittedResponse = await admitted.response;
      expect(admittedResponse.statusCode).toBe(200);
      await readResponse(admittedResponse);
    } finally {
      relay.finishAllBlobs();
      for (const blob of [...firstEight, ninth]) blob.destroy();
      admitted?.destroy();
    }
  });

  it("streams blob bytes before the relay finishes its body", async () => {
    const relay = await startControlledBlobRelay();
    const server = await startShareWeb({ relayUrl: relay.url });
    const session = await exchangeSession(server.port);
    const blobRequest = requestBlob(server.port, session);

    await relay.waitForBlobRequests(1);
    relay.startBlob(0);

    try {
      const firstChunk = blobRequest.response.then(async (response) => {
        expect(response.statusCode).toBe(200);
        return await readFirstChunk(response);
      });
      const observed = await settleWithin(firstChunk, 1_000);

      expect(observed.kind).toBe("settled");
      if (observed.kind !== "settled") return;
      expect(observed.value).toEqual(PNG_CHUNK);
      blobRequest.destroy();
      await relay.waitForBlobCancellations(1);
    } finally {
      blobRequest.destroy();
      relay.finishAllBlobs();
    }
  });
});

async function startShareWeb(
  options: { relayUrl?: string; trustedProxies?: string } = {},
): Promise<RunningShareWeb> {
  const relayUrl = options.relayUrl ?? (await startRelay());
  const env = { ...process.env };
  delete env.DOHC_SHARE_WEB_TRUSTED_PROXIES;
  if (options.trustedProxies !== undefined) {
    env.DOHC_SHARE_WEB_TRUSTED_PROXIES = options.trustedProxies;
  }
  const child = spawn(
    process.execPath,
    ["--import", "tsx", fileURLToPath(new URL("./main.ts", import.meta.url))],
    {
      env: {
        ...env,
        NODE_ENV: "test",
        DOHC_SHARE_WEB_DEV: "1",
        DOHC_SHARE_WEB_RELAY_URL: relayUrl,
        DOHC_SHARE_WEB_PUBLIC_HOSTS: PUBLIC_HOST,
        DOHC_SHARE_WEB_PORT: "0",
        DOHC_SHARE_WEB_BIND: "127.0.0.1",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  children.add(child);
  child.stdin.end();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`share-web did not start\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 5_000);
    const inspectStdout = (): void => {
      const match = /SHARE_WEB_LISTENING host=[^ ]+ port=(\d+)/u.exec(stdout);
      if (!match) return;
      clearTimeout(timeout);
      child.stdout.off("data", inspectStdout);
      resolve(Number(match[1]));
    };
    child.stdout.on("data", inspectStdout);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `share-web exited before listening (code=${String(code)}, signal=${String(signal)})\n` +
            `stdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    });
  });

  return { child, port, stderr: () => stderr };
}

async function exchangeSession(port: number): Promise<LinkSession> {
  const requestBody = JSON.stringify({ secret: EXCHANGE_SECRET });
  const response = await sendHttpRequest(port, "/api/exchange", {
    method: "POST",
    headers: {
      host: PUBLIC_HOST,
      "content-type": "application/json",
      "content-length": Buffer.byteLength(requestBody),
    },
    body: requestBody,
  });
  expect(response.statusCode).toBe(200);
  const body = JSON.parse(await readResponse(response)) as { session: string };
  const setCookie = response.headers["set-cookie"]?.[0];
  expect(setCookie).toBeDefined();
  return {
    cookie: setCookie!.split(";", 1)[0]!,
    discriminator: body.session,
  };
}

function requestBlob(port: number, session: LinkSession): PendingBlobRequest {
  let resolveResponse: (response: IncomingMessage) => void = () => undefined;
  let rejectResponse: (error: Error) => void = () => undefined;
  const response = new Promise<IncomingMessage>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  void response.catch(() => undefined);
  const request = requestHttp(
    {
      host: "127.0.0.1",
      port,
      path: `/api/view/blob/${BLOB_SHA}?session=${session.discriminator}`,
      headers: { host: PUBLIC_HOST, cookie: session.cookie },
    },
    resolveResponse,
  );
  request.once("error", rejectResponse);
  request.end();
  return { destroy: () => request.destroy(), response };
}

function sendHttpRequest(
  port: number,
  path: string,
  options: { body?: string; headers: Record<string, string | number>; method: string },
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = requestHttp(
      { host: "127.0.0.1", port, path, ...options },
      resolve,
    );
    request.once("error", reject);
    request.end(options.body);
  });
}

function readResponse(response: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    response.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    response.once("error", reject);
  });
}

function readFirstChunk(response: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    response.once("data", (chunk: Buffer) => resolve(Buffer.from(chunk)));
    response.once("end", () => reject(new Error("blob response ended without bytes")));
    response.once("error", reject);
  });
}

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ kind: "settled"; value: T } | { kind: "timeout" }> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<{ kind: "timeout" }>((resolve) => {
    timeout = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
  });
  try {
    return await Promise.race([
      promise.then((value) => ({ kind: "settled" as const, value })),
      timedOut,
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function startRelay(): Promise<string> {
  const server = createServer((request, response) => {
    request.resume();
    if (request.method !== "POST" || request.url !== "/sync/link-exchange") {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        ok: true,
        grantId: "grant-integration",
        capabilityToken: CAPABILITY_TOKEN,
        capabilityExpiresAtMs: Date.now() + 60_000,
      }),
    );
  });
  relayServers.add(server);
  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error): void => reject(error);
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", fail);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test relay did not bind to a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function startControlledBlobRelay(): Promise<ControlledBlobRelay> {
  const blobResponses: ServerResponse[] = [];
  let blobCancellations = 0;
  const cancellationWaiters: Array<{ count: number; resolve: () => void }> = [];
  const requestWaiters: Array<{ count: number; resolve: () => void }> = [];
  const notifyWaiters = (
    waiters: Array<{ count: number; resolve: () => void }>,
    observed: number,
  ): void => {
    for (const waiter of waiters.splice(0)) {
      if (observed >= waiter.count) {
        waiter.resolve();
      } else {
        waiters.push(waiter);
      }
    }
  };
  const startBlob = (index: number): void => {
    const response = blobResponses[index];
    if (!response || response.writableEnded) return;
    if (!response.headersSent) {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.write(PNG_CHUNK);
    }
  };
  const finishBlob = (index: number): void => {
    const response = blobResponses[index];
    if (!response || response.writableEnded) return;
    startBlob(index);
    response.end();
  };
  const server = createServer((request, response) => {
    request.resume();
    if (request.method === "POST" && request.url === "/sync/link-exchange") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          ok: true,
          grantId: "grant-integration",
          capabilityToken: CAPABILITY_TOKEN,
          capabilityExpiresAtMs: Date.now() + 60_000,
        }),
      );
      return;
    }
    blobResponses.push(response);
    response.once("close", () => {
      if (response.writableEnded) return;
      blobCancellations += 1;
      notifyWaiters(cancellationWaiters, blobCancellations);
    });
    notifyWaiters(requestWaiters, blobResponses.length);
  });
  relayServers.add(server);
  await listenOnEphemeralPort(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("controlled test relay did not bind to a TCP port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    finishBlob,
    finishAllBlobs: () => {
      for (let index = 0; index < blobResponses.length; index += 1) {
        finishBlob(index);
      }
    },
    startBlob,
    waitForBlobCancellations: (count) => {
      if (blobCancellations >= count) return Promise.resolve();
      return new Promise<void>((resolve) =>
        cancellationWaiters.push({ count, resolve }),
      );
    },
    waitForBlobRequests: (count) => {
      if (blobResponses.length >= count) return Promise.resolve();
      return new Promise<void>((resolve) => requestWaiters.push({ count, resolve }));
    },
  };
}

async function listenOnEphemeralPort(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error): void => reject(error);
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", fail);
      resolve();
    });
  });
}

async function stopShareWeb(child: ChildProcessWithoutNullStreams): Promise<void> {
  children.delete(child);
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill();
  await exited;
}

async function stopRelay(server: Server): Promise<void> {
  relayServers.delete(server);
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function sendExchange(port: number, forwardedFor: string): Promise<RawSocketResult> {
  const body = JSON.stringify({ secret: EXCHANGE_SECRET });
  return sendRawRequest(
    port,
    "POST /api/exchange HTTP/1.1\r\n" +
      `Host: ${PUBLIC_HOST}\r\n` +
      "Content-Type: application/json\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      `X-Forwarded-For: ${forwardedFor}\r\n` +
      "Connection: close\r\n\r\n" +
      body,
  );
}

function sendRawRequest(port: number, request: string): Promise<RawSocketResult> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    let settled = false;
    const settle = (result: RawSocketResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    socket.once("connect", () => socket.write(request));
    socket.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    socket.once("error", (error) => {
      settle({ kind: "socket-error", error: error.message });
    });
    socket.once("close", () => {
      if (chunks.length === 0) {
        settle({ kind: "socket-close" });
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      const status = /^HTTP\/1\.1 (\d{3})/u.exec(raw);
      settle({
        kind: "response",
        raw,
        status: status ? Number(status[1]) : null,
      });
    });
  });
}

function isRefusalOrSocketClose(result: RawSocketResult): boolean {
  return result.kind === "response"
    ? result.status === 404
    : result.kind === "socket-close" || result.kind === "socket-error";
}
