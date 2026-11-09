import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { initializeRelayDeployment, openRelayDeployment } from "../relayDeployment";
import { openEmptyRelayTestDeployment } from "./emptyRelayDeployment";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function paths() {
  const root = mkdtempSync(join(tmpdir(), "dohc-deployment-test-"));
  roots.push(root);
  return { configPath: join(root, "deployment.json"), relayPath: join(root, "relay", "relay.sqlite"), continuityDirectory: join(root, "continuity") };
}
const databases = (layout: ReturnType<typeof paths>) => [layout.relayPath, join(layout.continuityDirectory, "lock.sqlite"), join(layout.continuityDirectory, "continuity.sqlite")];

it("matches fresh deployment schemas and rows with new consistent identities and independent durable writes", () => {
  const freshPaths = paths(), firstPaths = paths(), secondPaths = paths();
  initializeRelayDeployment(freshPaths);
  const fresh = openRelayDeployment(freshPaths.configPath), first = openEmptyRelayTestDeployment(firstPaths), second = openEmptyRelayTestDeployment(secondPaths);
  try {
    expect(new Set([fresh.history.namespace, first.history.namespace, second.history.namespace]).size).toBe(3);
    const nonces = [freshPaths, firstPaths, secondPaths].map(paths => {
      const db = new DatabaseSync(paths.relayPath);
      try { return db.prepare("SELECT nonce FROM sync_relay_continuity").get()!.nonce; }
      finally { db.close(); }
    });
    expect(new Set(nonces).size).toBe(3);
    expect(first.storage.getLiveHostControl()).toBeNull();
    expect(second.storage.getLiveHostControl()).toBeNull();
    expect(first.storage.provisionLiveHostControl({ mode: "service", hostId: "first", updatedAtMs: 1, guard() {} }).ok).toBe(true);
    expect(second.storage.getLiveHostControl()).toBeNull();
  } finally { fresh.storage.close(); first.storage.close(); second.storage.close(); }
  const snapshots = [freshPaths, firstPaths, secondPaths].map(paths => databases(paths).map(path => {
    expect(existsSync(path + "-wal")).toBe(false);
    expect(existsSync(path + "-journal")).toBe(false);
    const db = new DatabaseSync(path);
    try {
      const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
      const rows = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(({ name }) => ({
        name, rows: db.prepare(`SELECT * FROM "${String(name).replaceAll('"', '""')}"`).all()
          .map(({ namespace: _namespace, nonce: _nonce, previous_nonce: _previousNonce, confirmed_nonce: _confirmedNonce,
            completed_at_ms: _timestamp, stamp: _stamp, confirmed_stamp: _confirmedStamp, ...row }) => row),
      }));
      return { schema, rows };
    } finally { db.close(); }
  }));
  expect(snapshots[2]).toEqual(snapshots[0]);
  expect(snapshots[1]!.map(snapshot => snapshot.schema)).toEqual(snapshots[0]!.map(snapshot => snapshot.schema));
  for (const paths of [firstPaths, secondPaths]) {
    const config = JSON.parse(readFileSync(paths.configPath, "utf8"));
    const rows = databases(paths).map((path, index) => {
      const db = new DatabaseSync(path);
      try { return db.prepare(`SELECT * FROM ${["sync_relay_continuity", "deployment", "continuity"][index]}`).get()!; }
      finally { db.close(); }
    });
    for (const row of rows) expect(row.namespace).toBe(config.namespace);
    expect(rows[0]!.nonce).toBe(rows[2]!.confirmed_nonce);
    expect(rows[0]!.stamp).toBe(rows[2]!.confirmed_stamp);
  }
  const reopened = openRelayDeployment(firstPaths.configPath), later = openEmptyRelayTestDeployment(paths());
  try {
    expect(reopened.storage.getLiveHostControl()?.configuredHostId).toBe("first");
    expect(later.storage.getLiveHostControl()).toBeNull();
  } finally { reopened.storage.close(); later.storage.close(); }
  const unchanged = readFileSync(firstPaths.relayPath);
  expect(() => openEmptyRelayTestDeployment(firstPaths)).toThrow(/EEXIST/);
  expect(() => openEmptyRelayTestDeployment({ ...paths(), relayPath: firstPaths.relayPath })).toThrow(/EEXIST/);
  expect(readFileSync(firstPaths.relayPath)).toEqual(unchanged);
});
