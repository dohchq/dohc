import { createWorkspaceAuth } from "@dohc/workspace-api/auth/betterAuth";
import { createSessionActorResolver, UnauthorizedError, type ResolveActor } from "@dohc/workspace-api/auth/session";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { MAX_BLOB_BYTES, createSyncRelayHandler } from "./server";
import { openSyncRelayStorage } from "./storage";

const requestedPort = process.env.SYNC_RELAY_PORT === undefined ? 1788 : Number(process.env.SYNC_RELAY_PORT);
const defaultPostgresUrl = "postgres://dohc:dohc@localhost:54329/dohc_v2";
const secret = process.env.BETTER_AUTH_SECRET ?? "";
const nodeEnv = process.env.NODE_ENV;
const isDevOrTest = nodeEnv === "development" || nodeEnv === "test";
const testAuthSeam = process.env.SYNC_RELAY_TEST_AUTH === "1" && isDevOrTest;

if (process.env.SYNC_RELAY_TEST_AUTH === "1" && !isDevOrTest) {
  console.error(
    `FATAL: SYNC_RELAY_TEST_AUTH=1 requires NODE_ENV=development or test, got NODE_ENV=${nodeEnv ?? "(unset)"}. ` +
      "This fake bearer seam is test-only — refusing to start.",
  );
  process.exit(1);
}

if (!testAuthSeam && secret.length < 32) {
  console.error(
    "BETTER_AUTH_SECRET must be set (>=32 chars) and must match workspace-api's secret.",
  );
  process.exit(1);
}

const dbPath = process.env.SYNC_RELAY_DB_PATH ?? join(tmpdir(), "dohc-sync-relay.sqlite");
const storage = openSyncRelayStorage(dbPath);

// Production auth intentionally reuses workspace-api's Better Auth database
// and BETTER_AUTH_SECRET. A bearer token minted by workspace-api's desktop
// device flow is valid here only when POSTGRES_URL and BETTER_AUTH_SECRET
// match that service exactly; the relay has no separate login system.
let pool: Pool | undefined;
// Share-grant account lookups (PR 18): production resolves against Better
// Auth's user table on the SAME Postgres the session check uses; the test
// seam maps "<userId>@dohc.test" <-> "<userId>" so share E2E can address
// recipients by email without a user database.
const TEST_EMAIL_SUFFIX = "@dohc.test";
let resolveUserIdByEmail: (email: string) => Promise<string | null> | string | null;
let lookupUserEmail: (userId: string) => Promise<string | null> | string | null;
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
}

const relayHandler = createSyncRelayHandler({
  storage,
  resolveActor,
  resolveUserIdByEmail: (email) => resolveUserIdByEmail(email),
  lookupUserEmail: (userId) => lookupUserEmail(userId),
});
const fetchHandler = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (url.pathname === "/health") return Response.json({ ok: true, service: "sync-relay" });
  return relayHandler(request);
};

// Hand-rolled node:http -> fetch Request adapter (the sqlite-worker
// precedent) instead of better-auth's toNodeHandler: toNodeHandler silently
// drops request bodies that arrive WITHOUT a content-type header, which
// breaks raw-bytes blob PUTs. The relay never mounts better-auth's own
// routes (it only calls auth.api.getSession), so it does not need that
// adapter — and blob uploads must not depend on a client remembering to set
// a content-type header.
// Stream-level body cap: reject oversized uploads AS THEY ARRIVE, before
// anything is fully buffered — a multi-GB body must never accumulate in
// memory waiting for the handler's MAX_BLOB_BYTES check. Small headroom over
// the blob cap so a maximal valid blob PUT still passes.
const MAX_BODY_BYTES = MAX_BLOB_BYTES + 1024 * 1024;

const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  let received = 0;
  let rejected = false;
  // An aborted upload emits 'error' on the request stream; without a
  // listener that is an uncaught error that crashes the process.
  request.on("error", () => {
    rejected = true;
    response.destroy();
  });
  request.on("data", (chunk: Buffer) => {
    if (rejected) return;
    received += chunk.length;
    if (received > MAX_BODY_BYTES) {
      rejected = true;
      chunks.length = 0;
      response.statusCode = 413;
      response.setHeader("content-type", "application/json");
      response.setHeader("connection", "close");
      // Flush the 413 for well-behaved clients, then destroy the socket so
      // the sender cannot keep streaming.
      response.end(JSON.stringify({ ok: false, error: "payload too large", code: "payload_too_large" }), () => {
        request.destroy();
      });
      return;
    }
    chunks.push(Buffer.from(chunk));
  });
  request.on("end", () => {
    if (rejected) return;
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const webRequest = new Request(url, {
      method: request.method,
      headers: request.headers as Record<string, string>,
      body: chunks.length === 0 ? undefined : Buffer.concat(chunks),
    });
    void fetchHandler(webRequest)
      .then(async (webResponse) => {
        response.statusCode = webResponse.status;
        for (const [key, value] of webResponse.headers) response.setHeader(key, value);
        response.end(Buffer.from(await webResponse.arrayBuffer()));
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
const host = testAuthSeam ? "127.0.0.1" : (process.env.SYNC_RELAY_BIND ?? "0.0.0.0");
server.listen(requestedPort, host, () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : requestedPort;
  console.log(`[sync-relay] listening on ${host}:${actualPort}`);
  console.log(`SYNC_RELAY_LISTENING host=${host} port=${actualPort}`);
  if (testAuthSeam) console.log("[sync-relay] SYNC_RELAY_TEST_AUTH seam ENABLED (dev/test only)");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      storage.close();
      void pool?.end().finally(() => process.exit(0));
      if (!pool) process.exit(0);
    });
  });
}
