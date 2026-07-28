import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { desktopRoot } from "./desktopApp";

// Spawns the REAL sync-relay service (services/sync-relay) as a child
// process for the 0P sync E2E specs — the same pattern as the relay's own
// integration tests: NODE_ENV=test + SYNC_RELAY_TEST_AUTH accepts
// `Bearer test:<user>` without a Postgres auth backend, and SQLite storage
// lives on the spec's tmpfs fixture dir. WSL-safety: the child is tracked
// and stopped by PID via SIGTERM — never a pattern kill.

const relayRoot = join(desktopRoot, "../../services/sync-relay");

export interface SyncRelayHandle {
  baseUrl: string;
  port: number;
  dbPath: string;
  stop(): Promise<void>;
}

export async function spawnSyncRelay(input: {
  dbPath: string;
  // Restarts (the offline-rejoin spec) must come back on the SAME port the
  // desktop app already has in its credential file.
  port?: number;
}): Promise<SyncRelayHandle> {
  const child: ChildProcess = spawn(
    process.execPath,
    ["--import", "tsx/esm", "src/main.ts"],
    {
      cwd: relayRoot,
      env: {
        ...process.env,
        NODE_ENV: "test",
        SYNC_RELAY_TEST_AUTH: "1",
        SYNC_RELAY_PORT: String(input.port ?? 0),
        SYNC_RELAY_DB_PATH: input.dbPath,
        FORCE_COLOR: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const baseUrl = await new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(
        new Error(`sync relay did not report a port\nstdout:\n${stdout}\nstderr:\n${stderr}`),
      );
    }, 20_000);
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
    child.on("exit", (code) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `sync relay exited before listening: ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    });
  });

  const port = Number(new URL(baseUrl).port);
  return {
    baseUrl,
    port,
    dbPath: input.dbPath,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          // Our own child only — bounded escalation, never a pattern kill.
          child.kill("SIGKILL");
        }, 3_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill("SIGTERM");
      }),
  };
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

// R10b: the relay adopts the FIRST replication identity a pusher presents
// (the desktop daemon's, minted in its store) and never returns it over the
// wire — identity-less /log calls 409 once adoption happens. A headless
// "other machine" harness therefore learns the adopted coordinate the only
// way a harness can: from the relay's own SQLite row.
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
    return typeof row?.replicationEpoch === "string" && typeof row.streamIdentity === "string"
      ? { replicationEpoch: row.replicationEpoch, streamIdentity: row.streamIdentity }
      : null;
  } catch {
    // The db (or its schema) may not exist yet — "not adopted yet" to a poll.
    return null;
  } finally {
    db?.close();
  }
}
