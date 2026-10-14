import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { backupRelayDeployment, checkRelayBackup, restoreRelayDeployment } from "./relayDeploymentRecovery";
import { initializeRelayDeployment, openRelayDeployment } from "./relayDeployment";
import { createDeviceHostCredential } from "./deviceHostCredential";
import { parseHostEpoch } from "@dohc/live-session-contract/host-control";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dohc-relay-recovery-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const input = { configPath: join(root, "control", "deployment.json"), relayPath: join(root, "relay", "relay.sqlite"), continuityDirectory: join(root, "continuity") };
  initializeRelayDeployment(input);
  return { ...input, root };
}
function continuity(path: string) {
  const db = new DatabaseSync(join(path, "continuity.sqlite"), { readOnly: true });
  try { return db.prepare("SELECT * FROM continuity").get(); } finally { db.close(); }
}

describe("relay recovery snapshots", () => {
  it("round-trips a cold snapshot and keeps independent continuity", async () => {
    const f = fixture(), backup = join(f.root, "backup"), live = openRelayDeployment(f.configPath);
    try { live.storage.claimWorkspace({ workspaceId: "w", ownerUserId: "u", createdAtMs: 1 }); }
    finally { live.storage.close(); }
    await backupRelayDeployment(f.configPath, backup);
    const before = continuity(f.continuityDirectory);
    await checkRelayBackup(f.configPath, backup);
    const result = await restoreRelayDeployment(f.configPath, backup);
    expect(continuity(f.continuityDirectory)).toEqual(before);
    expect(result.preservedDirectory).toContain("recovery-");
    const reopened = openRelayDeployment(f.configPath);
    try { expect(reopened.storage.claimWorkspace({ workspaceId: "w2", ownerUserId: "u", createdAtMs: 2 })).toBe("created"); }
    finally { reopened.storage.close(); }
  });

  it.each(["before-commit", "after-commit"])("keeps maintenance strict until startup settles %s", async boundary => {
    const f = fixture(), backup = join(f.root, "backup"), live = openRelayDeployment(f.configPath);
    live.storage.claimWorkspace({ workspaceId: "acknowledged", ownerUserId: "owner", createdAtMs: 1 });
    live.storage.close();
    await backupRelayDeployment(f.configPath, backup);
    const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./relayDeploymentCrash.fixture.ts", import.meta.url)), f.configPath, boundary],
      { encoding: "utf8", windowsHide: true, timeout: 45_000 });
    expect(child.error).toBeUndefined();
    expect(child.stderr).toBe("");
    expect(child.status).toBe(boundary === "before-commit" ? 81 : 82);
    const before = continuity(f.continuityDirectory);
    await expect(backupRelayDeployment(f.configPath, join(f.root, "pending"))).rejects.toThrow(/continuity/);
    await expect(checkRelayBackup(f.configPath, backup)).rejects.toThrow(/continuity/);
    await expect(restoreRelayDeployment(f.configPath, backup)).rejects.toThrow(/continuity/);
    expect(continuity(f.continuityDirectory)).toEqual(before);
    expect(existsSync(join(f.root, "pending"))).toBe(false);
    const restarted = openRelayDeployment(f.configPath); restarted.storage.close();
    const current = join(f.root, "settled");
    await backupRelayDeployment(f.configPath, current);
    await checkRelayBackup(f.configPath, current);
    await restoreRelayDeployment(f.configPath, current);
    if (boundary === "before-commit") await checkRelayBackup(f.configPath, backup);
    else {
      await expect(checkRelayBackup(f.configPath, backup)).rejects.toThrow(/continuity/);
      await expect(restoreRelayDeployment(f.configPath, backup)).rejects.toThrow(/continuity/);
    }
    const reopened = openRelayDeployment(f.configPath);
    try {
      expect(reopened.storage.claimWorkspace({ workspaceId: "acknowledged", ownerUserId: "owner", createdAtMs: 1 })).toBe("owned");
      expect(reopened.storage.claimWorkspace({ workspaceId: "interrupted", ownerUserId: "owner", createdAtMs: 2 })).toBe(boundary === "after-commit" ? "owned" : "created");
    } finally { reopened.storage.close(); }
  }, 55_000);

  it("refuses a snapshot after continuity advances", async () => {
    const f = fixture(), backup = join(f.root, "backup"), live = openRelayDeployment(f.configPath);
    live.storage.claimWorkspace({ workspaceId: "first", ownerUserId: "u", createdAtMs: 1 });
    live.storage.close();
    await backupRelayDeployment(f.configPath, backup);
    const next = openRelayDeployment(f.configPath);
    next.storage.claimWorkspace({ workspaceId: "second", ownerUserId: "u", createdAtMs: 2 });
    next.storage.close();
    await expect(checkRelayBackup(f.configPath, backup)).rejects.toThrow(/continuity/);
    await expect(restoreRelayDeployment(f.configPath, backup)).rejects.toThrow(/continuity/);
  });

  it("refuses a permission-only rollback and preserves the current database", async () => {
    const f = fixture(), backup = join(f.root, "backup"), live = openRelayDeployment(f.configPath);
    const credential = createDeviceHostCredential("host", parseHostEpoch(1));
    expect(live.storage.provisionDeviceHostCredential({ credential, updatedAtMs: 1 }).ok).toBe(true);
    live.storage.close();
    await backupRelayDeployment(f.configPath, backup);
    const next = openRelayDeployment(f.configPath);
    expect(next.storage.revokeDeviceHostCredential({ hostId: credential.hostId, instanceId: credential.instanceId, updatedAtMs: 2 }).ok).toBe(true);
    next.storage.close();
    const bytes = readFileSync(f.relayPath);
    await expect(restoreRelayDeployment(f.configPath, backup)).rejects.toThrow(/continuity/);
    expect(readFileSync(f.relayPath)).toEqual(bytes);
  });

  it("repairs a corrupt relay database while preserving its original bytes", async () => {
    const f = fixture(), backup = join(f.root, "backup"), live = openRelayDeployment(f.configPath);
    live.storage.claimWorkspace({ workspaceId: "w", ownerUserId: "owner", createdAtMs: 1 });
    live.storage.close();
    await backupRelayDeployment(f.configPath, backup);
    writeFileSync(f.relayPath, "damaged database");
    const result = await restoreRelayDeployment(f.configPath, backup);
    expect(readFileSync(join(result.preservedDirectory, "original.sqlite"), "utf8")).toBe("damaged database");
    const reopened = openRelayDeployment(f.configPath);
    try { expect(reopened.storage.claimWorkspace({ workspaceId: "w", ownerUserId: "owner", createdAtMs: 1 })).toBe("owned"); }
    finally { reopened.storage.close(); }
  });

  it("refuses maintenance while the production writer holds its lock", async () => {
    const f = fixture(), backup = join(f.root, "backup");
    await backupRelayDeployment(f.configPath, backup);
    const live = openRelayDeployment(f.configPath);
    try {
      await expect(backupRelayDeployment(f.configPath, join(f.root, "second"))).rejects.toThrow();
      await expect(restoreRelayDeployment(f.configPath, backup)).rejects.toThrow();
    } finally { live.storage.close(); }
    expect(existsSync(join(f.root, "second"))).toBe(false);
  });

  it("refuses lost continuity and never recreates it", async () => {
    const f = fixture(), backup = join(f.root, "backup");
    await backupRelayDeployment(f.configPath, backup);
    const side = join(f.continuityDirectory, "continuity.sqlite");
    renameSync(side, side + ".preserved");
    await expect(restoreRelayDeployment(f.configPath, backup)).rejects.toThrow();
    expect(existsSync(side)).toBe(false);
  });

  it("rejects foreign deployment snapshots and protected backup locations", async () => {
    const a = fixture(), b = fixture(), backup = join(a.root, "backup");
    await backupRelayDeployment(a.configPath, backup);
    await expect(restoreRelayDeployment(b.configPath, backup)).rejects.toThrow(/continuity/);
    await expect(backupRelayDeployment(a.configPath, join(a.continuityDirectory, "backup"))).rejects.toThrow(/outside/);
    await expect(backupRelayDeployment(a.configPath, join(a.root, "relay", "backup"))).rejects.toThrow(/outside/);
    await expect(backupRelayDeployment(a.configPath, join(a.root, "control", "backup"))).rejects.toThrow(/outside/);
  });

  it("reports an outstanding SQLite journal before taking a snapshot", async () => {
    const f = fixture(), backup = join(f.root, "backup");
    writeFileSync(f.relayPath + "-journal", "unfinished journal");
    await expect(backupRelayDeployment(f.configPath, backup)).rejects.toThrow(/Stop the relay cleanly/);
    expect(existsSync(backup)).toBe(false);
  });

  it("does not accept a changed manifest", async () => {
    const f = fixture(), backup = join(f.root, "backup");
    await backupRelayDeployment(f.configPath, backup);
    const manifest = JSON.parse(readFileSync(join(backup, "manifest.json"), "utf8"));
    manifest.sha256 = "0".repeat(64);
    writeFileSync(join(backup, "manifest.json"), JSON.stringify(manifest));
    await expect(checkRelayBackup(f.configPath, backup)).rejects.toThrow(/checksum/);
  });
});
