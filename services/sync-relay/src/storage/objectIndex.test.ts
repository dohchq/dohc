import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import type { StorageContext } from "./context";
import {
  findChannelCreateFolderPath,
  findChannelCreateKind,
  findThreadCreateChannelWireId,
  findThreadCreateFileBinding,
} from "./objectIndex";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const databases: InstanceType<typeof DatabaseSync>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  // The resolver needs only log rows. Keep malformed historical JSON testable.
  db.exec(`CREATE TABLE sync_relay_log (
    relay_seq INTEGER PRIMARY KEY, workspace_id TEXT, op_kind TEXT, payload_json TEXT
  );
  CREATE INDEX thread_creates ON sync_relay_log(workspace_id, relay_seq)
    WHERE op_kind = 'chat.thread.create';
  CREATE INDEX channel_creates ON sync_relay_log(workspace_id, relay_seq)
    WHERE op_kind = 'chat.channel.create';`);
  const insert = db.prepare("INSERT INTO sync_relay_log (workspace_id, op_kind, payload_json) VALUES (?, ?, ?)");
  return {
    db,
    storage: { db } as unknown as StorageContext,
    append(opKind: string, payload: unknown, workspaceId = "workspace") {
      insert.run(workspaceId, opKind, JSON.stringify(payload));
    },
    appendRaw(opKind: string, payload: string) { insert.run("workspace", opKind, payload); },
  };
}

const cases = [
  {
    name: "thread channel", opKind: "chat.thread.create", idKey: "threadId",
    resolve: findThreadCreateChannelWireId,
    binding: { channelWireId: "channel" }, expected: "channel",
  },
  {
    name: "thread file", opKind: "chat.thread.create", idKey: "threadId",
    resolve: findThreadCreateFileBinding,
    binding: { linkedObjectId: "file" }, expected: { kind: "object", objectId: "file" },
  },
  {
    name: "channel kind", opKind: "chat.channel.create", idKey: "wireId",
    resolve: findChannelCreateKind,
    binding: { channelId: "channel", name: "Team", slug: "team", kind: "channel", createdAtMs: 1 },
    expected: "channel",
  },
  {
    name: "channel folder", opKind: "chat.channel.create", idKey: "wireId",
    resolve: findChannelCreateFolderPath,
    binding: { folderPath: "docs" }, expected: "docs",
  },
];

describe.each(cases)("earliest $name create", ({ opKind, idKey, resolve, binding, expected }) => {
  it("skips LIKE false positives and preserves the first exact binding", () => {
    const f = fixture(), id = 'Id_%\\"日本語';
    f.appendRaw(opKind, `{"${idKey}":${JSON.stringify(id)},`);
    f.append(opKind, { nested: { [idKey]: id }, ...binding });
    f.append(opKind, { [idKey]: id.toLowerCase(), ...binding });
    f.append(opKind, { [idKey]: id });
    expect(resolve(f.storage, "workspace", id)).toBeNull();
    f.append(opKind, { [idKey]: id, ...binding });
    expect(resolve(f.storage, "workspace", id)).toBeNull();
    // Returning from the resolver must release the native read cursor.
    expect(() => f.db.exec("DROP TABLE sync_relay_log")).not.toThrow();
  });

  it("keeps valid earliest bindings and releases the cursor before returning", () => {
    const f = fixture(), id = "exact-id";
    f.append(opKind, { nested: { [idKey]: id } });
    f.append(opKind, { [idKey]: id, ...binding });
    f.append(opKind, { [idKey]: id });
    expect(resolve(f.storage, "workspace", id)).toEqual(expected);
    expect(resolve(f.storage, "workspace", id)).toEqual(expected);
    expect(() => f.db.exec("DROP TABLE sync_relay_log")).not.toThrow();
  });

  it("distinguishes absent creates from malformed ones and scopes the workspace and op kind", () => {
    const f = fixture(), id = "exact-id";
    f.append(opKind, { [idKey]: id, ...binding }, "other-workspace");
    f.append("unrelated.create", { [idKey]: id, ...binding });
    expect(resolve(f.storage, "workspace", "")).toBeUndefined();
    expect(resolve(f.storage, "workspace", id)).toBeUndefined();
    expect(resolve(f.storage, "other-workspace", id)).toEqual(expected);
    f.append(opKind, { [idKey]: id });
    expect(resolve(f.storage, "workspace", id)).toBeNull();
  });
});

it("refuses an earliest file create with two owners instead of accepting a later binding", () => {
  const f = fixture(), threadId = "thread";
  f.append("chat.thread.create", { threadId, linkedObjectId: "object", linkedPath: "docs/file.md", channelWireId: "channel" });
  f.append("chat.thread.create", { threadId, linkedObjectId: "replacement" });
  expect(findThreadCreateFileBinding(f.storage, "workspace", threadId)).toBeNull();
  expect(findThreadCreateChannelWireId(f.storage, "workspace", threadId)).toBeNull();
});
