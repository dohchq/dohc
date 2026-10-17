import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

/** What each removed directory held at removal: what a run interrupted at that point would leave behind. */
const removed = vi.hoisted(() => new Map<string, string[]>());
vi.mock("node:fs/promises", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, rm: async (...args: Parameters<typeof fs.rm>) => {
    const listing = await fs.readdir(args[0]).catch(() => undefined);
    if (listing) removed.set(String(args[0]), listing);
    return fs.rm(...args);
  } };
});

import { initializeRelayDeployment, openRelayDeployment } from "./relayDeployment";
import { checkRelayBackup, restoreRelayDeployment } from "./relayDeploymentRecovery";
import { captureRelaySnapshot, filesystemSpace, openRelaySnapshot, relaySnapshotKey, relaySnapshotSpaceNeeded, saveRelaySnapshot,
  sealRelaySnapshot, signS3Request, snapshotStorageFromEnv, uploadRelaySnapshot, withRelaySnapshot, type SnapshotStorage } from "./relaySnapshot";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dohc-relay-snapshot-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const input = { configPath: join(root, "control", "deployment.json"), relayPath: join(root, "relay", "relay.sqlite"), continuityDirectory: join(root, "continuity") };
  initializeRelayDeployment(input);
  const state = join(root, "snapshots"), key = randomBytes(32);
  // The free-space check reads the real disk only in its own tests, so a full development disk does not fail the others.
  const options = { relayPath: input.relayPath, stateDirectory: state, key, release: "r", space: async () => ({ free: 1024 * gib, total: 1024 * gib }) };
  return { ...input, root, state, key, options };
}
/** After a run, the state directory keeps only the lock database: the staging folder is gone. */
const afterRun = ["snapshot.lock"];
const gib = 1024 ** 3;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Commits marker and evidence together, the way relay writes advance their stamp. */
const writerScript = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("PRAGMA busy_timeout=5000");
const step = db.prepare("UPDATE sync_relay_continuity SET stamp=stamp+1 RETURNING stamp");
const evidence = db.prepare("INSERT INTO evidence VALUES (?, randomblob(512))");
let stopped = false;
process.stdin.on("end", () => { stopped = true; }).resume();
(function write() {
  if (stopped) { db.close(); return; }
  for (let i = 0; i < 20; i++) { db.exec("BEGIN IMMEDIATE"); const { stamp } = step.get(); evidence.run(stamp); db.exec("COMMIT"); }
  console.log(db.prepare("SELECT stamp FROM sync_relay_continuity").get().stamp);
  setImmediate(write);
})();`;

function startWriter(relayPath: string) {
  const child = spawn(process.execPath, ["-e", writerScript, relayPath], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
  const exited = new Promise<number | null>(resolve => child.on("exit", resolve));
  cleanups.push(async () => { if (child.exitCode === null) { child.kill(); await exited; } });
  const lines = createInterface({ input: child.stdout! });
  let latest = 0;
  const waiters: { above: number; resolve: () => void }[] = [];
  lines.on("line", line => {
    latest = Number(line);
    for (const waiter of waiters.splice(0)) if (latest > waiter.above) waiter.resolve(); else waiters.push(waiter);
  });
  return {
    reached: (above: number) => latest > above ? Promise.resolve() : new Promise<void>(resolve => waiters.push({ above, resolve })),
    stop: async () => { child.stdin!.end(); expect(await exited).toBe(0); },
  };
}

interface StoredObject { body: Buffer; headers: IncomingMessage["headers"] }
async function fakeS3(behavior: { dropAfterBytes?: number } = {}) {
  const objects = new Map<string, StoredObject>(), methods: string[] = [], received: Buffer[] = [];
  const server: Server = createServer((request, response) => {
    methods.push(request.method ?? "");
    const chunks: Buffer[] = [];
    let length = 0;
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      length += chunk.length;
      if (behavior.dropAfterBytes !== undefined && length >= behavior.dropAfterBytes) {
        received.push(Buffer.concat(chunks));
        request.socket.destroy();
      }
    });
    request.on("end", () => {
      const body = Buffer.concat(chunks), headers = request.headers;
      const signed = { "content-md5": String(headers["content-md5"]), host: headers.host!,
        "x-amz-content-sha256": String(headers["x-amz-content-sha256"]), "x-amz-date": String(headers["x-amz-date"]) };
      const expected = signS3Request({ method: request.method!, path: request.url!, headers: signed, ...credentials });
      // S3 stores an object only when the body is whole and matches its signed checksums. A bucket with Object Lock requires Content-MD5.
      if (request.method !== "PUT" || headers.authorization !== expected || sha256(body) !== signed["x-amz-content-sha256"] ||
          createHash("md5").update(body).digest("base64") !== signed["content-md5"] || body.length !== Number(headers["content-length"])) {
        response.writeHead(400).end("<Error><Code>BadDigest</Code></Error>");
        return;
      }
      objects.set(request.url!, { body, headers });
      response.writeHead(200).end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address() as { port: number };
  const storage: SnapshotStorage = { endpoint: new URL(`http://127.0.0.1:${address.port}`), bucket: "dohc-snapshots", ...credentials };
  return { storage, objects, methods, received };
}
const credentials = { region: "auto", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret-example" };

describe("online relay snapshots", () => {
  it("captures one consistent transaction while another process keeps writing", async () => {
    const f = fixture();
    const setup = new DatabaseSync(f.relayPath);
    setup.exec("CREATE TABLE evidence(stamp INTEGER PRIMARY KEY, padding BLOB)");
    setup.close();
    const writer = startWriter(f.relayPath);
    await writer.reached(200);
    const output = join(f.root, "verified");
    const manifest = await withRelaySnapshot({ ...f.options, release: "test-release" },
      async snapshot => {
        // Writes continue after the copy; the snapshot did not hold the writer back.
        await writer.reached(snapshot.manifest.stamp + 100);
        return openRelaySnapshot(await saveRelaySnapshot(snapshot, join(f.root, "saved")), f.key, output);
      });
    await writer.stop();
    expect(manifest.stamp).toBeGreaterThan(200);
    expect(manifest.release).toBe("test-release");
    const copy = new DatabaseSync(join(output, "relay.sqlite"), { readOnly: true });
    try {
      const evidence = copy.prepare("SELECT count(*) AS count, max(stamp) AS latest FROM evidence").get();
      expect(evidence).toEqual({ count: manifest.stamp, latest: manifest.stamp });
    } finally { copy.close(); }
    expect(readdirSync(f.state)).toEqual(afterRun);
  });

  it("restores through today's restore when continuity matches, and refuses once it advances", async () => {
    const f = fixture(), live = openRelayDeployment(f.configPath);
    let snapshotPath: string;
    try {
      live.storage.claimWorkspace({ workspaceId: "w", ownerUserId: "owner", createdAtMs: 1 });
      snapshotPath = await withRelaySnapshot(f.options,
        snapshot => saveRelaySnapshot(snapshot, join(f.root, "saved")));
    } finally { live.storage.close(); }
    const verified = join(f.root, "verified");
    await openRelaySnapshot(snapshotPath, f.key, verified);
    writeFileSync(f.relayPath, "damaged database");
    await restoreRelayDeployment(f.configPath, verified);
    const reopened = openRelayDeployment(f.configPath);
    try { expect(reopened.storage.claimWorkspace({ workspaceId: "w", ownerUserId: "owner", createdAtMs: 1 })).toBe("owned"); }
    finally { reopened.storage.close(); }
    const next = openRelayDeployment(f.configPath);
    next.storage.claimWorkspace({ workspaceId: "second", ownerUserId: "owner", createdAtMs: 2 });
    next.storage.close();
    await expect(checkRelayBackup(f.configPath, verified)).rejects.toThrow(/continuity/);
  });

  it("refuses a stopped relay and leaves no staging copy behind", async () => {
    const f = fixture();
    await expect(withRelaySnapshot(f.options, async () => "unused")).rejects.toThrow(/running relay/);
    expect(readdirSync(f.state)).toEqual(afterRun);
    // A relay folder that isn't there reads as a stopped relay, not a failed disk check.
    await expect(withRelaySnapshot({ ...f.options, relayPath: join(f.state, "missing", "sync-relay.sqlite"), space: undefined }, async () => "unused"))
      .rejects.toThrow(/running relay/);
  });

  it("refuses before copying unless both disks hold two copies plus the relay's headroom", async () => {
    // Headroom is the relay's own size, at least 1 GiB and at most a tenth of the disk.
    expect(relaySnapshotSpaceNeeded(3 * gib, 1800 * gib)).toBe(9 * gib);
    expect(relaySnapshotSpaceNeeded(3 * gib, 20 * gib)).toBe(8 * gib);
    expect(relaySnapshotSpaceNeeded(gib / 4, 1800 * gib)).toBe(1.5 * gib);
    expect(relaySnapshotSpaceNeeded(3 * gib, 5 * gib)).toBe(7 * gib);
    const f = fixture(), live = openRelayDeployment(f.configPath);
    try {
      live.storage.claimWorkspace({ workspaceId: "w", ownerUserId: "owner", createdAtMs: 1 });
      const needed = 2 * (statSync(f.relayPath).size + statSync(`${f.relayPath}-wal`).size) + gib, total = 100 * gib;
      const attempt = (relayFree: number, snapshotsFree: number) => withRelaySnapshot({ ...f.options,
        space: async path => ({ free: path === dirname(f.relayPath) ? relayFree : snapshotsFree, total }) }, async snapshot => snapshot.manifest.stamp);
      await expect(attempt(needed - 1, needed)).rejects.toThrow(/free on the relay's disk.*No snapshot was taken/);
      expect(readdirSync(f.state)).toEqual(afterRun);
      await expect(attempt(needed, needed - 1)).rejects.toThrow(/free on the snapshots folder's disk.*No snapshot was taken/);
      expect(readdirSync(f.state)).toEqual(afterRun);
      expect(await attempt(needed, needed)).toBeGreaterThan(0);
    } finally { live.storage.close(); }
    const space = await filesystemSpace(f.root);
    expect(space.free).toBeGreaterThan(0);
    expect(space.total).toBeGreaterThanOrEqual(space.free);
  });

  it("runs one snapshot at a time, and a refused run leaves the running one's staging alone", async () => {
    const f = fixture(), live = openRelayDeployment(f.configPath);
    try {
      live.storage.claimWorkspace({ workspaceId: "w", ownerUserId: "owner", createdAtMs: 1 });
      await withRelaySnapshot(f.options, async snapshot => {
        await expect(withRelaySnapshot(f.options, async () => "unused")).rejects
          .toThrow("Another snapshot is running, so no snapshot was taken. Try again after it finishes.");
        expect(existsSync(snapshot.path)).toBe(true);
      });
      // The lock frees when its holder finishes.
      expect(await withRelaySnapshot(f.options, async snapshot => snapshot.manifest.stamp)).toBeGreaterThan(0);
    } finally { live.storage.close(); }
  });

  it("frees the lock when a killed process held it", async () => {
    const f = fixture(), live = openRelayDeployment(f.configPath);
    const unfinished = join(f.state, "staging", "relay.sqlite");
    mkdirSync(dirname(unfinished), { recursive: true });
    writeFileSync(unfinished, "a killed run's copy");
    const holder = spawn(process.execPath, ["-e", `const { DatabaseSync } = require("node:sqlite");
      globalThis.lock = new DatabaseSync(process.argv[1]); lock.exec("BEGIN EXCLUSIVE"); console.log("held"); setInterval(() => {}, 60_000);`, join(f.state, "snapshot.lock")],
      { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
    const exited = new Promise(resolve => holder.on("exit", resolve));
    cleanups.push(async () => { if (holder.exitCode === null && holder.signalCode === null) { holder.kill("SIGKILL"); await exited; } });
    await new Promise<void>(resolve => createInterface({ input: holder.stdout! }).on("line", line => { if (line === "held") resolve(); }));
    try {
      live.storage.claimWorkspace({ workspaceId: "w", ownerUserId: "owner", createdAtMs: 1 });
      await expect(withRelaySnapshot(f.options, async () => "unused")).rejects.toThrow(/Another snapshot is running/);
      expect(readFileSync(unfinished, "utf8")).toBe("a killed run's copy");
      holder.kill("SIGKILL");
      await exited;
      expect(await withRelaySnapshot(f.options, async snapshot => snapshot.manifest.stamp)).toBeGreaterThan(0);
      expect(readdirSync(f.state)).toEqual(afterRun);
    } finally { live.storage.close(); }
  });
});

describe("sealed snapshot packages", () => {
  async function sealed(f: ReturnType<typeof fixture>) {
    const live = openRelayDeployment(f.configPath);
    try {
      live.storage.claimWorkspace({ workspaceId: "w", ownerUserId: "owner", createdAtMs: 1 });
      return await withRelaySnapshot(f.options, snapshot => saveRelaySnapshot(snapshot, join(f.root, "saved")));
    } finally { live.storage.close(); }
  }

  it("refuses changed ciphertext, changed format metadata, truncation and the wrong key", async () => {
    const f = fixture(), path = await sealed(f), original = readFileSync(path);
    const attempt = async (bytes: Buffer, key = f.key) => {
      const changed = join(f.root, `changed-${randomBytes(4).toString("hex")}.dohc-snapshot`), output = join(f.root, `out-${randomBytes(4).toString("hex")}`);
      writeFileSync(changed, bytes);
      const result = openRelaySnapshot(changed, key, output);
      await expect(result).rejects.toThrow();
      expect(existsSync(output)).toBe(false);
      return result.catch((error: Error) => error.message);
    };
    const body = Buffer.from(original); body[body.length - 100] ^= 1;
    expect(await attempt(body)).toMatch(/could not be decrypted/);
    // The whole plaintext was written before the tag check failed, and never under the name restore reads.
    expect([...removed.values()].at(-1)).toEqual(["relay.sqlite.partial"]);
    const tag = Buffer.from(original); tag[tag.length - 1] ^= 1;
    expect(await attempt(tag)).toMatch(/could not be decrypted/);
    const headerLength = original.readUInt32BE(8);
    const header = JSON.parse(original.subarray(12, 12 + headerLength).toString());
    const iv = Buffer.from(header.iv, "base64url"); iv[0] ^= 1;
    const metadata = Buffer.from(original);
    metadata.write(JSON.stringify({ ...header, iv: iv.toString("base64url") }), 12);
    expect(await attempt(metadata)).toMatch(/could not be decrypted/);
    // Same fields, different bytes: only the authenticated header can notice.
    const spaced = Buffer.from(JSON.stringify(header, null, 1));
    const respaced = Buffer.concat([original.subarray(0, 8), Buffer.from([0, 0, spaced.length >> 8, spaced.length & 255]), spaced, original.subarray(12 + headerLength)]);
    expect(await attempt(respaced)).toMatch(/could not be decrypted/);
    const version = Buffer.from(original);
    version.write(JSON.stringify({ ...header, version: 2 }), 12);
    expect(await attempt(version)).toMatch(/unsupported format/);
    expect(await attempt(original.subarray(0, original.length - 4096))).toMatch(/could not be decrypted/);
    expect(await attempt(original, randomBytes(32))).toMatch(/different snapshot key/);
    expect(await attempt(Buffer.from("not a snapshot"))).toMatch(/not a dohc relay snapshot/);
  });

  it("refuses an authentic package whose database fails integrity or its checksum", async () => {
    const f = fixture();
    const setup = new DatabaseSync(f.relayPath);
    try {
      setup.exec(`CREATE TABLE evidence(stamp INTEGER PRIMARY KEY, padding BLOB);
        WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value<200) INSERT INTO evidence SELECT value, randomblob(2000) FROM n`);
    } finally { setup.close(); }
    const live = openRelayDeployment(f.configPath);
    const plain = join(f.root, "plain.sqlite");
    let manifest;
    try { manifest = await captureRelaySnapshot(f.relayPath, plain, "r"); } finally { live.storage.close(); }
    const intact = join(f.root, "intact.sqlite");
    writeFileSync(intact, readFileSync(plain));
    const corrupt = readFileSync(plain);
    corrupt.fill(0xa5, corrupt.length - 40_000, corrupt.length - 30_000);
    writeFileSync(plain, corrupt);
    const integrity = join(f.root, "integrity.dohc-snapshot");
    await sealRelaySnapshot(plain, { ...manifest, sha256: sha256(corrupt) }, f.key, integrity);
    await expect(openRelaySnapshot(integrity, f.key, join(f.root, "out-integrity"))).rejects.toThrow(/integrity|malformed/);
    expect(existsSync(join(f.root, "out-integrity"))).toBe(false);
    const checksum = join(f.root, "checksum.dohc-snapshot");
    await sealRelaySnapshot(intact, { ...manifest, sha256: "0".repeat(64) }, f.key, checksum);
    await expect(openRelaySnapshot(checksum, f.key, join(f.root, "out-checksum"))).rejects.toThrow(/checksum/);
  });
});

describe("off-site upload", () => {
  it("signs requests like the AWS Signature Version 4 example", () => {
    expect(signS3Request({ method: "GET", path: "/test.txt", region: "us-east-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      headers: { host: "examplebucket.s3.amazonaws.com", range: "bytes=0-9",
        "x-amz-content-sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "x-amz-date": "20130524T000000Z" } }))
      .toBe("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  });

  it("uploads the same package that --directory saves, under a unique name, and never deletes", async () => {
    const f = fixture(), s3 = await fakeS3(), live = openRelayDeployment(f.configPath), saved = join(f.root, "saved");
    const keys: string[] = [], paths: string[] = [];
    try {
      for (const createdAtMs of [1, 2]) {
        live.storage.claimWorkspace({ workspaceId: `w${createdAtMs}`, ownerUserId: "owner", createdAtMs });
        await withRelaySnapshot(f.options, async snapshot => {
          keys.push(await uploadRelaySnapshot(snapshot, s3.storage));
          paths.push(await saveRelaySnapshot(snapshot, saved));
        });
      }
    } finally { live.storage.close(); }
    expect(new Set(keys).size).toBe(2);
    expect(s3.methods).toEqual(["PUT", "PUT"]);
    expect(readdirSync(saved).sort()).toEqual(paths.map(path => path.slice(saved.length + 1)).sort());
    const stamps: number[] = [];
    for (const [index, key] of keys.entries()) {
      const object = s3.objects.get(`/dohc-snapshots/${key}`)!;
      expect(object.body.equals(readFileSync(paths[index]!))).toBe(true);
      const uploaded = join(f.root, `uploaded-${index}.dohc-snapshot`);
      writeFileSync(uploaded, object.body);
      stamps.push((await openRelaySnapshot(uploaded, f.key, join(f.root, `verified-${index}`))).stamp);
    }
    expect(stamps[1]).toBeGreaterThan(stamps[0]!);
  });

  it("leaves no stored object after an interrupted upload, and the partial bytes do not verify", async () => {
    const f = fixture(), s3 = await fakeS3({ dropAfterBytes: 1024 }), live = openRelayDeployment(f.configPath);
    try {
      live.storage.claimWorkspace({ workspaceId: "w", ownerUserId: "owner", createdAtMs: 1 });
      await expect(withRelaySnapshot(f.options,
        snapshot => uploadRelaySnapshot(snapshot, s3.storage))).rejects.toThrow();
    } finally { live.storage.close(); }
    expect(s3.objects.size).toBe(0);
    const partial = join(f.root, "partial.dohc-snapshot");
    writeFileSync(partial, s3.received[0]!);
    await expect(openRelaySnapshot(partial, f.key, join(f.root, "out"))).rejects.toThrow(/could not be decrypted/);
  });

  it("keeps upload opt-in and refuses partial or plain-HTTP storage settings", () => {
    expect(snapshotStorageFromEnv({})).toBeUndefined();
    const complete = { DOHC_SNAPSHOT_S3_ENDPOINT: "https://account.r2.cloudflarestorage.com", DOHC_SNAPSHOT_S3_BUCKET: "dohc-snapshots",
      DOHC_SNAPSHOT_S3_ACCESS_KEY_ID: "id", DOHC_SNAPSHOT_S3_SECRET_ACCESS_KEY: "secret" };
    expect(snapshotStorageFromEnv(complete)?.region).toBe("auto");
    expect(() => snapshotStorageFromEnv({ ...complete, DOHC_SNAPSHOT_S3_SECRET_ACCESS_KEY: "" })).toThrow(/partly configured/);
    expect(() => snapshotStorageFromEnv({ ...complete, DOHC_SNAPSHOT_S3_ENDPOINT: "http://storage.invalid" })).toThrow(/HTTPS origin/);
    expect(() => snapshotStorageFromEnv({ ...complete, DOHC_SNAPSHOT_S3_ENDPOINT: "https://storage.invalid/bucket" })).toThrow(/HTTPS origin/);
  });

  // Compose passes an empty key to a deployment without snapshots, so every command checks it before it runs.
  it("refuses to run without a well-formed snapshot key", () => {
    const key = randomBytes(32);
    expect(relaySnapshotKey(key.toString("base64url"))).toEqual(key);
    for (const value of [undefined, "", "change-me", randomBytes(31).toString("base64url"), `${key.toString("base64url")}=`]) {
      expect(() => relaySnapshotKey(value), String(value)).toThrow("Set DOHC_SNAPSHOT_KEY to the 32-byte key that bootstrap generated.");
    }
  });
});
