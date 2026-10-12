import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { createReplicaEngineStarter } from "./replicaEngine";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
afterEach(() => { vi.useRealTimers(); mocks.spawn.mockReset(); });

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
            row.method === "sync.pull" ? this.pages.shift() : { adopted: true, committed: true };
          this.stdout.write(frame({ type: "response", id: row.id, result }));
        }
      }
    });
  }
  finish() { this.stdout.end(); this.stderr.end(); this.emit("close", 0, "SIGKILL"); }
}
const input = () => ({ storeDir: process.cwd(), lease: { workspaceId: "w", ownerUserId: "owner", replicationEpoch: "epoch",
  streamIdentity: "stream", logSeq: 3, shareGrantBindings: '[["grant",1]]', incarnation: "private", bearer: "dohc-replica-read-v1.test" } });
async function fixture(child = new Child()) {
  mocks.spawn.mockReturnValue(child);
  const start = createReplicaEngineStarter({ engineExecutable: process.execPath, baseUrl: "https://relay.test", allowUnisolatedDevelopment: true });
  return { child, replica: await start(input()) };
}

it("gives the child only its private directory, fresh RPC token, and GET lease", async () => {
  const { child, replica } = await fixture();
  try {
    await replica.pull();
    expect(child.requests.map(row => row.method)).toEqual(["workspace.open", "sync.adoptJoinIdentity", "sync.pull", "sync.commitCursor", "sync.pull", "sync.commitCursor"]);
    expect(child.requests[0]!.params).toMatchObject({ rootDir: input().storeDir, storeMode: "passive", captureMode: "none",
      relay: { baseUrl: "https://relay.test", bearerToken: input().lease.bearer } });
    expect(child.requests.slice(1).every(row => row.workspace === "private-handle")).toBe(true);
    expect(child.requests[3]!.params.pendingCursor).toEqual({ kind: "relay", token: "issued-2" });
    expect(child.requests[5]!.params.pendingCursor).toEqual({ kind: "relay", token: "issued-3" });
    const [command, args, options] = mocks.spawn.mock.calls[0]!;
    expect(command).toBe(process.execPath); expect(args).toEqual([]); expect(options.cwd).toBe(input().storeDir);
    expect(Object.keys(options.env)).toEqual(["DOHC_ENGINE_AUTH_TOKEN"]); expect(options.env.DOHC_ENGINE_AUTH_TOKEN).toMatch(/^[a-f0-9]{64}$/);
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
