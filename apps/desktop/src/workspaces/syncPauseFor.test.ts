import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { CloudStatusResult, SyncStatusResult } from "../ipc/bridgeContract";
import { createRegistryStore } from "./registryStore";
import { syncPauseFor } from "./syncPauseFor";
import { createWorkspaceActivity, WorkspaceActivityState } from "./workspaceActivity";
import { idleObservation } from "./workspaceActivity.testSupport";
import { createTestScratch } from "./testTemp";

it.each([
  { atMs: 42, author: { kind: "human", humanId: "local", displayName: "You" } },
  { atMs: "yesterday", author: { kind: "person", personId: "local" } },
  { atMs: 42, author: null },
])("opens a paused registry entry despite invalid pause metadata %j", async syncPause => {
  const rootPath = await createTestScratch("sync-pause-status-");
  const registryFile = join(rootPath, "workspaces.json");
  const pausedRemote = { serverUrl: "https://server.test", ownerUserId: "owner" };
  await writeFile(registryFile, JSON.stringify({ version: 1, workspaces: [
    { workspaceId: "workspace", rootPath, kind: "personal", mode: "local-first", pausedRemote, syncPause },
  ] }));
  const entry = createRegistryStore(registryFile).find("workspace")!;
  const workspace = { ...entry, attachmentId: Symbol("workspace") };
  const activity = createWorkspaceActivity(vi.fn(), {
    observationFor: () => idleObservation(workspace, {} as never),
    cloudStateFor: () => ({ enabled: !!entry.remote, connected: false, syncPause: syncPauseFor(entry, "local") }),
  });
  const state = new WorkspaceActivityState();
  await activity.open(workspace, state);
  const status = SyncStatusResult.parse(activity.getStatus(workspace, state));
  expect(status.syncPause).toBeUndefined();
  const cloudStatus = CloudStatusResult.parse({ connected: false, workspaceSyncOwned: true,
    workspaceSynced: !!entry.remote, syncPause: syncPauseFor(entry, "local") });
  expect(cloudStatus.syncPause).toBeUndefined();
  expect(entry.pausedRemote).toEqual(pausedRemote);
  expect(entry.syncPause).toEqual(syncPause);
  await activity.close(workspace, state);
});

it("projects a valid pause and omits provenance from a received share", () => {
  const entry = { workspaceId: "workspace", rootPath: "/workspace", kind: "personal" as const, mode: "local-first" as const,
    syncPause: { atMs: 42, author: { kind: "person" as const, personId: "local" } } };
  expect(syncPauseFor(entry, "local")).toEqual({ atMs: 42, author: { kind: "person", personId: "local", self: true } });
  expect(syncPauseFor({ ...entry, shareView: { shareId: "share", granterEmail: null, genericChatWritable: false,
    grantedSelector: { paths: ["note.md"], versionId: null, access: "edit" } } }, "local")).toBeUndefined();
});
