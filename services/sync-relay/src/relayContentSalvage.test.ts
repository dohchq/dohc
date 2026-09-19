import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { initializeRelayDeployment, openRelayDeployment } from "./relayDeployment";
import { backupRelayDeployment, checkRelayBackup } from "./relayDeploymentRecovery";
import { salvageRelayContent } from "./relayContentSalvage";
import { moment } from "./testing";
import type { StorageContext } from "./storage/context";

const io = vi.hoisted(() => ({ events: [] as { kind: string; path: string; flush?: boolean }[], failSync: "" }));
vi.mock("node:fs/promises", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs,
    async open(...args: Parameters<typeof fs.open>) {
      const handle = await fs.open(...args), sync = handle.sync.bind(handle);
      handle.sync = async () => {
        io.events.push({ kind: "sync", path: String(args[0]) });
        if (String(args[0]) === io.failSync) throw new Error("Injected sync failure");
        await sync();
      };
      return handle;
    },
    async writeFile(...args: Parameters<typeof fs.writeFile>) {
      await fs.writeFile(...args);
      io.events.push({ kind: "write", path: String(args[0]), flush: typeof args[2] === "object" && args[2] !== null && "flush" in args[2] && args[2].flush === true });
    },
  };
});
const cleanups: (() => void)[] = [];
afterEach(() => { io.failSync = ""; io.events.length = 0; for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dohc-content-salvage-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const input = { configPath: join(root, "control", "deployment.json"), relayPath: join(root, "relay", "relay.sqlite"), continuityDirectory: join(root, "continuity") };
  initializeRelayDeployment(input);
  return { ...input, root };
}
const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

it("exports stale snapshot files without continuity and preserves original evidence", async () => {
  const f = fixture(), directory = join(f.root, "snapshot"), output = join(f.root, "salvage");
  const live = openRelayDeployment(f.configPath);
  const text = "# Recoverable work\n", binary = Buffer.from([0, 1, 254, 255]);
  try {
    live.storage.claimWorkspace({ workspaceId: "w", ownerUserId: "owner", createdAtMs: 1 });
    live.storage.putBlob({ workspaceId: "w", sha256: sha256(text), content: Buffer.from(text), createdAtMs: 1 });
    live.storage.putBlob({ workspaceId: "w", sha256: sha256(binary), content: binary, createdAtMs: 1 });
    live.storage.putBlob({ workspaceId: "w", sha256: sha256("missing"), content: Buffer.from("missing"), createdAtMs: 1 });
    live.storage.putBlob({ workspaceId: "w", sha256: sha256("damaged"), content: Buffer.from("damaged"), createdAtMs: 1 });
    const ops = [moment("notes/work.md", text), moment("responses/accepted_sample.md", text), moment("image.bin", "unused", { payload: { payloadAfterBlobSha256: sha256(binary), payloadAfterContentKind: "binary" } }), moment("missing.md", "missing"), moment("damaged.md", "damaged")];
    live.storage.appendLogBatch({ workspaceId: "w", originId: "origin", ops: ops.map(({ payload, ...op }) => ({ ...op, payloadJson: JSON.stringify(payload) })) });
    // Simulate a damaged logical snapshot whose surviving file bytes remain useful.
    const storage = live.storage as StorageContext;
    storage.tx(() => storage.db.prepare("DELETE FROM sync_relay_blobs WHERE sha256=?").run(sha256("missing")));
    storage.tx(() => storage.db.prepare("UPDATE sync_relay_blobs SET byte_length=999 WHERE sha256=?").run(sha256("damaged")));
    for (const unsafePath of ["../escape.md", ".dohc/engine/config.json"]) {
      storage.tx(() => storage.db.prepare("INSERT INTO sync_relay_current_files SELECT workspace_id,version_id,?,blob_sha256,content_kind,state_relay_seq FROM sync_relay_current_files WHERE path='notes/work.md'").run(unsafePath));
    }
  } finally { live.storage.close(); }
  await backupRelayDeployment(f.configPath, directory);
  const newer = openRelayDeployment(f.configPath);
  newer.storage.claimWorkspace({ workspaceId: "later", ownerUserId: "owner", createdAtMs: 2 });
  newer.storage.close();
  await expect(checkRelayBackup(f.configPath, directory)).rejects.toThrow(/continuity/);
  // Disaster salvage reads only the backup. It does not need or recreate authority.
  rmSync(f.continuityDirectory, { recursive: true });
  io.events.length = 0;
  expect(await salvageRelayContent(directory, output)).toEqual({ exported: 3, skipped: 4 });
  const base = join(output, "files", sha256("w"), sha256("main"));
  expect(readFileSync(join(base, "notes/work.md"), "utf8")).toBe(text);
  expect(readFileSync(join(base, "image.bin"))).toEqual(binary);
  expect(readFileSync(join(base, "responses/accepted_sample.md"), "utf8")).toBe(text);
  expect(readFileSync(join(output, "evidence/relay.sqlite"))).toEqual(readFileSync(join(directory, "relay.sqlite")));
  const rows = readFileSync(join(output, "files.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(rows.find(row => row.path === "missing.md").skipped).toBe("missing-blob");
  expect(rows.find(row => row.path === "damaged.md").skipped).toBe("blob-integrity-failed");
  expect(rows.find(row => row.path === "../escape.md").skipped).toBe("path-cannot-be-materialized");
  expect(rows.find(row => row.path === ".dohc/engine/config.json").skipped).toBe("path-cannot-be-materialized");
  expect(JSON.parse(readFileSync(join(output, "recovery.json"), "utf8")).complete).toBe(true);
  const completed = io.events.findIndex(event => event.kind === "write" && event.path === join(output, "recovery.json"));
  expect(io.events.slice(0, completed)).toContainEqual({ kind: "sync", path: join(output, "evidence/relay.sqlite") });
  for (const path of [join(base, "notes/work.md"), join(base, "image.bin"), join(base, "responses/accepted_sample.md"), join(output, "evidence/manifest.json")]) {
    expect(io.events.slice(0, completed)).toContainEqual({ kind: "write", path, flush: true });
  }
  if (process.platform !== "win32") {
    const synced = io.events.slice(0, completed).filter(event => event.kind === "sync").map(event => event.path);
    expect(synced.indexOf(join(base, "notes"))).toBeLessThan(synced.indexOf(base));
    expect(synced.indexOf(base)).toBeLessThan(synced.indexOf(output));
    expect(io.events.slice(completed + 1)).toEqual([{ kind: "sync", path: output }, { kind: "sync", path: f.root }]);
  }
  await expect(salvageRelayContent(directory, output)).rejects.toThrow();
});

it("does not mark salvage complete if evidence synchronization fails", async () => {
  const f = fixture(), directory = join(f.root, "snapshot"), output = join(f.root, "salvage");
  await backupRelayDeployment(f.configPath, directory);
  io.failSync = join(output, "evidence/relay.sqlite");
  await expect(salvageRelayContent(directory, output)).rejects.toThrow("Injected sync failure");
  expect(existsSync(join(output, "recovery.json"))).toBe(false);
});

it("rejects changed snapshot bytes before creating a completed export", async () => {
  const f = fixture(), directory = join(f.root, "snapshot"), output = join(f.root, "salvage");
  await backupRelayDeployment(f.configPath, directory);
  writeFileSync(join(directory, "relay.sqlite"), "not the recorded snapshot");
  await expect(salvageRelayContent(directory, output)).rejects.toThrow(/checksum/);
});
