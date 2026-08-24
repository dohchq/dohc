import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// This file's spawn helper allows 45s for the relay to report a port (tsx compiles
// on startup), and the package default is 30s — so a slow launch would be killed by
// vitest before its own deadline could fire, and even a 20s launch would eat the
// budget the assertions need. File-level rather than package-level: only some of
// the test files here spawn a relay child, and the rest keep the tighter default
// (#372).
vi.setConfig({ testTimeout: 90_000, hookTimeout: 30_000 });

const WORKSPACE_ID = "workspace-live-relay";
const USER_ID = "sync-user";

let roots: string[] = [];
let children: ChildProcess[] = [];

beforeEach(() => {
  roots = [];
  children = [];
});

afterEach(async () => {
  // Wait for each relay child to actually exit before removing temp dirs:
  // kill() only requests termination, and Windows cannot unlink the child's
  // still-open relay.sqlite handles (EBUSY) until the process is gone.
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          const forceKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
          child.once("close", () => {
            clearTimeout(forceKill);
            resolve();
          });
          child.kill("SIGTERM");
        }),
    ),
  );
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `dohc-sync-relay-it-${label}-`));
  roots.push(root);
  return root;
}

function packageRoot(): string {
  return fileURLToPath(new URL("../", import.meta.url));
}

async function spawnRelay(dbPath: string): Promise<string> {
  const child = spawn(process.execPath, ["--import", "tsx/esm", "src/main.ts"], {
    cwd: packageRoot(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      SYNC_RELAY_TEST_AUTH: "1",
      SYNC_RELAY_PORT: "0",
      SYNC_RELAY_DB_PATH: dbPath,
      FORCE_COLOR: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      reject(new Error(`sync relay did not report a port\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 45_000); // tsx startup under load, not a hang — see presence.integration.test.ts (#372)
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const match = /SYNC_RELAY_LISTENING host=([^\s]+) port=(\d+)/u.exec(stdout);
      if (match) {
        clearTimeout(timeout);
        resolve(`http://${match[1]}:${match[2]}`);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (/listen EPERM/u.test(stderr)) {
        reject(new ListenPermissionError(stderr));
        return;
      }
      reject(new Error(`sync relay exited before listening: ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
}

class ListenPermissionError extends Error {
  constructor(stderr: string) {
    super(`loopback listen denied by test environment\n${stderr}`);
  }
}

function authHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set("authorization", `Bearer test:${USER_ID}`);
  return headers;
}

async function postJson(baseUrl: string, path: string, value: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(value),
  });
}

// Push as an ARBITRARY authenticated user (WS-MU-C0 forgery tests). The
// test-auth seam maps `Bearer test:<userId>` -> actor.userId, so this proves the
// relay derives the pusher's identity server-side and cannot be told otherwise.
async function postJsonAs(
  baseUrl: string,
  userId: string,
  path: string,
  value: unknown,
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer test:${userId}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(value),
  });
}

async function putBytes(baseUrl: string, path: string, bytes: Uint8Array): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "PUT",
    headers: authHeaders(),
    body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("sync relay main process", () => {

  // WS-MU-C0 over real HTTP: a second authenticated user cannot forge the first
  // user's chat authorship. The relay derives the pusher's identity from the
  // bearer session and rejects any chat op claiming a different author, atomically
  // — the log stays empty. The honest self-authored push is admitted.
  it("rejects forged chat authorship over real HTTP and admits the honest author", async (context) => {
    const relayRoot = await tempRoot("relay-authorship");
    let baseUrl: string;
    try {
      baseUrl = await spawnRelay(join(relayRoot, "relay.sqlite"));
    } catch (error) {
      if (error instanceof ListenPermissionError) {
        context.skip();
        return;
      }
      throw error;
    }

    const alice = "user-alice";
    const mallory = "user-mallory";
    const ws = "workspace-authorship";

    // Alice owns the bucket (claimed under her own authenticated identity).
    const claimed = await postJsonAs(baseUrl, alice, "/sync/workspaces", { workspaceId: ws });
    expect(claimed.status).toBe(200);

    const messageOp = (originSeq: number, authorUserId: string | undefined) => ({
      originSeq,
      opKind: "chat.message.append",
      payload: {
        messageId: `m-${originSeq}`,
        threadId: "t-1",
        authorKind: "human",
        authorDisplayName: "display only",
        ...(authorUserId !== undefined ? { authorUserId } : {}),
        body: "hi over http",
        createdAtMs: 5_000 + originSeq,
      },
      recordedAtMs: 5_000 + originSeq,
    });
    const reactionOp = (originSeq: number, authorId: string) => ({
      originSeq,
      opKind: "chat.reaction.set",
      payload: {
        reactionId: `r-${originSeq}`,
        messageId: "m-0",
        threadId: "t-1",
        emoji: "👍",
        authorId,
        authorKind: "human",
        authorDisplayName: "display only",
        state: "added",
        atMs: 5_000 + originSeq,
      },
      recordedAtMs: 5_000 + originSeq,
    });

    const logOps = async (): Promise<Array<{ payload: Record<string, unknown> }>> => {
      const response = await fetch(`${baseUrl}/sync/${ws}/log?since=0`, {
        headers: { authorization: `Bearer test:${alice}` },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        ops: Array<{ payload: Record<string, unknown> }>;
      };
      return body.ops;
    };
    const logLength = async (): Promise<number> => (await logOps()).length;

    // Alice forging Mallory's authorship on a message → 403, log unchanged.
    const forgedMessage = await postJsonAs(baseUrl, alice, `/sync/${ws}/log`, {
      originId: "origin-alice",
      ops: [messageOp(0, mallory)],
    });
    expect(forgedMessage.status).toBe(403);
    expect((await forgedMessage.json()) as Record<string, unknown>).toMatchObject({
      code: "authorship_mismatch",
    });
    expect(await logLength()).toBe(0);

    // Alice forging Mallory's authorship on a reaction → 403, log unchanged.
    const forgedReaction = await postJsonAs(baseUrl, alice, `/sync/${ws}/log`, {
      originId: "origin-alice",
      ops: [reactionOp(0, mallory)],
    });
    expect(forgedReaction.status).toBe(403);
    expect(await logLength()).toBe(0);

    // A batch mixing Alice's honest op with a forged one is rejected atomically.
    const mixed = await postJsonAs(baseUrl, alice, `/sync/${ws}/log`, {
      originId: "origin-alice",
      ops: [messageOp(0, alice), reactionOp(1, mallory)],
    });
    expect(mixed.status).toBe(403);
    expect(await logLength()).toBe(0);

    // A message created before sign-in has no verified relay author. The
    // workspace route rejects it and leaves the log unchanged.
    const localMessage = await postJsonAs(baseUrl, alice, `/sync/${ws}/log`, {
      originId: "origin-before-sign-in",
      ops: [messageOp(0, undefined)],
    });
    expect(localMessage.status).toBe(403);
    expect((await localMessage.json()) as Record<string, unknown>).toMatchObject({
      code: "authorship_mismatch",
    });
    expect(await logLength()).toBe(0);

    // Alice authoring as HERSELF is admitted.
    const honest = await postJsonAs(baseUrl, alice, `/sync/${ws}/log`, {
      originId: "origin-alice",
      ops: [messageOp(0, alice), reactionOp(1, alice)],
    });
    expect(honest.status).toBe(200);
    expect(await logLength()).toBe(2);
  });

  // Gate finding: the transport must cap request bodies AT THE STREAM. A
  // client streaming an oversized body is cut off mid-upload (413 and/or a
  // destroyed socket) instead of being fully buffered, and the server stays
  // healthy afterwards.
  it("rejects an oversized streamed body before buffering it and stays healthy", async (context) => {
    const relayRoot = await tempRoot("relay-stream-cap");
    let baseUrl: string;
    try {
      baseUrl = await spawnRelay(join(relayRoot, "relay.sqlite"));
    } catch (error) {
      if (error instanceof ListenPermissionError) {
        context.skip();
        return;
      }
      throw error;
    }
    const claim = await postJson(baseUrl, "/sync/workspaces", { workspaceId: WORKSPACE_ID });
    expect(claim.status).toBe(200);

    const chunk = Buffer.alloc(1024 * 1024, 7);
    const totalChunks = 48; // 48MB streamed; the cap is ~11MB.
    const outcome = await new Promise<{ status: number | null; sentAll: boolean }>((resolve) => {
      let sent = 0;
      let settled = false;
      const settle = (status: number | null) => {
        if (settled) return;
        settled = true;
        resolve({ status, sentAll: sent >= totalChunks });
      };
      const clientRequest = httpRequest(
        `${baseUrl}/sync/${encodeURIComponent(WORKSPACE_ID)}/blobs/${"0".repeat(64)}`,
        { method: "PUT", headers: { authorization: `Bearer test:${USER_ID}` } },
        (response) => {
          response.resume();
          settle(response.statusCode ?? null);
        },
      );
      clientRequest.on("error", () => settle(null));
      const writeMore = (): void => {
        while (sent < totalChunks) {
          sent += 1;
          const canContinue = clientRequest.write(chunk);
          if (!canContinue) {
            clientRequest.once("drain", writeMore);
            return;
          }
        }
        clientRequest.end();
      };
      writeMore();
    });

    // The stream was cut off BEFORE the client could deliver the full body
    // (pre-fix, the server buffered all 48MB and only then rejected).
    expect(outcome.sentAll).toBe(false);
    if (outcome.status !== null) expect(outcome.status).toBe(413);

    // The server survived: still answering, and a normal-sized blob works.
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    // High bytes on purpose. main.ts hand-rolls the node:http<->fetch adapter
    // BECAUSE the standard one mishandles raw-byte blob traffic, and the only
    // thing that can catch a regression there is reading a blob back over real
    // HTTP and comparing bytes. `Buffer.from("...")` cannot: every byte of an
    // ASCII string survives a text round trip, so a utf8-decoding adapter would
    // look correct.
    const smallBytes = Uint8Array.from([0, 1, 2, 253, 254, 255, 128, 200]);
    const digest = sha256(smallBytes);
    const put = await putBytes(baseUrl, `/sync/${WORKSPACE_ID}/blobs/${digest}`, smallBytes);
    expect(put.status).toBe(200);

    // Byte-for-byte on the way OUT, which nothing else in this package checks:
    // every other blob GET goes through createSyncRelayHandler in-process and so
    // never touches main.ts's adapter at all.
    const fetched = await fetch(`${baseUrl}/sync/${WORKSPACE_ID}/blobs/${digest}`, {
      headers: authHeaders(),
    });
    expect(fetched.status).toBe(200);
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(smallBytes);

    // And the same layer must still refuse an unauthenticated read: main.ts
    // decides which paths bypass the relay handler, so an in-process suite
    // cannot see a wiring regression here.
    const anonymous = await fetch(`${baseUrl}/sync/${WORKSPACE_ID}/log?since=0`);
    expect(anonymous.status).toBe(401);
  });
});

// Spawn main.ts expecting it to refuse to start; resolves with the exit code
// and captured stderr instead of a listening URL.
async function spawnRelayExpectExit(
  envOverrides: Record<string, string | undefined>,
): Promise<{ code: number | null; stderr: string }> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...envOverrides })) {
    if (value !== undefined) env[key] = value;
  }
  const child = spawn(process.execPath, ["--import", "tsx/esm", "src/main.ts"], {
    cwd: packageRoot(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return await new Promise((resolve, reject) => {
    let stderr = "";
    const timeout = setTimeout(() => {
      reject(new Error(`sync relay did not exit\nstderr:\n${stderr}`));
    }, 45_000); // tsx startup under load, not a hang — see presence.integration.test.ts (#372)
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stderr });
    });
  });
}

describe("sync relay startup guards", () => {
  it("refuses to start when SYNC_RELAY_PORT is not a number", async () => {
    const dbPath = join(await tempRoot("bad-port"), "relay.sqlite");
    const { code, stderr } = await spawnRelayExpectExit({
      NODE_ENV: "test",
      SYNC_RELAY_TEST_AUTH: "1",
      SYNC_RELAY_PORT: "not-a-port",
      SYNC_RELAY_DB_PATH: dbPath,
      FORCE_COLOR: "0",
    });
    expect(code).toBe(1);
    expect(stderr).toContain("SYNC_RELAY_PORT must be an integer");
  });

  it("refuses to start when SYNC_RELAY_WORKSPACE_QUOTA_BYTES is not positive", async () => {
    const dbPath = join(await tempRoot("bad-quota"), "relay.sqlite");
    const { code, stderr } = await spawnRelayExpectExit({
      NODE_ENV: "test",
      SYNC_RELAY_TEST_AUTH: "1",
      SYNC_RELAY_PORT: "0",
      SYNC_RELAY_WORKSPACE_QUOTA_BYTES: "0",
      SYNC_RELAY_DB_PATH: dbPath,
      FORCE_COLOR: "0",
    });
    expect(code).toBe(1);
    expect(stderr).toContain("SYNC_RELAY_WORKSPACE_QUOTA_BYTES must be a positive integer");
  });

  it("refuses to start in production when POSTGRES_URL is unset", async () => {
    const dbPath = join(await tempRoot("no-pg"), "relay.sqlite");
    const { code, stderr } = await spawnRelayExpectExit({
      NODE_ENV: "production",
      SYNC_RELAY_TEST_AUTH: undefined,
      POSTGRES_URL: undefined,
      SYNC_RELAY_PORT: "0",
      // A valid-length secret so the guard under test is the one that fires.
      BETTER_AUTH_SECRET: "x".repeat(32),
      SYNC_RELAY_DB_PATH: dbPath,
      FORCE_COLOR: "0",
    });
    expect(code).toBe(1);
    expect(stderr).toContain("POSTGRES_URL must be set");
  });

  it("refuses to start in production when DOHC_RELAY_LINK_KEY is unset", async () => {
    const dbPath = join(await tempRoot("no-link-key"), "relay.sqlite");
    const { code, stderr } = await spawnRelayExpectExit({
      NODE_ENV: "production",
      SYNC_RELAY_TEST_AUTH: undefined,
      POSTGRES_URL: "postgres://unused:unused@127.0.0.1:1/unused",
      DOHC_RELAY_LINK_KEY: undefined,
      SYNC_RELAY_PORT: "0",
      BETTER_AUTH_SECRET: "x".repeat(32),
      SYNC_RELAY_DB_PATH: dbPath,
      FORCE_COLOR: "0",
    });
    expect(code).toBe(1);
    expect(stderr).toContain("DOHC_RELAY_LINK_KEY must be set");
  });
});
