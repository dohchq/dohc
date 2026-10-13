import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { createReplicaEngineStarter } from "./replicaEngine";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
afterEach(() => { vi.useRealTimers(); mocks.spawn.mockReset(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const frame = (row: unknown) => {
  const bytes = Buffer.from(JSON.stringify(row)), header = Buffer.alloc(12);
  header.write("DOP1"); header[4] = 1; header.writeUInt32LE(bytes.length, 8); return Buffer.concat([header, bytes]);
};
class Child extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough(); pid = 123;
  manualClose = false;
  requests: Array<{ method: string; workspace?: string; params: Record<string, unknown> }> = [];
  pages = [{ status: "complete", nextCursor: 2, pendingCursor: { kind: "relay", token: "issued-2" }, hasMore: true },
    { status: "complete", nextCursor: 3, pendingCursor: { kind: "relay", token: "issued-3" }, hasMore: false }];
  kill = vi.fn(() => { if (!this.manualClose) this.finish(); return true; });
  constructor() {
    super(); let buffered = Buffer.alloc(0);
    this.stdin.on("data", (bytes: Buffer) => {
      buffered = Buffer.concat([buffered, bytes]);
      while (buffered.length >= 12 && buffered.length >= 12 + buffered.readUInt32LE(8)) {
        const length = buffered.readUInt32LE(8), row = JSON.parse(buffered.subarray(12, 12 + length).toString());
        buffered = buffered.subarray(12 + length);
        if (row.type === "hello") this.stdout.write(frame({ type: "helloAck", protocolVersion: 2, sessionGeneration: 1,
          capabilities: ["blobs"], limits: { maxFrameBytes: 14 * 1024 * 1024, maxStringBytes: 14 * 1024 * 1024,
            maxCollectionLen: 16_384, maxJsonDepth: 32, maxBatchLen: 64, maxBlobChunkBytes: 262_144 } }));
        else {
          this.requests.push(row);
          const result = row.method === "workspace.open" ? { workspace: "private-handle" } :
            row.method === "replica.frontiers" ? {revision: 1, logCursor: 3, journalCursor: 0} :
            row.method === "sync.pull" ? this.pages.shift() : { adopted: true, committed: true };
          this.stdout.write(frame({ type: "response", id: row.id, result }));
        }
      }
    });
  }
  finish() { this.stdout.end(); this.stderr.end(); this.emit("close", 0, "SIGKILL"); }
}
const input = () => ({ storeDir: process.cwd(), lease: { workspaceId: "w", ownerUserId: "owner", replicationEpoch: "epoch",
  streamIdentity: "stream", epochLogFloor: 0, logSeq: 3, journalCursor: 0, shareGrantBindings: '[["grant",1]]', incarnation: "private", bearer: "dohc-replica-read-v1.test" } });
async function fixture(child = new Child()) {
  mocks.spawn.mockReturnValue(child);
  vi.stubGlobal("fetch", vi.fn(async () => ({ok: true, json: async () => ({rows: [], nextCursor: 0, hasMore: false})})));
  const start = createReplicaEngineStarter({ engineExecutable: process.execPath, baseUrl: "https://relay.test", allowUnisolatedDevelopment: true });
  return { child, replica: await start(input()) };
}

it("gives the child only its private directory, fresh RPC token, and GET lease", async () => {
  const { child, replica } = await fixture();
  try {
    await replica.pull();
    expect(child.requests.map(row => row.method)).toEqual(["workspace.open", "sync.adoptJoinIdentity", "sync.pull", "sync.commitCursor", "sync.pull", "sync.commitCursor", "replica.frontiers"]);
    expect(child.requests[0]!.params).toMatchObject({ rootDir: input().storeDir, storeMode: "passive", captureMode: "none",
      relay: { baseUrl: "https://relay.test", bearerToken: input().lease.bearer } });
    expect(child.requests.slice(1).every(row => row.workspace === "private-handle")).toBe(true);
    expect(child.requests[3]!.params.pendingCursor).toEqual({ kind: "relay", token: "issued-2" });
    expect(child.requests[5]!.params.pendingCursor).toEqual({ kind: "relay", token: "issued-3" });
    const [command, args, options] = mocks.spawn.mock.calls[0]!;
    expect(command).toBe(process.execPath); expect(args).toEqual(["--store-role", "passive"]); expect(options.cwd).toBe(input().storeDir);
    expect(Object.keys(options.env).sort()).toEqual(process.platform === "win32" ? ["DOHC_ENGINE_AUTH_TOKEN", "SystemRoot"] : ["DOHC_ENGINE_AUTH_TOKEN"]);
    expect(options.env.DOHC_ENGINE_AUTH_TOKEN).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(child.requests)).not.toContain("serviceHost"); expect(JSON.stringify(child.requests)).not.toContain("ownerSecret");
  } finally { await replica.close(); }
});

it("refuses a non-progressing native pull instead of spinning forever", async () => {
  const child = new Child(); child.pages[1] = { ...child.pages[0]! };
  const { replica } = await fixture(child);
  try {
    await expect(replica.pull()).rejects.toThrow("progressing cursor");
    expect(child.requests.filter(row => row.method === "sync.commitCursor")).toHaveLength(1);
  } finally { await replica.close(); }
});

it("waits for actual child termination before closing", async () => {
  const { child, replica } = await fixture(); child.manualClose = true;
  let closed = false; const closing = replica.close().then(() => { closed = true; });
  await Promise.resolve(); expect(closed).toBe(false); expect(child.kill).toHaveBeenCalled();
  child.finish(); await closing; expect(closed).toBe(true);
});

it("requires development opt-in even on Linux until isolation exists", () => {
  vi.stubGlobal("process", { ...process, platform: "linux" });
  expect(() => createReplicaEngineStarter({ engineExecutable: process.execPath, baseUrl: "https://relay.test" })).toThrow(/development/i);
});

it("gives a Windows development child SystemRoot without inheriting other environment", async () => {
  vi.stubGlobal("process", { ...process, platform: "win32" });
  vi.stubEnv("SystemRoot", "C:\\Windows");
  const { replica } = await fixture();
  try {
    const env = mocks.spawn.mock.calls[0]![2].env;
    expect(env.SystemRoot).toBe("C:\\Windows");
    expect(Object.keys(env).sort()).toEqual(["DOHC_ENGINE_AUTH_TOKEN", "SystemRoot"]);
  } finally { await replica.close(); }
});

it("exposes child exit while idle so the supervisor can retire it", async () => {
  const { child, replica } = await fixture();
  try {
    const exited = (replica as { exited?: Promise<void> }).exited;
    expect(exited).toBeInstanceOf(Promise);
    child.finish(); await exited;
  } finally { await replica.close(); }
});
