import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realDaemonReaderConfig } from "../../src/testing/realDaemonWorkspaceSessions";

// Spawns the real sync-relay service (services/sync-relay) as a child
// process for the 0P sync E2E specs — the same pattern as the relay's own
// integration tests: NODE_ENV=test + SYNC_RELAY_TEST_AUTH accepts
// `Bearer test:<user>` without a Postgres auth backend, and SQLite storage
// lives in the spec's scratch directory. IPC requests orderly shutdown on
// Windows too, where child.kill("SIGTERM") would bypass the relay's cleanup.

const relayRoot = fileURLToPath(new URL("../../../../services/sync-relay/", import.meta.url));

export interface SyncRelayHandle {
  baseUrl: string;
  port: number;
  dbPath: string;
  stop(): Promise<void>;
  diagnostics(): { stdout: string; stderr: string };
}

export interface SyncRelayLinkBoundary {
  linkKey: string;
  relayExchangeKey: string;
  publicViewerOrigin: string;
}

export async function spawnSyncRelay(input: {
  /**
   * The relay database, in a folder of its own. Every relay runs from a deployment, as a
   * self-hosted relay does, and the deployment's files sit beside that folder. A restart
   * passes the same path and keeps the deployment.
   */
  dbPath: string;
  // A suite may reuse freshly built code while keeping each process and store separate.
  compiledMain?: string;
  // Restarts (the offline-rejoin spec) must come back on the same port the
  // desktop app already has in its credential file.
  port?: number;
  linkBoundary?: SyncRelayLinkBoundary;
  appPublications?: boolean;
  /**
   * Releases Edit share links the way a self-hosted relay does: the deployment's
   * live host runs this engine. Needs the link boundary.
   */
  editLinks?: { engineExecutable: string; publicOrigin: string; trustEnv?: Record<string, string> };
}): Promise<SyncRelayHandle> {
  const started = performance.now();
  const deployment = `${dirname(input.dbPath)}-deployment`;
  // A restart keeps the deployment and live host stores the first start made.
  if (!existsSync(join(deployment, "deployment.json"))) {
    const command = input.compiledMain
      ? [join(dirname(input.compiledMain), "relay-deployment.js")]
      : ["--import", "tsx/esm", "src/relayDeploymentCommand.ts"];
    await initializeRelayDeployment([...command, "initialize",
      "--config", join(deployment, "deployment.json"), "--database", input.dbPath, "--continuity-directory", join(deployment, "continuity")]);
    if (input.editLinks) mkdirSync(join(deployment, "live-host"));
  }
  // share-web reaches the relay's live routes at its loopback address, and they accept only listed hosts.
  const listenPort = input.port ?? (input.editLinks ? await reserveRelayPort() : 0);
  const child: ChildProcess = spawn(
    process.execPath,
    [
      ...(input.compiledMain === undefined
        ? ["--import", process.platform === "win32" ? "tsx" : "tsx/esm"]
        : []),
      "--input-type=module", "--eval",
      `process.on("message", (message) => {
        if (message === "SIGTERM") process.emit("SIGTERM");
      });
      await import(${JSON.stringify(pathToFileURL(input.compiledMain ?? join(relayRoot, "src/main.ts")).href)});`,
    ],
    {
      cwd: relayRoot,
      env: {
        ...process.env,
        DOHC_RELAY_SERVICE_HOST_CONFIG: undefined,
        DOHC_RELAY_DEVICE_DELIVERY_CONFIG: undefined,
        NODE_ENV: "test",
        SYNC_RELAY_TEST_AUTH: "1",
        SYNC_RELAY_PORT: String(listenPort),
        SYNC_RELAY_DB_PATH: undefined,
        DOHC_RELAY_DEPLOYMENT_CONFIG: join(deployment, "deployment.json"),
        ...(input.appPublications ? { DOHC_RELAY_APP_PUBLICATIONS: "1" } : {}),
        ...(input.linkBoundary
          ? {
              DOHC_RELAY_LINK_KEY: input.linkBoundary.linkKey,
              DOHC_RELAY_EXCHANGE_KEY: input.linkBoundary.relayExchangeKey,
              DOHC_RELAY_SHARE_WEB_ORIGIN: input.linkBoundary.publicViewerOrigin,
              DOHC_RELAY_SHARE_WEB_URL: input.linkBoundary.publicViewerOrigin,
            }
          : {}),
        ...(input.editLinks
          ? {
              DOHC_SELF_HOST_LIVE: "1",
              DOHC_RELAY_SERVICE_HOST_ROOT: join(deployment, "live-host"),
              DOHC_RELAY_ENGINE_EXECUTABLE: input.editLinks.engineExecutable,
              DOHC_RELAY_ALLOW_UNISOLATED_PROJECTION: "1",
              DOHC_RELAY_PUBLIC_ORIGIN: input.editLinks.publicOrigin,
              DOHC_RELAY_NAMED_LIVE_HOSTS: [new URL(input.editLinks.publicOrigin).host, `127.0.0.1:${listenPort}`].join(","),
              // The self-host image gives the live host a Markdown reader. Without one it holds every lossy rewrite.
              DOHC_ENGINE_READER_CONFIG: realDaemonReaderConfig(),
              ...input.editLinks.trustEnv,
            }
          : {}),
        FORCE_COLOR: "0",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    },
  );
  // Register at spawn: exitCode can be set before the process's stdio closes.
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => stopping ??= (async () => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
      await closed;
      return;
    }
    // Allow the service's 10 s HTTP drain, then bound a wedged child's lifetime.
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    try {
      if (child.connected) {
        child.send("SIGTERM", (error) => {
          if (error) child.kill("SIGTERM");
        });
      } else {
        child.kill("SIGTERM");
      }
      await closed;
    } finally {
      clearTimeout(timer);
    }
  })();
  const startupStatus = () =>
    `after ${Math.round(performance.now() - started)}ms ` +
    `(pid=${child.pid}, exit=${child.exitCode}, signal=${child.signalCode})`;

  let stdout = "";
  let stderr = "";
  const baseUrl = await new Promise<string>((resolve, reject) => {
    // A hang guard, not a speed bound: a loaded gate can take well over 20 s to start
    // the relay, and a relay that dies is reported at once by the exit handler below.
    const timeout = setTimeout(() => {
      reject(
        new Error(
          `sync relay did not report a port ${startupStatus()}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    }, 120_000);
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
      const match = /SYNC_RELAY_LISTENING host=([^\s]+) port=(\d+)/u.exec(stdout);
      if (match) {
        clearTimeout(timeout);
        resolve(`http://${match[1]}:${match[2]}`);
      }
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", () => {
      clearTimeout(timeout);
      reject(
        new Error(
          `sync relay exited before listening ${startupStatus()}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    });
  }).catch(async (error: unknown) => {
    await stop();
    throw error;
  });
  try {
    await requireOwnerRestoreList(baseUrl);
  } catch (error) {
    await stop();
    throw new Error(`sync relay failed its startup check ${startupStatus()}\nstdout:\n${stdout}\nstderr:\n${stderr}`, { cause: error });
  }

  const port = Number(new URL(baseUrl).port);
  return {
    baseUrl,
    port,
    dbPath: input.dbPath,
    diagnostics: () => ({ stdout, stderr }),
    stop,
  };
}

async function reserveRelayPort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  if (!address || typeof address === "string") throw new Error("No relay port reserved.");
  return address.port;
}

// An owner's list of unfinished restores reads the deployment's history. A relay without one answers 500.
async function requireOwnerRestoreList(baseUrl: string): Promise<void> {
  const workspaceId = randomUUID();
  const headers = { authorization: "Bearer test:relay-startup-check", "content-type": "application/json" };
  // A hang guard: a relay that takes the requests and never answers fails startup, which stops it.
  const signal = AbortSignal.timeout(60_000);
  const claim = await fetch(`${baseUrl}/sync/workspaces`, { method: "POST", headers, body: JSON.stringify({ workspaceId }), signal });
  if (!claim.ok) throw new Error(`Claiming a workspace answered ${claim.status}: ${await claim.text()}`);
  const restores = await fetch(`${baseUrl}/sync/${workspaceId}/live-restores/unfinished`, { headers, signal });
  if (restores.status !== 200) throw new Error(`Unfinished restores answered ${restores.status}: ${await restores.text()}`);
}

async function initializeRelayDeployment(args: string[]): Promise<void> {
  const started = performance.now();
  const child = spawn(process.execPath, args, { cwd: relayRoot, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  let stdout = "", stderr = "";
  child.stdout?.on("data", chunk => { stdout += String(chunk); });
  child.stderr?.on("data", chunk => { stderr += String(chunk); });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("Deployment initializer did not finish.")), 120_000);
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`Deployment initializer exited with code=${code}, signal=${signal}.`));
      });
    });
  } catch (error) {
    if (child.pid && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
    throw new Error(`sync relay deployment initialization failed after ${Math.round(performance.now() - started)}ms ` +
      `(pid=${child.pid}, exit=${child.exitCode}, signal=${child.signalCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`, { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}

export interface RelayWorkspaceIdentity {
  replicationEpoch: string;
  streamIdentity: string;
}

const requireModule = createRequire(import.meta.url);
const { DatabaseSync } = requireModule("node:sqlite") as {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean },
  ) => {
    prepare(sql: string): { get(...params: unknown[]): Record<string, unknown> | undefined };
    close(): void;
  };
};

// R10b: the relay adopts the first replication identity a pusher presents.
// Identity-less /log calls then fail; the owner-only /bootstrap route is the
// production handoff for a joining daemon. Harnesses still inspect SQLite here
// to assert adoption itself and to drive tests that do not run the join flow.
// Only "the db file does not exist yet" reads as "not adopted yet" to a
// poll; anything else — including schema drift ("no such table") and the
// malformed-row throw below (whose message embeds raw values that could
// contain arbitrary text) — must fail loud. Classify by error code, and only
// for the open failure, never by matching message text.
function isRelayDbNotReady(error: unknown, dbOpened: boolean): boolean {
  if (dbOpened) return false;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "SQLITE_CANTOPEN";
}

export function relayAdoptedIdentity(
  dbPath: string,
  workspaceId: string,
): RelayWorkspaceIdentity | null {
  let db: InstanceType<typeof DatabaseSync> | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db
      .prepare(
        `SELECT replication_epoch AS replicationEpoch, stream_identity AS streamIdentity
         FROM sync_relay_workspaces WHERE workspace_id = ?`,
      )
      .get(workspaceId);
    if (row === undefined) return null;
    const epoch = row.replicationEpoch ?? null;
    const stream = row.streamIdentity ?? null;
    if (epoch === null && stream === null) return null;
    // The relay's own storage layer treats a partial identity pair as
    // corruption — surface it, never "not adopted yet".
    if (typeof epoch !== "string" || typeof stream !== "string") {
      throw new Error(
        `sync relay identity row is malformed for ${workspaceId}: ` +
          `replication_epoch=${JSON.stringify(epoch)} stream_identity=${JSON.stringify(stream)}`,
      );
    }
    return { replicationEpoch: epoch, streamIdentity: stream };
  } catch (error) {
    if (isRelayDbNotReady(error, db !== null)) return null;
    throw error;
  } finally {
    db?.close();
  }
}
