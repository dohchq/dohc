import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Two DIFFERENT clients over a REAL relay child process (the SYNC_RELAY_TEST_AUTH
// bearer seam), proving the ephemeral awareness transport end to end: client A
// sees client B come online + type, and B leaving clears B for A — all with no
// durable log write.

let roots: string[] = [];
let children: ChildProcess[] = [];

beforeEach(() => {
  roots = [];
  children = [];
});

afterEach(async () => {
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve();
          const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
          child.once("close", () => {
            clearTimeout(force);
            resolve();
          });
          child.kill("SIGTERM");
        }),
    ),
  );
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

function packageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
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
    const timeout = setTimeout(
      () => reject(new Error(`relay did not report a port\n${stdout}\n${stderr}`)),
      15_000,
    );
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
      reject(new Error(`relay exited before listening: ${code}\n${stdout}\n${stderr}`));
    });
  });
}

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dohc-presence-int-"));
  roots.push(root);
  return root;
}

function bearer(userId: string): Record<string, string> {
  return { authorization: `Bearer test:${userId}` };
}

async function claimWorkspace(baseUrl: string, userId: string, workspaceId: string): Promise<void> {
  const r = await fetch(`${baseUrl}/sync/workspaces`, {
    method: "POST",
    headers: { ...bearer(userId), "content-type": "application/json" },
    body: JSON.stringify({ workspaceId }),
  });
  expect(r.status).toBe(200);
}

interface Peer {
  userId: string;
  clientId: string;
  state: unknown;
}

async function publish(
  baseUrl: string,
  userId: string,
  workspaceId: string,
  topic: string,
  body: Record<string, unknown>,
): Promise<Peer[]> {
  const r = await fetch(
    `${baseUrl}/sync/${workspaceId}/presence?topic=${encodeURIComponent(topic)}`,
    {
      method: "POST",
      headers: { ...bearer(userId), "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  expect(r.status).toBe(200);
  return ((await r.json()) as { peers: Peer[] }).peers;
}

async function poll(
  baseUrl: string,
  userId: string,
  workspaceId: string,
  topic: string,
  since: number,
  hold: number,
): Promise<{ version: number; peers: Peer[] }> {
  const r = await fetch(
    `${baseUrl}/sync/${workspaceId}/presence?topic=${encodeURIComponent(topic)}&since=${since}&hold=${hold}`,
    { method: "GET", headers: bearer(userId) },
  );
  expect(r.status).toBe(200);
  return (await r.json()) as { version: number; peers: Peer[] };
}

describe("two-client presence over a real relay child", () => {
  it("A sees B come online, type, and clear on leave", async () => {
    const relayRoot = await tempDir();
    const baseUrl = await spawnRelay(join(relayRoot, "relay.sqlite"));

    // A and B are the SAME workspace owner across two devices/tabs (both
    // authorized by workspaceIsOwnedBy). Distinct clientIds => two entries.
    const ws = "workspace-presence";
    await claimWorkspace(baseUrl, "owner", ws);

    // A appears.
    const afterA = await publish(baseUrl, "owner", ws, "general", {
      clientId: "A",
      state: { displayName: "Ice", typing: false },
    });
    expect(afterA.map((p) => p.clientId)).toEqual(["A"]);

    // A long-polls (parked); B appears typing -> A wakes and sees B typing.
    // Seed the poll `since` correctly: read the current version first.
    const current = await poll(baseUrl, "owner", ws, "general", 0, 0);
    const wake = poll(baseUrl, "owner", ws, "general", current.version, 10_000);
    await publish(baseUrl, "owner", ws, "general", {
      clientId: "B",
      state: { displayName: "Bee", typing: true },
    });
    const woke = await wake;
    const bee = woke.peers.find((p) => p.clientId === "B");
    expect(bee?.state).toMatchObject({ displayName: "Bee", typing: true });

    // B leaves -> A's next read no longer shows B.
    await fetch(`${baseUrl}/sync/${ws}/presence?topic=general`, {
      method: "POST",
      headers: { ...bearer("owner"), "content-type": "application/json" },
      body: JSON.stringify({ clientId: "B", leave: true }),
    });
    const afterLeave = await poll(baseUrl, "owner", ws, "general", 0, 0);
    expect(afterLeave.peers.map((p) => p.clientId)).toEqual(["A"]);
  }, 30_000);

  it("a non-owner cannot read another workspace's presence (isolation)", async () => {
    const relayRoot = await tempDir();
    const baseUrl = await spawnRelay(join(relayRoot, "relay.sqlite"));
    await claimWorkspace(baseUrl, "owner", "private-ws");
    const r = await fetch(`${baseUrl}/sync/private-ws/presence?topic=general&since=0&hold=0`, {
      method: "GET",
      headers: bearer("intruder"),
    });
    expect(r.status).toBe(404);
  }, 30_000);

  it("a client DISCONNECT releases its parked long-poll waiter promptly", async () => {
    const relayRoot = await tempDir();
    const baseUrl = await spawnRelay(join(relayRoot, "relay.sqlite"));
    const ws = "workspace-disconnect";
    await claimWorkspace(baseUrl, "owner", ws);
    await publish(baseUrl, "owner", ws, "general", { clientId: "A", state: {} });
    const current = await poll(baseUrl, "owner", ws, "general", 0, 0);

    // Park a long-poll over a REAL socket, then tear the socket down. The
    // node adapter must propagate the disconnect into the fetch Request's
    // AbortSignal so the hub releases the parked waiter — long before the
    // 20s hold would have expired.
    const controller = new AbortController();
    const parked = fetch(
      `${baseUrl}/sync/${ws}/presence?topic=general&since=${current.version}&hold=20000`,
      { method: "GET", headers: bearer("owner"), signal: controller.signal },
    ).catch(() => undefined);
    await waitForWaiters(baseUrl, 1);
    controller.abort(); // client vanishes mid-park
    await parked;
    await waitForWaiters(baseUrl, 0);
  }, 30_000);
});

// Poll the test-seam health endpoint until the hub reports `expected` parked
// waiters (bounded; fails the test with a clear message on timeout).
async function waitForWaiters(baseUrl: string, expected: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  let last: unknown;
  while (Date.now() < deadline) {
    const health = (await (await fetch(`${baseUrl}/health`)).json()) as {
      presence?: { waiters: number };
    };
    last = health.presence;
    if (health.presence?.waiters === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`relay never reached ${expected} parked waiter(s); last=${JSON.stringify(last)}`);
}
