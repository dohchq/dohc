import { describe, expect, it } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import type { RegistryEntry } from "./registryStore";
import { createReceivedShareEngineAccess } from "./receivedShareEngineAccess";
import { collectionListSources, collectionReadSource, mountedCollectionSchema, receivedCollectionQuery } from "./receivedShareCollections";

function access() {
  return createReceivedShareEngineAccess({
    sessions: () => new EngineWorkspaceSessions({ currentClient: () => { throw Error("unused client"); } }),
    relayClient: () => { throw Error("unused relay"); },
    createStores: () => { throw Error("unused store"); },
  });
}

const workspace = (rootPath: string): RegistryEntry & { attachmentId: symbol } => ({
  workspaceId: "recipient", rootPath, kind: "personal", mode: "local-first",
  attachmentId: Symbol("recipient"),
});

describe("received Collection read routing", () => {
  it("uses the saved grant for standalone reads and rejects damaged or ended shares", async () => {
    const target = { ...workspace("unused"), shareView: {
      shareId: "share", granterEmail: null, genericChatWritable: false,
      grantedSelector: { paths: ["trip"], versionId: null, access: "view" as const },
    } };
    const sources = collectionListSources(target, access());
    expect(sources[0]?.workspace).toMatchObject({ shareMount: true, workspaceId: "recipient" });
    expect(sources[0]?.selected("trip/tasks/collection.yaml")).toBe(true);
    expect(sources[0]?.selected("private/collection.yaml")).toBe(false);
    await expect(collectionReadSource(target, "private", access())).rejects.toThrow("outside");
    target.shareView.grantedSelector.paths = [];
    await expect(collectionReadSource(target, "trip/tasks", access())).rejects.toThrow("no longer available");
    expect(() => collectionListSources({ ...target, shareView: { ...target.shareView, ended: true } }, access())).toThrow("no longer available");
  });

  it("routes a mount to its own store and prefixes records, relations, and cursors", async () => {
    const root = resolve(".agent-artifacts", `received-collections-${randomUUID()}`);
    await mkdir(join(root, "shared-with-me", "alice", "trip", "tasks"), { recursive: true });
    try {
      const target = { ...workspace(root), shareMounts: [{ shareId: "share", label: "alice", granterEmail: "alice@dohc.test",
        relayUrl: "http://127.0.0.1:1234", grantedSelector: { paths: ["trip"], versionId: null, access: "edit" as const } }] };
      const sources = collectionListSources(target, access());
      expect(sources).toHaveLength(2);
      const routed = await collectionReadSource(target, "shared-with-me/alice/trip/tasks", access());
      expect(routed.path).toBe("trip/tasks");
      expect(routed.source.workspace).toMatchObject({ shareMount: true, rootPath: join(root, "shared-with-me", "alice") });
      expect(routed.source.workspace.workspaceId).not.toBe("recipient");
      const prefix = "shared-with-me/alice/";
      expect(mountedCollectionSchema({ name: null, description: null, fields: [{ name: "Task", type: "relation", collection: "trip/tasks", many: false }], views: [] }, prefix).fields[0])
        .toMatchObject({ collection: `${prefix}trip/tasks` });
      const result = receivedCollectionQuery({ collection: { path: "trip/tasks", objectId: "schema", status: "valid", reasons: [] },
        records: [{ id: "a", path: "trip/tasks/a.md", conflicted: false, values: [] }, { id: "secret", path: "private/a.md", conflicted: false, values: [] }], groups: null,
        nextCursor: { recordPath: "trip/tasks/a.md", recordId: "a", sortValues: [] } }, routed.source);
      expect(result.records.map(record => record.path)).toEqual([`${prefix}trip/tasks/a.md`]);
      expect(result.nextCursor?.recordPath).toBe(`${prefix}trip/tasks/a.md`);
      expect(receivedCollectionQuery({ ...result, nextCursor: { recordPath: "private/a.md", recordId: "secret", sortValues: [] } }, routed.source).nextCursor).toBeNull();
      expect(collectionListSources({ ...target, shareMounts: [{ ...target.shareMounts[0]!, ended: true }] }, access())).toHaveLength(1);
      await expect(collectionReadSource(target, "shared-with-me/alice/private", access())).rejects.toThrow("outside");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
