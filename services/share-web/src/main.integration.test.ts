import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  request as requestHttp,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { EXCHANGE_BUCKET_CAPACITY, shareWebRefusalBody } from "./server";

const PUBLIC_HOST = "share.example.test";
const MAX_REQUEST_BODY_BYTES = 16 * 1024;
const MAX_EXCHANGE_BODY_BYTES = 8 * 1024;
const EXCHANGE_SECRET = Buffer.alloc(32, 11).toString("base64url");
const CAPABILITY_TOKEN = Buffer.alloc(32, 12).toString("base64url");
const BLOB_SHA = "a".repeat(64);
const TEST_SHUTDOWN_GRACE_PERIOD_MS = 250;
const WITHIN_SHUTDOWN_GRACE_MS = 100;
const FORCED_SHUTDOWN_TIMEOUT_MS = 2_000;
const STOP_SHARE_WEB_DEADLINE_MS = 13_000;
const SIGKILL_EXIT_TIMEOUT_MS = 1_000;
const CLEANUP_HOOK_TIMEOUT_MS =
  STOP_SHARE_WEB_DEADLINE_MS + SIGKILL_EXIT_TIMEOUT_MS + 2_000;
const MISSING_VIEWER_ASSETS_MESSAGE =
  "share-web viewer assets are missing. Run: pnpm --filter @dohc/share-web build";
const VIEWER_HTML = "<!doctype html><title>share-web viewer fixture</title>";
const PNG_CHUNK = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8,
]);
const JSON_FIRST_CHUNK = Buffer.from('{"ok":true,"payload":"');
const JSON_FINAL_CHUNK = Buffer.concat([
  Buffer.alloc(1024 * 1024, "x"),
  Buffer.from('"}'),
]);
const children = new Set<ChildProcessWithoutNullStreams>();
const relayServers = new Set<Server>();
const viewerAssetRoots = new Set<string>();

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

interface StreamingRequest {
  destroy: () => void;
  finishBody: () => void;
  response: Promise<RawSocketResult>;
}

interface ControlledBlobRelay {
  url: string;
  finishBlob: (index: number) => void;
  finishAllBlobs: () => void;
  startBlob: (index: number) => void;
  waitForBlobCancellations: (count: number) => Promise<void>;
  waitForBlobRequests: (count: number) => Promise<void>;
}

interface ControlledJsonRelay {
  finishAllResponses: () => void;
  finishResponse: (index: number) => void;
  startResponse: (index: number) => void;
  url: string;
  waitForRequests: (count: number) => Promise<void>;
}

type RawSocketResult =
  | { kind: "response"; raw: string; status: number | null }
  | { kind: "socket-close" }
  | { kind: "socket-error"; error: string };

afterEach(async () => {
  try {
    await Promise.all([...children].map(stopShareWeb));
  } finally {
    await Promise.all([...relayServers].map(stopRelay));
    await Promise.all(
      [...viewerAssetRoots].map((root) => rm(root, { recursive: true, force: true })),
    );
    viewerAssetRoots.clear();
  }
}, CLEANUP_HOOK_TIMEOUT_MS);

describe("share-web Node request adapter", () => {
  it.each([
    ["with development mode enabled", true],
    ["with development mode disabled", false],
  ] as const)(
    "fails startup %s when viewer assets are missing",
    async (mode, devMode) => {
      const viewerAssetsDir = await createViewerAssets(false);
      let server: RunningShareWeb;
      try {
        server = await startShareWeb({ devMode, viewerAssetsDir });
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(
          "share-web exited before listening (code=1, signal=null)\n" +
            "stdout:\n\n" +
            `stderr:\n${MISSING_VIEWER_ASSETS_MESSAGE}\n`,
        );
        return;
      }

      const response = await sendHttpRequest(server.port, "/s/missing-viewer", {
        method: "GET",
        headers: { host: PUBLIC_HOST },
      });
      const body = await readResponse(response);
      throw new Error(
        `share-web started ${mode} with empty viewer assets; ` +
          `GET /s/missing-viewer returned ${String(response.statusCode)} ${JSON.stringify(body)}\n` +
          `expected stderr:\n${MISSING_VIEWER_ASSETS_MESSAGE}\n`,
      );
    },
  );

  it("starts in development mode and serves present viewer assets", async () => {
    const viewerAssetsDir = await createViewerAssets(true);
    const server = await startShareWeb({ devMode: true, viewerAssetsDir });

    const response = await sendHttpRequest(server.port, "/s/present-viewer", {
      method: "GET",
      headers: { host: PUBLIC_HOST },
    });

    expect(response.statusCode).toBe(200);
    expect(await readResponse(response)).toBe(VIEWER_HTML);
  });

  it("force-closes a stalled blob response after the shutdown grace period", async () => {
    const relay = await startControlledBlobRelay();
    const server = await startShareWeb({
      relayUrl: relay.url,
      shutdownGracePeriodMs: TEST_SHUTDOWN_GRACE_PERIOD_MS,
    });
    const session = await exchangeSession(server.port);
    const blobRequest = requestBlob(server.port, session);

    await relay.waitForBlobRequests(1);
    relay.startBlob(0);
    const response = await blobRequest.response;
    expect(response.statusCode).toBe(200);
    expect(await readFirstChunk(response)).toEqual(PNG_CHUNK);

    try {
      const exited = waitForExit(server.child);
      sendTerminationSignal(server.child);

      expect(
        await settleWithin(exited, WITHIN_SHUTDOWN_GRACE_MS),
        `share-web exited before its shutdown grace period\n${server.stderr()}`,
      ).toEqual({ kind: "timeout" });
      const forcedExit = await settleWithin(exited, FORCED_SHUTDOWN_TIMEOUT_MS);
      expect(
        forcedExit,
        `share-web remained alive after its shutdown grace period\n${server.stderr()}`,
      ).toEqual({
        kind: "settled",
        value: { code: 0, signal: null },
      });
    } finally {
      response.destroy();
      blobRequest.destroy();
      relay.finishAllBlobs();
    }
  }, 5_000);

  it("shuts down promptly when no responses are active", async () => {
    const server = await startShareWeb();
    const exited = waitForExit(server.child);

    sendTerminationSignal(server.child);

    expect(
      await settleWithin(exited, 1_000),
      `quiet share-web did not exit promptly\n${server.stderr()}`,
    ).toEqual({
      kind: "settled",
      value: { code: 0, signal: null },
    });
  });

  it("survives a response error during a pipe and cancels the source stream", async () => {
    const relay = await startControlledBlobRelay();
    const server = await startShareWeb({
      relayUrl: relay.url,
      responseErrorDuringPipe: true,
    });
    const session = await exchangeSession(server.port);
    const blobRequest = requestBlob(server.port, session, true);

    await relay.waitForBlobRequests(1);
    relay.startBlob(0);

    try {
      expect(
        await settleWithin(relay.waitForBlobCancellations(1), 1_000),
        `share-web did not cancel the source stream after a response error\n${server.stderr()}`,
      ).toEqual({ kind: "settled", value: undefined });
      const followUp = await sendHttpRequest(server.port, "/not-found", {
        method: "GET",
        headers: { host: PUBLIC_HOST },
      });
      expect(followUp.statusCode).toBe(404);
      await readResponse(followUp);
    } finally {
      blobRequest.destroy();
      relay.finishAllBlobs();
    }
  });

  it("refuses and closes a streaming request as soon as it crosses the body cap", async () => {
    const server = await startShareWeb();
    const upload = streamChunkedRequestWithoutEnd(
      server.port,
      Buffer.alloc(MAX_REQUEST_BODY_BYTES + 1, "x"),
    );

    try {
      const beforeEnd = await settleWithin(upload.response, 1_000);
      if (beforeEnd.kind === "timeout") {
        upload.finishBody();
        const afterEnd = await settleWithin(upload.response, 1_000);
        const afterEndResult =
          afterEnd.kind === "settled"
            ? `${afterEnd.value.kind}${
                afterEnd.value.kind === "response"
                  ? ` status=${String(afterEnd.value.status)}`
                  : ""
              }`
            : "timeout";
        throw new Error(
          "oversized upload received no response within 1000 ms before request end; " +
            `after sending end: ${afterEndResult}\n${server.stderr()}`,
        );
      }

      expect(beforeEnd.value).toMatchObject({ kind: "response", status: 404 });
      if (beforeEnd.value.kind !== "response") return;
      expect(beforeEnd.value.raw).toContain(shareWebRefusalBody);
      expect(beforeEnd.value.raw).toMatch(
        /\r\nx-robots-tag: noindex, nofollow, noarchive\r\n/iu,
      );
      expect(beforeEnd.value.raw).toMatch(/\r\nconnection: close\r\n/iu);

      for (
        let exchangeNumber = 1;
        exchangeNumber <= EXCHANGE_BUCKET_CAPACITY;
        exchangeNumber += 1
      ) {
        const response = await sendExchange(server.port, "198.51.100.1");
        expect(response, `follow-up exchange ${exchangeNumber}`).toMatchObject({
          kind: "response",
          status: 200,
        });
      }
    } finally {
      upload.destroy();
    }
  });

  // The GET covers the 16 KiB adapter cap; the POST covers the 8 KiB exchange-handler cap.
  it("accepts a request body exactly at the cap", async () => {
    const relay = await startControlledJsonRelay();
    const server = await startShareWeb({ relayUrl: relay.url });
    const session = await exchangeSession(server.port);
    const requestBody = "x".repeat(MAX_REQUEST_BODY_BYTES);
    expect(Buffer.byteLength(requestBody)).toBe(MAX_REQUEST_BODY_BYTES);

    const responsePromise = sendHttpRequest(server.port, "/api/view/meta", {
      method: "GET",
      headers: {
        host: PUBLIC_HOST,
        cookie: session.cookie,
        "x-dohc-link-session": session.discriminator,
        "content-length": Buffer.byteLength(requestBody),
      },
      body: requestBody,
    });

    try {
      const admission = await settleWithin(
        Promise.race([
          relay.waitForRequests(1).then(() => ({ kind: "relayed" as const })),
          responsePromise.then((response) => ({
            kind: "response" as const,
            response,
          })),
        ]),
        1_000,
      );
      if (admission.kind === "timeout") {
        throw new Error("exact-cap request neither reached the relay nor responded within 1000 ms");
      }
      if (admission.value.kind === "response") {
        const status = admission.value.response.statusCode;
        await readResponse(admission.value.response);
        throw new Error(
          `exact-cap request responded with status ${String(status)} before reaching the relay`,
        );
      }
      relay.finishResponse(0);
      const response = await responsePromise;
      expect(response.statusCode).toBe(200);
      await readResponse(response);
    } finally {
      relay.finishAllResponses();
    }
  });

  it("forwards an exchange body exactly at the handler cap", async () => {
    const receivedExchangeBodies: Buffer[] = [];
    const relayUrl = await startRelay((body) => receivedExchangeBodies.push(body));
    const server = await startShareWeb({ relayUrl });
    const requestPrefix = '{"padding":"';
    const requestSuffix = `","secret":"${EXCHANGE_SECRET}"}`;
    const requestBody =
      requestPrefix +
      "x".repeat(
        MAX_EXCHANGE_BODY_BYTES -
          Buffer.byteLength(requestPrefix) -
          Buffer.byteLength(requestSuffix),
      ) +
      requestSuffix;
    const expectedRelayBody = JSON.stringify({ secret: EXCHANGE_SECRET });
    expect(Buffer.byteLength(requestBody)).toBe(MAX_EXCHANGE_BODY_BYTES);

    const response = await sendHttpRequest(server.port, "/api/exchange", {
      method: "POST",
      headers: {
        host: PUBLIC_HOST,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(requestBody),
      },
      body: requestBody,
    });

    expect(response.statusCode).toBe(200);
    await readResponse(response);
    expect(receivedExchangeBodies).toHaveLength(1);
    expect(receivedExchangeBodies[0]?.length).toBe(
      Buffer.byteLength(expectedRelayBody),
    );
    expect(receivedExchangeBodies[0]?.toString("utf8")).toBe(expectedRelayBody);
  });

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

    for (
      let exchangeNumber = 1;
      exchangeNumber <= EXCHANGE_BUCKET_CAPACITY;
      exchangeNumber += 1
    ) {
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

    for (
      let exchangeNumber = 1;
      exchangeNumber <= EXCHANGE_BUCKET_CAPACITY;
      exchangeNumber += 1
    ) {
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

    for (
      let exchangeNumber = 1;
      exchangeNumber <= EXCHANGE_BUCKET_CAPACITY;
      exchangeNumber += 1
    ) {
      const response = await sendExchange(server.port, "198.51.100.1");
      expect(response, `first client exchange ${exchangeNumber}`).toMatchObject({
        kind: "response",
        status: 200,
      });
    }

    const secondClient = await sendExchange(server.port, "198.51.100.2");
    expect(secondClient).toMatchObject({ kind: "response", status: 200 });
  });

  // Eight real concurrent streams through the spawned adapter: under full
  // package-suite parallelism the default 5s budget starves (twice observed;
  // isolated it finishes in <200ms). The wider budget is capacity, not a wait.
  it("limits each session to 8 blob proxies and releases settled slots", { timeout: 30_000 }, async () => {
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
      const settled = await Promise.race(firstEight.map((blob) => blob.response));
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

  it.each([
    ["meta", "/api/view/meta"],
    ["log", "/api/view/log?since=0&limit=500"],
  ] as const)(
    "streams %s bytes before the relay finishes its body",
    async (_route, path) => {
      const relay = await startControlledJsonRelay();
      const server = await startShareWeb({ relayUrl: relay.url });
      const session = await exchangeSession(server.port);
      const viewRequest = requestView(server.port, session, path);

      await relay.waitForRequests(1);
      relay.startResponse(0);

      try {
        const firstChunk = viewRequest.response.then(async (response) => {
          expect(response.statusCode).toBe(200);
          expect(response.headers["content-type"]).toBe("application/json");
          const completeBody = readResponse(response);
          return {
            completeBody,
            firstChunk: await readFirstChunk(response),
          };
        });
        const observed = await settleWithin(firstChunk, 1_000);

        expect(observed.kind).toBe("settled");
        if (observed.kind !== "settled") return;
        expect(observed.value.firstChunk).toEqual(JSON_FIRST_CHUNK);

        relay.finishResponse(0);
        expect(await observed.value.completeBody).toBe(
          Buffer.concat([JSON_FIRST_CHUNK, JSON_FINAL_CHUNK]).toString("utf8"),
        );
      } finally {
        viewRequest.destroy();
        relay.finishAllResponses();
      }
    },
  );
});

async function startShareWeb(
  options: {
    devMode?: boolean;
    relayUrl?: string;
    responseErrorDuringPipe?: boolean;
    shutdownGracePeriodMs?: number;
    trustedProxies?: string;
    viewerAssetsDir?: string;
  } = {},
): Promise<RunningShareWeb> {
  const relayUrl = options.relayUrl ?? (await startRelay());
  // The adapter refuses to start without viewer assets, and a fresh checkout
  // has no built viewer/dist — every spawn injects a fixture through the test
  // seam so the suite never depends on a Vite build artifact.
  const viewerAssetsDir =
    options.viewerAssetsDir ?? (await createViewerAssets(true));
  const env = { ...process.env };
  delete env.DOHC_SHARE_WEB_DEV;
  delete env.DOHC_SHARE_WEB_TEST_RESPONSE_ERROR_DURING_PIPE;
  delete env.DOHC_SHARE_WEB_TEST_SHUTDOWN_GRACE_PERIOD_MS;
  delete env.DOHC_SHARE_WEB_TEST_VIEWER_ASSETS_DIR;
  delete env.DOHC_SHARE_WEB_TRUSTED_PROXIES;
  if (options.devMode !== false) env.DOHC_SHARE_WEB_DEV = "1";
  if (options.responseErrorDuringPipe === true) {
    env.DOHC_SHARE_WEB_TEST_RESPONSE_ERROR_DURING_PIPE = "1";
  }
  if (options.shutdownGracePeriodMs !== undefined) {
    env.DOHC_SHARE_WEB_TEST_SHUTDOWN_GRACE_PERIOD_MS = String(
      options.shutdownGracePeriodMs,
    );
  }
  if (options.trustedProxies !== undefined) {
    env.DOHC_SHARE_WEB_TRUSTED_PROXIES = options.trustedProxies;
  }
  env.DOHC_SHARE_WEB_TEST_VIEWER_ASSETS_DIR = viewerAssetsDir;
  const mainUrl = new URL("./main.ts", import.meta.url);
  const childArguments =
    process.platform === "win32"
      ? [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          `process.on("message", (message) => { if (message === "SIGTERM") process.emit("SIGTERM"); }); await import(${JSON.stringify(mainUrl.href)});`,
        ]
      : ["--import", "tsx", fileURLToPath(mainUrl)];
  const child = spawn(
    process.execPath,
    childArguments,
    {
      env: {
        ...env,
        NODE_ENV: "test",
        DOHC_SHARE_WEB_RELAY_URL: relayUrl,
        DOHC_SHARE_WEB_PUBLIC_RELAY_URL: relayUrl,
        DOHC_SHARE_WEB_PUBLIC_HOSTS: PUBLIC_HOST,
        DOHC_SHARE_WEB_PORT: "0",
        DOHC_SHARE_WEB_BIND: "127.0.0.1",
      },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      windowsHide: true,
    },
  ) as ChildProcessWithoutNullStreams;
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
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      children.delete(child);
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

async function createViewerAssets(withIndex: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dohc-share-web-viewer-"));
  viewerAssetRoots.add(root);
  if (withIndex) await writeFile(join(root, "index.html"), VIEWER_HTML);
  return root;
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

function requestBlob(
  port: number,
  session: LinkSession,
  responseErrorDuringPipe = false,
): PendingBlobRequest {
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
      headers: {
        host: PUBLIC_HOST,
        cookie: session.cookie,
        ...(responseErrorDuringPipe
          ? { "x-dohc-test-response-error": "1" }
          : {}),
      },
    },
    resolveResponse,
  );
  request.once("error", rejectResponse);
  request.end();
  return { destroy: () => request.destroy(), response };
}

function requestView(
  port: number,
  session: LinkSession,
  path: string,
): PendingBlobRequest {
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
      path,
      headers: {
        host: PUBLIC_HOST,
        cookie: session.cookie,
        "x-dohc-link-session": session.discriminator,
      },
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

async function startRelay(onExchangeBody?: (body: Buffer) => void): Promise<string> {
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/sync/link-exchange") {
      request.resume();
      response.statusCode = 404;
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      onExchangeBody?.(Buffer.concat(chunks));
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          ok: true,
          grantId: "grant-integration",
          capabilityToken: CAPABILITY_TOKEN,
          capabilityExpiresAtMs: Date.now() + 15 * 60_000,
        }),
      );
    });
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
          capabilityExpiresAtMs: Date.now() + 15 * 60_000,
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

async function startControlledJsonRelay(): Promise<ControlledJsonRelay> {
  const responses: ServerResponse[] = [];
  const requestWaiters: Array<{ count: number; resolve: () => void }> = [];
  const notifyRequestWaiters = (): void => {
    for (const waiter of requestWaiters.splice(0)) {
      if (responses.length >= waiter.count) {
        waiter.resolve();
      } else {
        requestWaiters.push(waiter);
      }
    }
  };
  const startResponse = (index: number): void => {
    const response = responses[index];
    if (!response || response.writableEnded || response.headersSent) return;
    response.writeHead(200, { "content-type": "application/json" });
    response.write(JSON_FIRST_CHUNK);
  };
  const finishResponse = (index: number): void => {
    const response = responses[index];
    if (!response || response.writableEnded) return;
    startResponse(index);
    response.end(JSON_FINAL_CHUNK);
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
          capabilityExpiresAtMs: Date.now() + 15 * 60_000,
        }),
      );
      return;
    }
    responses.push(response);
    notifyRequestWaiters();
  });
  relayServers.add(server);
  await listenOnEphemeralPort(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("controlled test relay did not bind to a TCP port");
  }
  return {
    finishAllResponses: () => {
      for (let index = 0; index < responses.length; index += 1) {
        finishResponse(index);
      }
    },
    finishResponse,
    startResponse,
    url: `http://127.0.0.1:${address.port}`,
    waitForRequests: (count) => {
      if (responses.length >= count) return Promise.resolve();
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
  const exited = waitForExit(child);
  child.kill();
  const gracefulExit = await settleWithin(exited, STOP_SHARE_WEB_DEADLINE_MS);
  if (gracefulExit.kind === "settled") return;

  const pid = child.pid ?? "unknown";
  let signalSent: boolean;
  try {
    signalSent = child.kill("SIGKILL");
  } catch (error) {
    throw new Error(
      `share-web child pid=${String(pid)} exceeded the ` +
        `${String(STOP_SHARE_WEB_DEADLINE_MS)} ms stop deadline; ` +
        "failed to send SIGKILL",
      { cause: error },
    );
  }
  const forcedExit = await settleWithin(exited, SIGKILL_EXIT_TIMEOUT_MS);
  const forcedExitDiagnostic =
    forcedExit.kind === "timeout"
      ? `timed out after ${String(SIGKILL_EXIT_TIMEOUT_MS)} ms`
      : `code=${String(forcedExit.value.code)}, signal=${String(forcedExit.value.signal)}`;
  throw new Error(
    `share-web child pid=${String(pid)} exceeded the ` +
      `${String(STOP_SHARE_WEB_DEADLINE_MS)} ms stop deadline; ` +
      `SIGKILL sent=${String(signalSent)}; forced exit ${forcedExitDiagnostic}`,
  );
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function sendTerminationSignal(child: ChildProcessWithoutNullStreams): void {
  const sent =
    process.platform === "win32" ? child.send("SIGTERM") : child.kill("SIGTERM");
  if (!sent) throw new Error("failed to send SIGTERM to share-web");
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

function streamChunkedRequestWithoutEnd(
  port: number,
  body: Buffer,
): StreamingRequest {
  const socket = connect({ host: "127.0.0.1", port });
  const chunks: Buffer[] = [];
  let settled = false;
  let finishedBody = false;
  let socketError: string | undefined;
  let resolveResponse: (result: RawSocketResult) => void = () => undefined;
  const response = new Promise<RawSocketResult>((resolve) => {
    resolveResponse = resolve;
  });
  const settle = (result: RawSocketResult): void => {
    if (settled) return;
    settled = true;
    resolveResponse(result);
  };
  socket.once("connect", () => {
    socket.write(
      "POST /api/exchange HTTP/1.1\r\n" +
        `Host: ${PUBLIC_HOST}\r\n` +
        "Content-Type: application/json\r\n" +
        "Transfer-Encoding: chunked\r\n" +
        "Connection: close\r\n\r\n" +
        `${body.length.toString(16)}\r\n`,
    );
    socket.write(body);
    socket.write("\r\n");
  });
  socket.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  socket.once("error", (error) => {
    socketError = error.message;
  });
  socket.once("close", () => {
    if (chunks.length === 0) {
      settle(
        socketError === undefined
          ? { kind: "socket-close" }
          : { kind: "socket-error", error: socketError },
      );
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
  return {
    destroy: () => socket.destroy(),
    finishBody: () => {
      if (finishedBody || socket.destroyed) return;
      finishedBody = true;
      socket.write("0\r\n\r\n");
    },
    response,
  };
}

function isRefusalOrSocketClose(result: RawSocketResult): boolean {
  return result.kind === "response"
    ? result.status === 404
    : result.kind === "socket-close" || result.kind === "socket-error";
}
