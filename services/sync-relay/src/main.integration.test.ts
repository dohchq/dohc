import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { type IncomingMessage, request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LINK_EXCHANGE_BUCKET_CAPACITY } from "./linkSecurity";

// This file's spawn helper allows 45s for the relay to report a port (tsx compiles
// on startup), and the package default is 30s — so a slow launch would be killed by
// vitest before its own deadline could fire, and even a 20s launch would eat the
// budget the assertions need. File-level rather than package-level: only some of
// the test files here spawn a relay child, and the rest keep the tighter default
// (#372).
vi.setConfig({ testTimeout: 90_000, hookTimeout: 30_000 });

const WORKSPACE_ID = "workspace-live-relay";
const USER_ID = "sync-user";
const TEST_SHUTDOWN_GRACE_PERIOD_MS = 250;
const WITHIN_SHUTDOWN_GRACE_MS = 100;
const FORCED_SHUTDOWN_TIMEOUT_MS = 2_000;
const OUTPUT_BARRIER_MESSAGE_TYPE = "dohc-sync-relay-test-output-barrier";
const OUTPUT_BARRIER_PREFIX = "SYNC_RELAY_TEST_OUTPUT_BARRIER=";
const OUTPUT_BARRIER_TIMEOUT_MS = 10_000;

interface RunningRelay {
  baseUrl: string;
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  settleOutput: () => Promise<string>;
}

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

async function spawnRelay(
  dbPath: string,
  envOverrides: Record<string, string | undefined> = {},
): Promise<string> {
  return (await spawnRunningRelay(dbPath, envOverrides)).baseUrl;
}

async function spawnRunningRelay(
  dbPath: string,
  envOverrides: Record<string, string | undefined> = {},
): Promise<RunningRelay> {
  const mainUrl = new URL("./main.ts", import.meta.url);
  const childArguments = [
    "--import",
    process.platform === "win32" ? "tsx" : "tsx/esm",
    "--input-type=module",
    "--eval",
    `process.on("message", (message) => {
      if (message === "SIGTERM") process.emit("SIGTERM");
      if (message === "DOUBLE_SIGTERM") {
        process.emit("SIGTERM");
        process.emit("SIGTERM");
      }
      if (
        typeof message === "object" &&
        message !== null &&
        message.type === ${JSON.stringify(OUTPUT_BARRIER_MESSAGE_TYPE)} &&
        typeof message.id === "string"
      ) {
        const marker = "\\n" + ${JSON.stringify(OUTPUT_BARRIER_PREFIX)} + message.id + "\\n";
        process.stdout.write(marker);
        process.stderr.write(marker);
      }
    }); await import(${JSON.stringify(mainUrl.href)});`,
  ];
  const child = spawn(process.execPath, childArguments, {
    cwd: packageRoot(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      SYNC_RELAY_TEST_AUTH: "1",
      SYNC_RELAY_PORT: "0",
      SYNC_RELAY_DB_PATH: dbPath,
      DOHC_RELAY_SHARE_WEB_ORIGIN: "http://127.0.0.1:48123",
      FORCE_COLOR: "0",
      ...envOverrides,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  const childStdout = child.stdout;
  const childStderr = child.stderr;
  if (!childStdout || !childStderr) {
    child.kill();
    throw new Error("sync relay test child did not expose piped output");
  }
  children.push(child);
  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const outputBarrierFailure = (reason: string): Error =>
      new Error(`${reason}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    const timeout = setTimeout(() => {
      reject(new Error(`sync relay did not report a port\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 45_000); // tsx startup under load, not a hang — see presence.integration.test.ts (#372)
    childStdout.on("data", (chunk) => {
      stdout += String(chunk);
      const match = /SYNC_RELAY_LISTENING host=([^\s]+) port=(\d+)/u.exec(stdout);
      if (match) {
        clearTimeout(timeout);
        resolve({
          baseUrl: `http://${match[1]}:${match[2]}`,
          child,
          stdout: () => stdout,
          stderr: () => stderr,
          settleOutput: async () => {
            const barrierId = randomUUID();
            const marker = `${OUTPUT_BARRIER_PREFIX}${barrierId}`;
            await new Promise<void>((resolveBarrier, rejectBarrier) => {
              let settled = false;
              const cleanup = (): void => {
                clearTimeout(timeout);
                childStdout.off("data", checkForMarkers);
                childStderr.off("data", checkForMarkers);
                child.off("close", onClose);
                child.off("disconnect", onDisconnect);
              };
              const finish = (error?: Error): void => {
                if (settled) return;
                settled = true;
                cleanup();
                if (error) rejectBarrier(error);
                else resolveBarrier();
              };
              const checkForMarkers = (): void => {
                if (stdout.includes(marker) && stderr.includes(marker)) finish();
              };
              const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
                finish(
                  outputBarrierFailure(
                    `sync relay closed before settling output barrier: code=${code} signal=${signal}`,
                  ),
                );
              };
              const onDisconnect = (): void => {
                finish(
                  outputBarrierFailure(
                    "sync relay disconnected before settling output barrier",
                  ),
                );
              };
              const timeout = setTimeout(() => {
                finish(
                  outputBarrierFailure(
                    `sync relay output barrier timed out: stdout=${stdout.includes(marker)} stderr=${stderr.includes(marker)}`,
                  ),
                );
              }, OUTPUT_BARRIER_TIMEOUT_MS);

              childStdout.on("data", checkForMarkers);
              childStderr.on("data", checkForMarkers);
              child.once("close", onClose);
              child.once("disconnect", onDisconnect);
              if (!child.connected) {
                finish(
                  outputBarrierFailure(
                    "sync relay IPC was disconnected before settling output",
                  ),
                );
                return;
              }
              try {
                child.send(
                  { type: OUTPUT_BARRIER_MESSAGE_TYPE, id: barrierId },
                  (error) => {
                    if (error) {
                      finish(
                        outputBarrierFailure(
                          `sync relay output barrier send failed: ${error.message}`,
                        ),
                      );
                      return;
                    }
                    checkForMarkers();
                  },
                );
              } catch (error) {
                finish(
                  outputBarrierFailure(
                    `sync relay output barrier send failed: ${error instanceof Error ? error.message : String(error)}`,
                  ),
                );
              }
            });
            return marker;
          },
        });
      }
    });
    childStderr.on("data", (chunk) => {
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

async function seedExchangeLink(baseUrl: string, workspaceId: string): Promise<string> {
  expect((await postJson(baseUrl, "/sync/workspaces", { workspaceId })).status).toBe(200);
  const shareResponse = await postJson(baseUrl, `/sync/${workspaceId}/shares`, {
    recipientUserId: "link-recipient",
    paths: ["docs"],
    access: "view",
  });
  expect(shareResponse.status).toBe(200);
  const share = (await shareResponse.json()) as { shareId: string };
  const linkResponse = await postJson(
    baseUrl,
    `/sync/${workspaceId}/shares/${share.shareId}/links`,
    { access: "view" },
  );
  expect(linkResponse.status).toBe(200);
  const link = (await linkResponse.json()) as { url: string };
  return new URL(link.url).hash.slice(1);
}

function exchangeLink(
  baseUrl: string,
  secret: string,
  clientAddress: string,
  relayExchangeKey?: string,
): Promise<Response> {
  return fetch(`${baseUrl}/sync/link-exchange`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-dohc-relay-client-ip": clientAddress,
      ...(relayExchangeKey === undefined
        ? {}
        : { "x-dohc-relay-exchange-key": relayExchangeKey }),
    },
    body: JSON.stringify({ secret }),
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

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ kind: "settled"; value: T } | { kind: "pending" }> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ kind: "settled" as const, value })),
      new Promise<{ kind: "pending" }>((resolve) => {
        timeout = setTimeout(() => resolve({ kind: "pending" }), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

describe("sync relay main process", () => {

  it("force-closes a stalled streamed response after the shutdown grace period", { timeout: 15_000 }, async (context) => {
    const relayRoot = await tempRoot("relay-stalled-shutdown");
    let relay: RunningRelay;
    try {
      relay = await spawnRunningRelay(join(relayRoot, "relay.sqlite"), {
        SYNC_RELAY_TEST_CONTROLLED_STREAM: "1",
        SYNC_RELAY_TEST_SHUTDOWN_GRACE_PERIOD_MS: String(
          TEST_SHUTDOWN_GRACE_PERIOD_MS,
        ),
      });
    } catch (error) {
      if (error instanceof ListenPermissionError) {
        context.skip();
        return;
      }
      throw error;
    }

    let streamedResponse: IncomingMessage | undefined;
    const clientRequest = httpRequest(
      `${relay.baseUrl}/__test/controlled-stream`,
      (response) => {
        streamedResponse = response;
      },
    );
    const firstChunk = new Promise<Buffer>((resolve, reject) => {
      clientRequest.once("response", (response) => {
        response.once("data", (chunk: Buffer) => resolve(Buffer.from(chunk)));
        response.once("error", reject);
        response.once("end", () =>
          reject(new Error("controlled response ended before its first chunk")),
        );
      });
      clientRequest.once("error", reject);
    });
    clientRequest.end();
    expect((await firstChunk).length).toBeGreaterThan(0);

    try {
      const exited = waitForExit(relay.child);
      sendTerminationSignal(relay.child);

      expect(
        await settleWithin(exited, WITHIN_SHUTDOWN_GRACE_MS),
        `sync relay exited before its shutdown grace period\n${relay.stderr()}`,
      ).toEqual({ kind: "pending" });
      expect(
        await settleWithin(exited, FORCED_SHUTDOWN_TIMEOUT_MS),
        `sync relay remained alive after its shutdown grace period\n${relay.stderr()}`,
      ).toEqual({
        kind: "settled",
        value: { code: 0, signal: null },
      });
    } finally {
      streamedResponse?.destroy();
      clientRequest.destroy();
    }
  });

  it("shuts down promptly when no responses are active", async (context) => {
    const relayRoot = await tempRoot("relay-quiet-shutdown");
    let relay: RunningRelay;
    try {
      relay = await spawnRunningRelay(join(relayRoot, "relay.sqlite"), {
        SYNC_RELAY_TEST_SHUTDOWN_GRACE_PERIOD_MS: String(
          TEST_SHUTDOWN_GRACE_PERIOD_MS,
        ),
      });
    } catch (error) {
      if (error instanceof ListenPermissionError) {
        context.skip();
        return;
      }
      throw error;
    }
    const exited = waitForExit(relay.child);

    sendTerminationSignal(relay.child);

    expect(
      await settleWithin(exited, 1_000),
      `quiet sync relay did not exit promptly\n${relay.stderr()}`,
    ).toEqual({
      kind: "settled",
      value: { code: 0, signal: null },
    });
  });

  it("ignores a second SIGTERM while shutdown is in progress", async (context) => {
    const relayRoot = await tempRoot("relay-double-sigterm");
    let relay: RunningRelay;
    try {
      relay = await spawnRunningRelay(join(relayRoot, "relay.sqlite"), {
        SYNC_RELAY_TEST_AUTH: "0",
        SYNC_RELAY_BIND: "127.0.0.1",
        BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters",
        POSTGRES_URL: "postgres://dohc:dohc@127.0.0.1:1/dohc",
      });
    } catch (error) {
      if (error instanceof ListenPermissionError) {
        context.skip();
        return;
      }
      throw error;
    }
    const exited = waitForExit(relay.child);

    sendDoubleTerminationSignal(relay.child);

    expect(
      await settleWithin(exited, 1_000),
      `sync relay did not exit cleanly after duplicate SIGTERM\n${relay.stderr()}`,
    ).toEqual({
      kind: "settled",
      value: { code: 0, signal: null },
    });
  });

  it("survives a response error during a pipe and cancels the source stream", async (context) => {
    const relayRoot = await tempRoot("relay-response-error");
    let relay: RunningRelay;
    try {
      relay = await spawnRunningRelay(join(relayRoot, "relay.sqlite"), {
        SYNC_RELAY_TEST_CONTROLLED_STREAM: "1",
        SYNC_RELAY_TEST_RESPONSE_ERROR_DURING_PIPE: "1",
      });
    } catch (error) {
      if (error instanceof ListenPermissionError) {
        context.skip();
        return;
      }
      throw error;
    }

    const requestSettled = new Promise<void>((resolve) => {
      const request = httpRequest(
        `${relay.baseUrl}/__test/controlled-stream`,
        (response) => {
          response.once("error", () => resolve());
          response.once("close", () => resolve());
          response.resume();
        },
      );
      request.once("error", () => resolve());
      request.end();
    });
    expect(await settleWithin(requestSettled, 1_000)).toEqual({
      kind: "settled",
      value: undefined,
    });

    const cleanup = await fetch(`${relay.baseUrl}/__test/controlled-stream`, {
      method: "POST",
    });
    expect(cleanup.status).toBe(409);
    expect((await fetch(`${relay.baseUrl}/health`)).status).toBe(200);
  });

  it("streams response headers and first body chunk before completion", async (context) => {
    const relayRoot = await tempRoot("relay-streamed-response");
    let baseUrl: string;
    try {
      baseUrl = await spawnRelay(join(relayRoot, "relay.sqlite"), {
        SYNC_RELAY_TEST_CONTROLLED_STREAM: "1",
      });
    } catch (error) {
      if (error instanceof ListenPermissionError) {
        context.skip();
        return;
      }
      throw error;
    }

    const chunks: Buffer[] = [];
    let responseEnded = false;
    let resolveComplete: ((body: Buffer) => void) | undefined;
    const complete = new Promise<Buffer>((resolve) => {
      resolveComplete = resolve;
    });
    const firstChunk = new Promise<{
      bytes: Buffer;
      complete: boolean;
      contentType: string | undefined;
      marker: string | undefined;
      readableEnded: boolean;
      statusCode: number | undefined;
    }>((resolve, reject) => {
      const clientRequest = httpRequest(`${baseUrl}/__test/controlled-stream`, (response) => {
        response.once("error", reject);
        response.on("data", (chunk: Buffer) => {
          const bytes = Buffer.from(chunk);
          chunks.push(bytes);
          if (chunks.length === 1) {
            const marker = response.headers["x-dohc-test-stream"];
            resolve({
              bytes,
              complete: response.complete,
              contentType: response.headers["content-type"],
              marker: Array.isArray(marker) ? marker[0] : marker,
              readableEnded: response.readableEnded,
              statusCode: response.statusCode,
            });
          }
        });
        response.once("end", () => {
          responseEnded = true;
          resolveComplete?.(Buffer.concat(chunks));
        });
      });
      clientRequest.once("error", reject);
      clientRequest.end();
    });

    const observed = await settleWithin(firstChunk, 1_000);
    const finish = await fetch(`${baseUrl}/__test/controlled-stream`, { method: "POST" });
    expect(finish.status).toBe(204);
    const body = await complete;

    expect(observed).toMatchObject({
      kind: "settled",
      value: {
        complete: false,
        contentType: "application/octet-stream",
        marker: "controlled",
        readableEnded: false,
        statusCode: 200,
      },
    });
    if (observed.kind !== "settled") return;
    expect(responseEnded).toBe(true);
    expect(observed.value.bytes.length).toBeGreaterThan(0);
    expect(observed.value.bytes.every((byte) => byte === 0x61)).toBe(true);
    expect(body).toHaveLength(2 * 1024 * 1024);
    expect(body.subarray(0, 1024 * 1024).every((byte) => byte === 0x61)).toBe(true);
    expect(body.subarray(1024 * 1024).every((byte) => byte === 0x62)).toBe(true);
  });

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

  it("caps link exchanges at 4096 bytes before buffering the route body", async (context) => {
    const relayRoot = await tempRoot("link-exchange-cap");
    let baseUrl: string;
    try {
      baseUrl = await spawnRelay(join(relayRoot, "relay.sqlite"), {
        DOHC_RELAY_LINK_KEY: "integration-link-key-with-at-least-thirty-two-bytes",
        DOHC_RELAY_EXCHANGE_KEY: "integration-relay-exchange-key-at-least-32",
      });
    } catch (error) {
      if (error instanceof ListenPermissionError) {
        context.skip();
        return;
      }
      throw error;
    }

    const workspaceId = "workspace-link-exchange-cap";
    expect((await postJson(baseUrl, "/sync/workspaces", { workspaceId })).status).toBe(200);
    const shareResponse = await postJson(baseUrl, `/sync/${workspaceId}/shares`, {
      recipientUserId: "link-recipient",
      paths: ["docs"],
      access: "view",
    });
    expect(shareResponse.status).toBe(200);
    const share = (await shareResponse.json()) as { shareId: string };
    const linkResponse = await postJson(
      baseUrl,
      `/sync/${workspaceId}/shares/${share.shareId}/links`,
      { access: "view" },
    );
    expect(linkResponse.status).toBe(200);
    const link = (await linkResponse.json()) as { url: string };
    const linkSecret = new URL(link.url).hash.slice(1);

    const missing = await fetch(`${baseUrl}/sync/link-exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: "g".repeat(43) }),
    });
    expect(missing.status).toBe(404);
    const missingBody = await missing.text();

    const missingWorkloadIdentity = await fetch(`${baseUrl}/sync/link-exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: linkSecret }),
    });
    expect(missingWorkloadIdentity.status).toBe(404);
    expect(await missingWorkloadIdentity.text()).toBe(missingBody);

    const emptyPaddingBody = JSON.stringify({ secret: linkSecret, padding: "" });
    const oversizedBody = JSON.stringify({
      secret: linkSecret,
      padding: "x".repeat(4097 - Buffer.byteLength(emptyPaddingBody)),
    });
    expect(Buffer.byteLength(oversizedBody)).toBe(4097);
    const oversized = await fetch(`${baseUrl}/sync/link-exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: oversizedBody,
    });
    expect(oversized.status).toBe(404);
    expect(await oversized.text()).toBe(missingBody);

    const small = await fetch(`${baseUrl}/sync/link-exchange`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-dohc-relay-exchange-key": "integration-relay-exchange-key-at-least-32",
      },
      body: JSON.stringify({ secret: linkSecret }),
    });
    expect(small.status).toBe(200);
  });

  it("keeps keyed forwarded client addresses in separate exchange buckets", async (context) => {
    const relayRoot = await tempRoot("keyed-exchange-buckets");
    const relayExchangeKey = "integration-relay-exchange-key-at-least-32";
    let baseUrl: string;
    try {
      baseUrl = await spawnRelay(join(relayRoot, "relay.sqlite"), {
        DOHC_RELAY_LINK_KEY: "integration-link-key-with-at-least-thirty-two-bytes",
        DOHC_RELAY_EXCHANGE_KEY: relayExchangeKey,
      });
    } catch (error) {
      if (error instanceof ListenPermissionError) {
        context.skip();
        return;
      }
      throw error;
    }

    const secret = await seedExchangeLink(baseUrl, "workspace-keyed-exchange-buckets");
    const firstClientStatuses = await Promise.all(
      Array.from({ length: LINK_EXCHANGE_BUCKET_CAPACITY + 1 }, async () =>
        (
          await exchangeLink(
            baseUrl,
            secret,
            "198.51.100.10",
            relayExchangeKey,
          )
        ).status,
      ),
    );

    // Prove the first address's bucket is exhausted within one batch before
    // asserting the second address succeeds — otherwise one larger shared
    // bucket passes.
    const secondClient = await exchangeLink(
      baseUrl,
      secret,
      "198.51.100.11",
      relayExchangeKey,
    );
    expect({
      firstClientStatuses: [...firstClientStatuses].sort(
        (left: number, right: number) => left - right,
      ),
      secondClientStatus: secondClient.status,
    }).toEqual({
      firstClientStatuses: [
        ...Array.from({ length: LINK_EXCHANGE_BUCKET_CAPACITY }, () => 200),
        404,
      ],
      secondClientStatus: 200,
    });
  });

  it("ignores a forwarded client address when no exchange key is configured", async (context) => {
    const relayRoot = await tempRoot("unkeyed-exchange-bucket");
    let baseUrl: string;
    try {
      baseUrl = await spawnRelay(join(relayRoot, "relay.sqlite"), {
        DOHC_RELAY_LINK_KEY: "integration-link-key-with-at-least-thirty-two-bytes",
        DOHC_RELAY_EXCHANGE_KEY: undefined,
      });
    } catch (error) {
      if (error instanceof ListenPermissionError) {
        context.skip();
        return;
      }
      throw error;
    }

    const secret = await seedExchangeLink(baseUrl, "workspace-unkeyed-exchange-bucket");
    const firstClientStatuses = await Promise.all(
      Array.from({ length: LINK_EXCHANGE_BUCKET_CAPACITY + 1 }, async () =>
        (await exchangeLink(baseUrl, secret, "203.0.113.10")).status,
      ),
    );

    // Prove the shared bucket is exhausted within one batch before asserting
    // the spoofed address shares it.
    const spoofedSecondClient = await exchangeLink(baseUrl, secret, "203.0.113.11");
    expect({
      firstClientStatuses: [...firstClientStatuses].sort(
        (left: number, right: number) => left - right,
      ),
      secondClientStatus: spoofedSecondClient.status,
    }).toEqual({
      firstClientStatuses: [
        ...Array.from({ length: LINK_EXCHANGE_BUCKET_CAPACITY }, () => 200),
        404,
      ],
      secondClientStatus: 404,
    });
  });

  it("emits a canonical public URL without writing its bearer to process output", async (context) => {
    const relayRoot = await tempRoot("share-web-origin-url");
    let relay: RunningRelay;
    try {
      relay = await spawnRunningRelay(join(relayRoot, "relay.sqlite"), {
        DOHC_RELAY_LINK_KEY: "integration-link-key-with-at-least-thirty-two-bytes",
        DOHC_RELAY_SHARE_WEB_ORIGIN: "http://127.0.0.1:48123/",
      });
    } catch (error) {
      if (error instanceof ListenPermissionError) {
        context.skip();
        return;
      }
      throw error;
    }

    const workspaceId = "workspace-canonical-share-url";
    expect((await postJson(relay.baseUrl, "/sync/workspaces", { workspaceId })).status).toBe(200);
    const response = await postJson(relay.baseUrl, `/sync/${workspaceId}/shares/links`, {
      paths: ["docs"],
      access: "view",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("secret");
    expect(body.url).toMatch(/^http:\/\/127\.0\.0\.1:48123\/s\/#[-A-Za-z0-9_]{43}$/u);
    const completeUrl = String(body.url);
    const fragment = new URL(completeUrl).hash.slice(1);
    const outputBarrierMarker = await relay.settleOutput();
    expect(relay.stdout()).toContain(outputBarrierMarker);
    expect(relay.stderr()).toContain(outputBarrierMarker);
    expect(relay.stdout()).not.toContain(completeUrl);
    expect(relay.stdout()).not.toContain(fragment);
    expect(relay.stderr()).not.toContain(completeUrl);
    expect(relay.stderr()).not.toContain(fragment);
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
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      reject(new Error(`sync relay did not exit\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 45_000); // tsx startup under load, not a hang — see presence.integration.test.ts (#372)
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (/SYNC_RELAY_LISTENING/u.test(stdout)) {
        clearTimeout(timeout);
        reject(
          new Error(
            `sync relay started listening instead of exiting\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stderr });
    });
  });
}

function waitForExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function sendTerminationSignal(child: ChildProcess): void {
  const sent =
    process.platform === "win32" ? child.send("SIGTERM") : child.kill("SIGTERM");
  if (!sent) throw new Error("failed to send SIGTERM to sync relay");
}

function sendDoubleTerminationSignal(child: ChildProcess): void {
  const sent = child.send("DOUBLE_SIGTERM");
  if (!sent) throw new Error("failed to send duplicate SIGTERM to sync relay");
}

describe("sync relay startup guards", () => {
  const absoluteShareWebOriginReason =
    "FATAL: DOHC_RELAY_SHARE_WEB_ORIGIN must be an absolute HTTP(S) origin.";
  const invalidShareWebOriginShapeReason =
    "FATAL: DOHC_RELAY_SHARE_WEB_ORIGIN must be an origin without credentials, a path, a query, or a fragment.";
  const productionHttpsShareWebOriginReason =
    "FATAL: DOHC_RELAY_SHARE_WEB_ORIGIN must use HTTPS outside development/test.";
  const productionEnv = {
    NODE_ENV: "production",
    SYNC_RELAY_TEST_AUTH: undefined,
    POSTGRES_URL: "postgres://unused:unused@127.0.0.1:1/unused",
    DOHC_RELAY_LINK_KEY: "integration-link-key-with-at-least-thirty-two-bytes",
    DOHC_RELAY_EXCHANGE_KEY: "integration-relay-exchange-key-at-least-32",
    DOHC_RELAY_SHARE_WEB_ORIGIN: "https://share.example.test",
    BETTER_AUTH_SECRET: "x".repeat(32),
    SYNC_RELAY_PORT: "0",
    FORCE_COLOR: "0",
  } as const;

  it("refuses to start in production without a public share-web origin", async () => {
    const dbPath = join(await tempRoot("no-share-web-origin"), "relay.sqlite");
    const { code, stderr } = await spawnRelayExpectExit({
      ...productionEnv,
      DOHC_RELAY_SHARE_WEB_ORIGIN: undefined,
      SYNC_RELAY_DB_PATH: dbPath,
    });
    expect(code).toBe(1);
    expect(stderr).toContain("DOHC_RELAY_SHARE_WEB_ORIGIN must be set");
  });

  it.each([
    ["relative", "share.example.test", absoluteShareWebOriginReason],
    [
      "credentials",
      "https://user:pass@share.example.test",
      invalidShareWebOriginShapeReason,
    ],
    [
      "empty credentials",
      "https://@share.example.test",
      invalidShareWebOriginShapeReason,
    ],
    ["path", "https://share.example.test/public", invalidShareWebOriginShapeReason],
    [
      "query",
      "https://share.example.test/?tenant=one",
      invalidShareWebOriginShapeReason,
    ],
    ["empty query", "https://share.example.test/?", invalidShareWebOriginShapeReason],
    [
      "fragment",
      "https://share.example.test/#fragment",
      invalidShareWebOriginShapeReason,
    ],
    ["empty fragment", "https://share.example.test/#", invalidShareWebOriginShapeReason],
    ["non-HTTPS", "http://share.example.test", productionHttpsShareWebOriginReason],
  ])(
    "refuses a %s public share-web origin in production",
    async (label, origin, expectedReason) => {
      const dbPath = join(await tempRoot(`bad-share-web-origin-${label}`), "relay.sqlite");
      const { code, stderr } = await spawnRelayExpectExit({
        ...productionEnv,
        DOHC_RELAY_SHARE_WEB_ORIGIN: origin,
        SYNC_RELAY_DB_PATH: dbPath,
      });
      expect(code).toBe(1);
      expect(stderr).toBe(`${expectedReason}\n`);
    },
  );

  it.each(["test", "development"] as const)(
    "refuses a non-loopback HTTP DNS public origin in %s",
    async (nodeEnv) => {
      const dbPath = join(
        await tempRoot(`non-loopback-dns-share-web-origin-${nodeEnv}`),
        "relay.sqlite",
      );
      const { code, stderr } = await spawnRelayExpectExit({
        NODE_ENV: nodeEnv,
        SYNC_RELAY_TEST_AUTH: "1",
        SYNC_RELAY_PORT: "0",
        SYNC_RELAY_DB_PATH: dbPath,
        DOHC_RELAY_SHARE_WEB_ORIGIN: "http://share.example.test:48123",
        FORCE_COLOR: "0",
      });
      expect(code).toBe(1);
      expect(stderr).toContain("FATAL: DOHC_RELAY_SHARE_WEB_ORIGIN");
    },
  );

  describe.each([
    ["localhost", "test", "http://localhost:48123"],
    ["localhost subdomain", "test", "http://viewer.localhost:48123"],
    ["IPv4 loopback", "test", "http://127.0.0.1:48123"],
    ["another IPv4 loopback", "test", "http://127.42.0.9:48123"],
    ["canonicalized IPv4 loopback", "test", "http://127.1:48123"],
    ["IPv6 loopback", "test", "http://[::1]:48123"],
    ["IPv4 loopback", "development", "http://127.0.0.1:48123/"],
  ] as const)(
    "permits an HTTP %s public origin in %s",
    (label, nodeEnv, origin) => {
      it("starts", async (context) => {
        const relayRoot = await tempRoot(
          `loopback-share-web-origin-${nodeEnv}-${label.replaceAll(" ", "-")}`,
        );
        try {
          expect(
            await spawnRelay(join(relayRoot, "relay.sqlite"), {
              NODE_ENV: nodeEnv,
              DOHC_RELAY_SHARE_WEB_ORIGIN: origin,
            }),
          ).toMatch(/^http:\/\//u);
        } catch (error) {
          if (error instanceof ListenPermissionError) {
            context.skip();
            return;
          }
          throw error;
        }
      });
    },
  );

  it.each([
    ["private-network IPv4", "http://192.168.1.10:48123"],
    ["wildcard IPv4", "http://0.0.0.0:48123"],
    ["non-loopback IPv6", "http://[2001:db8::1]:48123"],
  ] as const)("refuses an HTTP %s public origin in test", async (label, origin) => {
    const dbPath = join(
      await tempRoot(`non-loopback-share-web-origin-${label.replaceAll(" ", "-")}`),
      "relay.sqlite",
    );
    const { code, stderr } = await spawnRelayExpectExit({
      NODE_ENV: "test",
      SYNC_RELAY_TEST_AUTH: "1",
      SYNC_RELAY_PORT: "0",
      SYNC_RELAY_DB_PATH: dbPath,
      DOHC_RELAY_SHARE_WEB_ORIGIN: origin,
      FORCE_COLOR: "0",
    });
    expect(code).toBe(1);
    expect(stderr).toContain("FATAL: DOHC_RELAY_SHARE_WEB_ORIGIN");
  });

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
      DOHC_RELAY_SHARE_WEB_ORIGIN: "https://share.example.test",
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
      DOHC_RELAY_EXCHANGE_KEY: "integration-relay-exchange-key-at-least-32",
      DOHC_RELAY_SHARE_WEB_ORIGIN: "https://share.example.test",
      SYNC_RELAY_PORT: "0",
      BETTER_AUTH_SECRET: "x".repeat(32),
      SYNC_RELAY_DB_PATH: dbPath,
      FORCE_COLOR: "0",
    });
    expect(code).toBe(1);
    expect(stderr).toContain("DOHC_RELAY_LINK_KEY must be set");
  });

  it("refuses to start in production when DOHC_RELAY_EXCHANGE_KEY is unset", async () => {
    const dbPath = join(await tempRoot("no-relay-exchange-key"), "relay.sqlite");
    const { code, stderr } = await spawnRelayExpectExit({
      NODE_ENV: "production",
      SYNC_RELAY_TEST_AUTH: undefined,
      POSTGRES_URL: "postgres://unused:unused@127.0.0.1:1/unused",
      DOHC_RELAY_LINK_KEY: "integration-link-key-with-at-least-thirty-two-bytes",
      DOHC_RELAY_EXCHANGE_KEY: undefined,
      DOHC_RELAY_SHARE_WEB_ORIGIN: "https://share.example.test",
      SYNC_RELAY_PORT: "0",
      BETTER_AUTH_SECRET: "x".repeat(32),
      SYNC_RELAY_DB_PATH: dbPath,
      FORCE_COLOR: "0",
    });
    expect(code).toBe(1);
    expect(stderr).toContain("DOHC_RELAY_EXCHANGE_KEY must be set");
  });

  it("refuses to start when DOHC_RELAY_EXCHANGE_KEY is shorter than 32 characters", async () => {
    const dbPath = join(await tempRoot("short-relay-exchange-key"), "relay.sqlite");
    const { code, stderr } = await spawnRelayExpectExit({
      NODE_ENV: "test",
      SYNC_RELAY_TEST_AUTH: "1",
      DOHC_RELAY_EXCHANGE_KEY: "x".repeat(31),
      SYNC_RELAY_PORT: "0",
      SYNC_RELAY_DB_PATH: dbPath,
      FORCE_COLOR: "0",
    });
    expect(code).toBe(1);
    expect(stderr).toContain(
      "FATAL: DOHC_RELAY_EXCHANGE_KEY must be at least 32 characters.",
    );
  });

  it("starts in test with a 32-character or unset relay exchange key", async (context) => {
    for (const [label, relayExchangeKey] of [
      ["minimum-relay-exchange-key", "x".repeat(32)],
      ["unset-relay-exchange-key", undefined],
    ] as const) {
      const relayRoot = await tempRoot(label);
      try {
        expect(
          await spawnRelay(join(relayRoot, "relay.sqlite"), {
            DOHC_RELAY_EXCHANGE_KEY: relayExchangeKey,
          }),
        ).toMatch(/^http:\/\//u);
      } catch (error) {
        if (error instanceof ListenPermissionError) {
          context.skip();
          return;
        }
        throw error;
      }
    }
  });
});
