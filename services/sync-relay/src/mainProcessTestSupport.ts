import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import { requireEngineBinaryOrSkip } from "../../../apps/desktop/src/testing/engineBinary";
import { buildRelay } from "../scripts/build.mjs";

export const projectionEngine = requireEngineBinaryOrSkip();

// Child startup has a 45s deadline. Allow its assertions and cleanup to finish
// within this file's budget, including the development source-entry proof.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 30_000 });

// Some sandboxes refuse loopback listens with EPERM. Every test below spawns
// a relay that listens, so decide once here and report the whole suite as
// skipped instead of skipping inside each test.
export const loopbackListenDenied = await new Promise<boolean>((resolve) => {
  const server = createServer();
  server.once("error", (error: NodeJS.ErrnoException) => resolve(error.code === "EPERM"));
  server.listen(0, "127.0.0.1", () => server.close(() => resolve(false)));
});

if (loopbackListenDenied && process.env.DOHC_REQUIRE_ENGINE_E2E === "1") {
  throw new Error("Required relay process tests cannot listen on loopback.");
}

export const WORKSPACE_ID = "workspace-live-relay";

export const USER_ID = "sync-user";

// Outlasts SHUTDOWN_EXIT_WAIT_MS, so an exit within that wait shows shutdown did
// not wait out its grace period. The wait itself only has to outlast a loaded
// gate host: a 1 s bound there measured the host, not the relay.
export const TEST_SHUTDOWN_GRACE_PERIOD_MS = 60_000;

export const SHUTDOWN_EXIT_WAIT_MS = 10_000;

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

export const productionEnv = {
  NODE_ENV: "production",
  SYNC_RELAY_TEST_AUTH: undefined,
  POSTGRES_URL: "postgres://unused:unused@127.0.0.1:1/unused",
  DOHC_RELAY_LINK_KEY: "integration-link-key-with-at-least-thirty-two-bytes",
  DOHC_RELAY_EXCHANGE_KEY: "integration-relay-exchange-key-at-least-32",
  DOHC_RELAY_SHARE_WEB_ORIGIN: "https://share.example.test",
  BETTER_AUTH_SECRET: "x".repeat(32),
  SYNC_RELAY_PORT: "0",
  FORCE_COLOR: "0",
  DOHC_RELAY_ENGINE_EXECUTABLE: projectionEngine.path ?? undefined,
  DOHC_RELAY_ALLOW_UNISOLATED_PROJECTION: undefined,
} as const;

export function relayProcessFixture() {
  let roots: string[] = [];

  let children: ChildProcess[] = [];

  let buildDirectory: string;

  beforeAll(async () => {
    const output = join(packageRoot(), ".output");
    await mkdir(output, { recursive: true });
    buildDirectory = await mkdtemp(join(output, "main-process-"));
    await buildRelay(buildDirectory);
  });

  afterAll(async () => {
    if (buildDirectory) await rm(buildDirectory, { recursive: true, force: true });
  });

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

  const EMPTY_DELETION_JOBS_BOOTSTRAP = `
const {Pool} = await import("pg");
const query = Pool.prototype.query;
Pool.prototype.query = function (sql, ...args) {
  if (sql === "SELECT user_id,email FROM account_deletion_jobs") return Promise.resolve({rows: []});
  return query.call(this, sql, ...args);
};
`;

  const PROJECTION_HANDSHAKE_BOOTSTRAP = `
// Route coverage uses a fake isolated-engine handshake on every host.
Object.defineProperty(process, "platform", {value: "linux"});
const {default: childProcess} = await import("node:child_process");
const {syncBuiltinESMExports} = await import("node:module");
const originalSpawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  if (command === "/bin/sh" && args?.[1]?.includes("--projection-only")) {
    return originalSpawn(process.execPath, ["--input-type=module", "--eval", ${JSON.stringify(`
      const frame = row => {
        const payload = Buffer.from(JSON.stringify(row));
        const header = Buffer.alloc(12); header.write("DOP1"); header[4] = 1;
        header.writeUInt32LE(payload.length, 8); return Buffer.concat([header, payload]);
      };
      let pending = Buffer.alloc(0);
      process.stdin.on("data", bytes => {
        pending = Buffer.concat([pending, bytes]);
        while (pending.length >= 12 && pending.length >= 12 + pending.readUInt32LE(8)) {
          const size = pending.readUInt32LE(8);
          const row = JSON.parse(pending.subarray(12, 12 + size).toString());
          pending = pending.subarray(12 + size);
          if (row.type === "hello") {
            process.stdout.write(frame({type:"helloAck",protocolVersion:2,sessionGeneration:1,capabilities:["projection-only"],
              limits:{maxFrameBytes:14680064,maxStringBytes:14680064,maxCollectionLen:16384,maxBatchLen:64,maxJsonDepth:32,maxBlobChunkBytes:262144}}));
          } else if (row.method === "engine.ping") {
            process.stdout.write(frame({type:"response",id:row.id,result:{ok:true,mode:"projection-only"}}));
          } else if (row.method === "ydoc.project" && row.params.contentKind === "plaintext" && row.params.updatesBase64[0] === "AAA=") {
            process.stdout.write(frame({type:"response",id:row.id,result:{contentBase64:"",sourceStateVectorSha256:"a".repeat(64)}}), () => process.exit(0));
          } else { throw new Error("Unexpected projection fixture request"); }
        }
      });
    `)}], options);
  }
  return originalSpawn(command, args, options);
};
syncBuiltinESMExports();
`;

  async function spawnRelay(
    dbPath: string,
    envOverrides: Record<string, string | undefined> = {},
  ): Promise<string> {
    return (await spawnRunningRelay(dbPath, envOverrides)).baseUrl;
  }

  async function spawnRunningRelay(
    dbPath: string,
    envOverrides: Record<string, string | undefined> = {},
    bootstrap: { rejectPoolEnd?: boolean; sourceEntry?: boolean; projectionHandshake?: boolean; emptyDeletionJobs?: boolean } = {},
  ): Promise<RunningRelay> {
    const mainUrl = bootstrap.sourceEntry
      ? new URL("./main.ts", import.meta.url)
      : pathToFileURL(join(buildDirectory, "main.js"));
    const childArguments = [
      ...(bootstrap.sourceEntry ? ["--import", process.platform === "win32" ? "tsx" : "tsx/esm"] : []),
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
    });
    if (${bootstrap.rejectPoolEnd === true}) {
      const { Pool } = await import("pg");
      const { writeSync } = await import("node:fs");
      Pool.prototype.end = async function () {
        writeSync(2, "SYNC_RELAY_TEST_POOL_END_REJECTED\\n");
        throw new Error("injected pool shutdown failure");
      };
    }
    ${bootstrap.emptyDeletionJobs ? EMPTY_DELETION_JOBS_BOOTSTRAP : ""}
    ${bootstrap.projectionHandshake ? PROJECTION_HANDSHAKE_BOOTSTRAP : ""}
    await import(${JSON.stringify(mainUrl.href)});`,
    ];
    const child = spawn(process.execPath, childArguments, {
      cwd: packageRoot(),
      env: {
        ...process.env,
        DOHC_RELAY_DEPLOYMENT_CONFIG: undefined,
        DOHC_RELAY_SERVICE_HOST_CONFIG: undefined,
        DOHC_RELAY_DEVICE_DELIVERY_CONFIG: undefined,
        DOHC_RELAY_APP_PUBLICATIONS: undefined,
        DOHC_RELAY_APP_COLLECTION_MAX_CREATES_PER_GRANT: undefined,
        DOHC_PUBLIC_EDIT_RELEASE: undefined,
        NODE_ENV: "test",
        SYNC_RELAY_TEST_AUTH: "1",
        SYNC_RELAY_PORT: "0",
        SYNC_RELAY_DB_PATH: dbPath,
        DOHC_RELAY_SHARE_WEB_ORIGIN: "http://127.0.0.1:48123",
        DOHC_RELAY_SHARE_WEB_URL: "http://127.0.0.1:48123",
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
      }, 45_000);
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
        reject(new Error(`sync relay exited before listening: ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      });
    });
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

  async function spawnRelayExpectExit(
    envOverrides: Record<string, string | undefined>,
    bootstrap: { projectionHandshake?: boolean; emptyDeletionJobs?: boolean } = {},
  ): Promise<{ code: number | null; stderr: string }> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries({ ...process.env, DOHC_RELAY_DEPLOYMENT_CONFIG: undefined, DOHC_RELAY_SERVICE_HOST_CONFIG: undefined, DOHC_RELAY_DEVICE_DELIVERY_CONFIG: undefined, DOHC_RELAY_SHARE_WEB_URL: "http://share-web:1790", ...envOverrides })) {
      if (value !== undefined) env[key] = value;
    }
    const mainPath = join(buildDirectory, "main.js");
    const args = bootstrap.projectionHandshake || bootstrap.emptyDeletionJobs
      ? ["--input-type=module", "--eval", `${bootstrap.emptyDeletionJobs ? EMPTY_DELETION_JOBS_BOOTSTRAP : ""}\n${bootstrap.projectionHandshake ? PROJECTION_HANDSHAKE_BOOTSTRAP : ""}\nawait import(${JSON.stringify(pathToFileURL(mainPath).href)});`]
      : [mainPath];
    const child = spawn(process.execPath, args, {
      cwd: packageRoot(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    children.push(child);
    return await new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => {
        reject(new Error(`sync relay did not exit\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }, 45_000);
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

  return { tempRoot, spawnRelay, spawnRunningRelay, authHeaders, postJson, exchangeLink, postJsonAs, putBytes, sha256, settleWithin, spawnRelayExpectExit, waitForExit, sendTerminationSignal, sendDoubleTerminationSignal };
}
