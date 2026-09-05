import { createWorkspaceAuth } from "@dohc/workspace-auth/betterAuth";
import { createSessionActorResolver, UnauthorizedError, type ResolveActor } from "@dohc/workspace-auth/session";
import { writeSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { RELAY_ERRORS } from "./errorCodes";
import { hashRelayExchangeKey, verifyRelayExchangeKey } from "./linkSecurity";
import { PresenceHub } from "./presence";
import { MAX_BLOB_BYTES, createSyncRelayHandler } from "./server";
import { DEFAULT_WORKSPACE_QUOTA_BYTES, openSyncRelayStorage } from "./storage";

const DEFAULT_SHUTDOWN_GRACE_PERIOD_MS = 10_000;
const SHUTDOWN_GRACE_PERIOD_MS = shutdownGracePeriodMs();
const requestedPort = process.env.SYNC_RELAY_PORT === undefined ? 1788 : Number(process.env.SYNC_RELAY_PORT);
const workspaceQuotaBytes =
  process.env.SYNC_RELAY_WORKSPACE_QUOTA_BYTES === undefined
    ? DEFAULT_WORKSPACE_QUOTA_BYTES
    : Number(process.env.SYNC_RELAY_WORKSPACE_QUOTA_BYTES);
const defaultPostgresUrl = "postgres://dohc:dohc@localhost:54329/dohc";
const secret = process.env.BETTER_AUTH_SECRET ?? "";
const nodeEnv = process.env.NODE_ENV;
const isDevOrTest = nodeEnv === "development" || nodeEnv === "test";
const testAuthSeam = process.env.SYNC_RELAY_TEST_AUTH === "1" && isDevOrTest;
const controlledStreamTestSeam =
  testAuthSeam && process.env.SYNC_RELAY_TEST_CONTROLLED_STREAM === "1";
let emitResponseErrorDuringPipeTestSeam =
  controlledStreamTestSeam &&
  process.env.SYNC_RELAY_TEST_RESPONSE_ERROR_DURING_PIPE === "1";
const linkKey = process.env.DOHC_RELAY_LINK_KEY;
const relayExchangeKey = process.env.DOHC_RELAY_EXCHANGE_KEY;
const relayExchangeKeyHash =
  relayExchangeKey === undefined ? undefined : hashRelayExchangeKey(relayExchangeKey);

function fatal(message: string): never {
  writeSync(2, `${message}\n`);
  process.exit(1);
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    /^127(?:\.\d{1,3}){3}$/u.test(hostname) ||
    hostname === "[::1]"
  );
}

function validateShareWebOrigin(value: string | undefined): string | undefined {
  if (value === undefined) {
    if (!isDevOrTest) {
      fatal("FATAL: DOHC_RELAY_SHARE_WEB_ORIGIN must be set outside development/test.");
    }
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fatal("FATAL: DOHC_RELAY_SHARE_WEB_ORIGIN must be an absolute HTTP(S) origin.");
  }
  if (
    value.trim() !== value ||
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    value.includes("@") ||
    parsed.pathname !== "/" ||
    value.includes("?") ||
    value.includes("#")
  ) {
    fatal(
      "FATAL: DOHC_RELAY_SHARE_WEB_ORIGIN must be an origin without credentials, a path, a query, or a fragment.",
    );
  }
  if (!isDevOrTest && parsed.protocol !== "https:") {
    fatal("FATAL: DOHC_RELAY_SHARE_WEB_ORIGIN must use HTTPS outside development/test.");
  }
  if (isDevOrTest && parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
    fatal(
      "FATAL: DOHC_RELAY_SHARE_WEB_ORIGIN must use HTTPS unless its HTTP hostname is loopback in development/test.",
    );
  }
  return parsed.origin;
}

const shareWebOrigin = validateShareWebOrigin(process.env.DOHC_RELAY_SHARE_WEB_ORIGIN);

// Reject an unparseable SYNC_RELAY_PORT up front: Number("abc") is NaN and
// server.listen(NaN) fails with an obscure downstream error. Port 0 is
// allowed (bind an ephemeral port, used by the integration harness).
if (
  process.env.SYNC_RELAY_PORT !== undefined &&
  (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535)
) {
  fatal(
    `FATAL: SYNC_RELAY_PORT must be an integer in 0-65535, got "${process.env.SYNC_RELAY_PORT}".`,
  );
}

if (
  process.env.SYNC_RELAY_WORKSPACE_QUOTA_BYTES !== undefined &&
  (!Number.isInteger(workspaceQuotaBytes) || workspaceQuotaBytes <= 0)
) {
  fatal(
    `FATAL: SYNC_RELAY_WORKSPACE_QUOTA_BYTES must be a positive integer, got "${process.env.SYNC_RELAY_WORKSPACE_QUOTA_BYTES}".`,
  );
}

// In production the relay reuses workspace-api's Postgres for session and
// share-account lookups. Falling back to a localhost default there would
// silently point auth at the wrong database; fail fast instead. The default
// stays available for dev/test convenience only.
if (!isDevOrTest && !testAuthSeam && process.env.POSTGRES_URL === undefined) {
  fatal(
    "FATAL: POSTGRES_URL must be set outside development/test (it must match workspace-api's database).",
  );
}

if (!isDevOrTest && !linkKey) {
  fatal("FATAL: DOHC_RELAY_LINK_KEY must be set outside development/test.");
}

if (!isDevOrTest && !relayExchangeKey) {
  fatal("FATAL: DOHC_RELAY_EXCHANGE_KEY must be set outside development/test.");
}

if (relayExchangeKey !== undefined && relayExchangeKey.length < 32) {
  fatal("FATAL: DOHC_RELAY_EXCHANGE_KEY must be at least 32 characters.");
}

if (process.env.SYNC_RELAY_TEST_AUTH === "1" && !isDevOrTest) {
  fatal(
    `FATAL: SYNC_RELAY_TEST_AUTH=1 requires NODE_ENV=development or test, got NODE_ENV=${nodeEnv ?? "(unset)"}. ` +
      "This fake bearer seam is test-only — refusing to start.",
  );
}

if (!testAuthSeam && secret.length < 32) {
  fatal(
    "BETTER_AUTH_SECRET must be set (>=32 chars) and must match workspace-api's secret.",
  );
}

const dbPath = process.env.SYNC_RELAY_DB_PATH ?? join(tmpdir(), "dohc-sync-relay.sqlite");
const storage = openSyncRelayStorage(dbPath, { workspaceQuotaBytes });

// Production auth intentionally reuses workspace-api's Better Auth database
// and BETTER_AUTH_SECRET. A bearer token minted by workspace-api's desktop
// device flow is valid here only when POSTGRES_URL and BETTER_AUTH_SECRET
// match that service exactly; the relay has no separate login system.
let pool: Pool | undefined;
// Share-grant account lookups: production resolves against Better
// Auth's user table on the same Postgres the session check uses; the test
// seam maps "<userId>@dohc.test" <-> "<userId>" so share E2E can address
// recipients by email without a user database.
const TEST_EMAIL_SUFFIX = "@dohc.test";
let resolveUserIdByEmail: (email: string) => Promise<string | null> | string | null;
let lookupUserEmail: (userId: string) => Promise<string | null> | string | null;
let lookupUserDisplayName: (
  userId: string,
) => Promise<string | null> | string | null;
const resolveActor: ResolveActor = testAuthSeam
  ? createTestActorResolver()
  : (() => {
      pool = new Pool({
        connectionString: process.env.POSTGRES_URL ?? defaultPostgresUrl,
      });
      // pg pools emit 'error' for idle-client failures (Postgres restart,
      // network partition). Without a listener that is an uncaught 'error'
      // event and takes the whole relay process down; with one, only the
      // in-flight requests fail (as a 5xx via the handler's error path).
      pool.on("error", (error) => {
        console.error("[sync-relay] postgres pool error", error);
      });
      const auth = createWorkspaceAuth({
        pool,
        baseURL: process.env.SYNC_RELAY_AUTH_BASE_URL ?? `http://localhost:${requestedPort || 1788}`,
        secret,
      });
      return createSessionActorResolver(auth);
    })();

function createTestActorResolver(): ResolveActor {
  return (request, workspaceId) => {
    const authorization = request.headers.get("authorization") ?? "";
    const match = /^Bearer test:([A-Za-z0-9_.:-]+)$/u.exec(authorization);
    if (!match) throw new UnauthorizedError();
    return { userId: match[1]!, workspaceId };
  };
}

if (testAuthSeam) {
  resolveUserIdByEmail = (email) =>
    email.endsWith(TEST_EMAIL_SUFFIX) && email.length > TEST_EMAIL_SUFFIX.length
      ? email.slice(0, -TEST_EMAIL_SUFFIX.length)
      : null;
  lookupUserEmail = (userId) => `${userId}${TEST_EMAIL_SUFFIX}`;
  lookupUserDisplayName = (userId) => userId;
} else {
  // Better Auth's canonical table/column names on the shared Postgres.
  resolveUserIdByEmail = async (email) => {
    const result = await pool!.query<{ id: string }>(
      'SELECT id FROM "user" WHERE lower(email) = lower($1) LIMIT 1',
      [email],
    );
    return result.rows[0]?.id ?? null;
  };
  lookupUserEmail = async (userId) => {
    const result = await pool!.query<{ email: string }>(
      'SELECT email FROM "user" WHERE id = $1 LIMIT 1',
      [userId],
    );
    return result.rows[0]?.email ?? null;
  };
  lookupUserDisplayName = async (userId) => {
    const result = await pool!.query<{ name: string | null }>(
      'SELECT name FROM "user" WHERE id = $1 LIMIT 1',
      [userId],
    );
    return result.rows[0]?.name ?? null;
  };
}

// One in-memory presence hub for the whole process: the ephemeral awareness
// transport is never persisted, so it lives only here and is lost on restart
// (by design — presence is not durable).
const presence = new PresenceHub();
let finishControlledTestStream: (() => void) | undefined;

const relayHandler = createSyncRelayHandler({
  storage,
  resolveActor,
  resolveUserIdByEmail: (email) => resolveUserIdByEmail(email),
  lookupUserEmail: (userId) => lookupUserEmail(userId),
  lookupUserDisplayName: (userId) => lookupUserDisplayName(userId),
  presence,
  linkKey,
  shareWebOrigin,
  relayExchangeKey,
});
const fetchHandler = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (controlledStreamTestSeam && url.pathname === "/__test/controlled-stream") {
    if (request.method === "POST") {
      const finish = finishControlledTestStream;
      if (!finish) return new Response(null, { status: 409 });
      finish();
      return new Response(null, { status: 204 });
    }
    if (request.method === "GET") {
      if (finishControlledTestStream) return new Response(null, { status: 409 });
      const chunkBytes = 1024 * 1024;
      let active = true;
      let removeAbortListener = (): void => undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const abort = (): void => {
            if (!active) return;
            active = false;
            finishControlledTestStream = undefined;
            controller.error(new Error("controlled stream client disconnected"));
          };
          removeAbortListener = () => request.signal.removeEventListener("abort", abort);
          request.signal.addEventListener("abort", abort, { once: true });
          controller.enqueue(new Uint8Array(chunkBytes).fill(0x61));
          finishControlledTestStream = () => {
            if (!active) return;
            active = false;
            finishControlledTestStream = undefined;
            removeAbortListener();
            controller.enqueue(new Uint8Array(chunkBytes).fill(0x62));
            controller.close();
          };
        },
        cancel() {
          active = false;
          finishControlledTestStream = undefined;
          removeAbortListener();
        },
      });
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "x-dohc-test-stream": "controlled",
        },
      });
    }
    return new Response(null, { status: 405 });
  }
  if (url.pathname === "/health") {
    // The presence hub footprint is exposed only under the dev/test seam so
    // integration tests can assert parked waiters are released on disconnect;
    // production health stays a bare liveness probe.
    return Response.json({
      ok: true,
      service: "sync-relay",
      ...(testAuthSeam ? { presence: presence.stats() } : {}),
    });
  }
  return relayHandler(request);
};

// Hand-rolled node:http -> fetch Request adapter instead of better-auth's
// toNodeHandler: toNodeHandler silently
// drops request bodies that arrive without a content-type header, which
// breaks raw-bytes blob PUTs. The relay never mounts better-auth's own
// routes (it only calls auth.api.getSession), so it does not need that
// adapter — and blob uploads must not depend on a client remembering to set
// a content-type header.
// Stream-level body cap: reject oversized uploads AS THEY ARRIVE, before
// anything is fully buffered — a multi-GB body must never accumulate in
// memory waiting for the handler's MAX_BLOB_BYTES check. Small headroom over
// the blob cap so a maximal valid blob PUT still passes.
const MAX_BODY_BYTES = MAX_BLOB_BYTES + 1024 * 1024;
const MAX_LINK_EXCHANGE_BODY_BYTES = 4096;

function isLinkExchangePath(pathname: string): boolean {
  try {
    const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
    return parts.length === 2 && parts[0] === "sync" && parts[1] === "link-exchange";
  } catch {
    return false;
  }
}

function isLinkRefreshPath(pathname: string): boolean {
  try {
    const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
    return parts.length === 2 && parts[0] === "sync" && parts[1] === "link-refresh";
  } catch {
    return false;
  }
}

function presentsValidRelayExchangeKey(headers: Headers): boolean {
  const presented = headers.get("x-dohc-relay-exchange-key");
  return (
    relayExchangeKeyHash !== undefined &&
    verifyRelayExchangeKey(presented, relayExchangeKeyHash)
  );
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const isLinkExchange = isLinkExchangePath(url.pathname);
  const isLinkRefresh = isLinkRefreshPath(url.pathname);
  const isLinkWorkloadRequest = isLinkExchange || isLinkRefresh;
  const maxBodyBytes = isLinkWorkloadRequest
    ? MAX_LINK_EXCHANGE_BODY_BYTES
    : MAX_BODY_BYTES;
  const chunks: Buffer[] = [];
  let received = 0;
  let rejected = false;
  // Client-disconnect propagation: the fetch Request below carries this
  // signal, and the presence long-poll parks on request.signal — so a closed
  // socket releases its parked waiter immediately instead of holding the slot
  // for the full hold window ('close' also fires after a normal response
  // finishes, where the late abort is a no-op).
  const disconnect = new AbortController();
  response.on("close", () => disconnect.abort());
  // An aborted upload emits 'error' on the request stream; without a
  // listener that is an uncaught error that crashes the process.
  request.on("error", () => {
    rejected = true;
    disconnect.abort();
    response.destroy();
  });
  request.on("data", (chunk: Buffer) => {
    if (rejected) return;
    received += chunk.length;
    if (received > maxBodyBytes) {
      rejected = true;
      chunks.length = 0;
      const refusal = isLinkWorkloadRequest
        ? { error: "not found", definition: RELAY_ERRORS.not_found }
        : { error: "payload too large", definition: RELAY_ERRORS.payload_too_large };
      response.statusCode = refusal.definition.status;
      response.setHeader("content-type", "application/json");
      response.setHeader("connection", "close");
      // Flush the refusal for well-behaved clients, then destroy the socket so
      // the sender cannot keep streaming.
      response.end(
        JSON.stringify({
          ok: false,
          error: refusal.error,
          code: refusal.definition.code,
        }),
        () => {
          request.destroy();
        },
      );
      return;
    }
    chunks.push(Buffer.from(chunk));
  });
  request.on("end", () => {
    if (rejected) return;
    const headers = new Headers(request.headers as Record<string, string>);
    const forwardedClientAddress = headers.get("x-dohc-relay-client-ip");
    if (
      !isLinkExchange ||
      forwardedClientAddress === null ||
      !presentsValidRelayExchangeKey(headers)
    ) {
      // Only the keyed share-web exchange hop can select a forwarded bucket.
      headers.set("x-dohc-relay-client-ip", request.socket.remoteAddress ?? "unknown");
    }
    const webRequest = new Request(url, {
      method: request.method,
      headers,
      body: chunks.length === 0 ? undefined : Buffer.concat(chunks),
      signal: disconnect.signal,
    });
    void fetchHandler(webRequest)
      .then(async (webResponse) => {
        response.statusCode = webResponse.status;
        for (const [key, value] of webResponse.headers) response.setHeader(key, value);
        if (!webResponse.body) {
          response.end();
          return;
        }
        await pipeResponseBody(webResponse.body, response);
      })
      .catch(() => {
        // Never echo internal error details (or anything derived from the
        // request) back to the caller.
        response.statusCode = 500;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: false, error: "internal error" }));
      });
  });
});

async function pipeResponseBody(
  body: ReadableStream<Uint8Array>,
  outgoing: ServerResponse,
): Promise<void> {
  const reader = body.getReader();
  const cancelOnClose = (): void => {
    if (!outgoing.writableFinished) void reader.cancel().catch(() => undefined);
  };
  const destroyOnError = (): void => {
    if (!outgoing.destroyed) outgoing.destroy();
  };
  outgoing.once("close", cancelOnClose);
  outgoing.on("error", destroyOnError);
  try {
    while (!outgoing.destroyed) {
      const read = await reader.read();
      if (read.done) {
        outgoing.end();
        return;
      }
      const needsDrain = !outgoing.write(read.value);
      if (emitResponseErrorDuringPipeTestSeam) {
        emitResponseErrorDuringPipeTestSeam = false;
        queueMicrotask(() => {
          outgoing.emit("error", new Error("controlled response error during pipe"));
        });
      }
      if (needsDrain) {
        const drained = await waitForDrain(outgoing);
        if (!drained) return;
      }
    }
  } catch {
    if (!outgoing.destroyed) outgoing.destroy();
  } finally {
    outgoing.off("close", cancelOnClose);
    outgoing.off("error", destroyOnError);
    if (!outgoing.writableFinished) await reader.cancel().catch(() => undefined);
  }
}

function waitForDrain(outgoing: ServerResponse): Promise<boolean> {
  if (outgoing.destroyed) return Promise.resolve(false);
  return new Promise((resolve) => {
    const cleanup = (): void => {
      outgoing.off("close", closed);
      outgoing.off("drain", drained);
    };
    const closed = (): void => {
      cleanup();
      resolve(false);
    };
    const drained = (): void => {
      cleanup();
      resolve(true);
    };
    outgoing.once("close", closed);
    outgoing.once("drain", drained);
  });
}

const host = testAuthSeam ? "127.0.0.1" : (process.env.SYNC_RELAY_BIND ?? "0.0.0.0");
server.listen(requestedPort, host, () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : requestedPort;
  console.log(`[sync-relay] listening on ${host}:${actualPort}`);
  console.log(`SYNC_RELAY_LISTENING host=${host} port=${actualPort}`);
  if (testAuthSeam) console.log("[sync-relay] SYNC_RELAY_TEST_AUTH seam ENABLED (dev/test only)");
});

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, shutdown);
}

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  let forceCloseTimer: ReturnType<typeof setTimeout> | undefined;
  server.close(() => {
    if (forceCloseTimer !== undefined) clearTimeout(forceCloseTimer);
    storage.close();
    void pool?.end().finally(() => process.exit(0));
    if (!pool) process.exit(0);
  });
  forceCloseTimer = setTimeout(() => {
    server.closeAllConnections();
  }, SHUTDOWN_GRACE_PERIOD_MS);
  forceCloseTimer.unref();
}

function shutdownGracePeriodMs(): number {
  if (process.env.NODE_ENV !== "test") return DEFAULT_SHUTDOWN_GRACE_PERIOD_MS;
  const configured = process.env.SYNC_RELAY_TEST_SHUTDOWN_GRACE_PERIOD_MS;
  if (configured === undefined) return DEFAULT_SHUTDOWN_GRACE_PERIOD_MS;
  const parsed = Number(configured);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_SHUTDOWN_GRACE_PERIOD_MS;
}
