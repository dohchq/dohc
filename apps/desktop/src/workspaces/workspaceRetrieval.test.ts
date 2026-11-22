import { describe, expect, it, vi } from "vitest";
import type { WorkspaceSearchResult } from "@dohc/workspace-contracts/retrieval";
import type { RegistryEntry } from "./registryStore";
import { createWorkspaceRetrievalReader } from "./workspaceRetrieval";

function baseResult(overrides: Partial<WorkspaceSearchResult> = {}): WorkspaceSearchResult {
  return {
    versionId: "main",
    results: [
      {
        id: "page:obj-1",
        kind: "page",
        title: "Tokyo Trip",
        path: "notes/tokyo.md",
        objectId: "obj-1",
        snippet: "Shinjuku hotel reservations.",
        matchedTerms: ["tokyo"],
        related: [],
      },
    ],
    neighbors: [],
    complete: true,
    indexBuilding: false,
    policyDegraded: false,
    mountsCovered: true,
    sharedChannelRowsUncovered: 0,
    truncated: false,
    ...overrides,
  };
}

function ownerWorkspace(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    workspaceId: "ws-owner",
    name: "Owner",
    rootPath: "/tmp/owner",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as RegistryEntry;
}

describe("createWorkspaceRetrievalReader", () => {
  it("queries the engine adapter without syncing shared channels on a plain local workspace", async () => {
    const retrieveWorkspace = vi.fn(async () => baseResult());
    const syncWorkspaceSharedChannels = vi.fn(async () => 0);
    const reader = createWorkspaceRetrievalReader({
      withAdapter: async (_workspace, run) => run({ retrieveWorkspace } as never),
      syncWorkspaceSharedChannels,
    });

    const result = await reader.search(ownerWorkspace(), { query: "  tokyo  " });

    expect(result.complete).toBe(true);
    expect(result.mountsCovered).toBe(true);
    expect(result.sharedChannelRowsUncovered).toBe(0);
    expect(retrieveWorkspace).toHaveBeenCalledWith({ query: "tokyo" });
    expect(syncWorkspaceSharedChannels).not.toHaveBeenCalled();
  });

  it("refuses standalone received shares before touching the adapter or channel sync", async () => {
    const withAdapter = vi.fn();
    const syncWorkspaceSharedChannels = vi.fn();
    const reader = createWorkspaceRetrievalReader({
      withAdapter,
      syncWorkspaceSharedChannels,
    });

    await expect(
      reader.search(
        ownerWorkspace({ shareView: { shareId: "sh-1" } as RegistryEntry["shareView"] }),
        { query: "tokyo" },
      ),
    ).rejects.toThrow("Only the original workspace supports workspace search.");
    expect(withAdapter).not.toHaveBeenCalled();
    expect(syncWorkspaceSharedChannels).not.toHaveBeenCalled();
  });

  it("marks mountsCovered false when received share mounts exist on the workspace", async () => {
    const reader = createWorkspaceRetrievalReader({
      withAdapter: async (_workspace, run) =>
        run({ retrieveWorkspace: async () => baseResult() } as never),
      syncWorkspaceSharedChannels: async () => 0,
    });

    const result = await reader.search(
      ownerWorkspace({
        shareMounts: [{ shareId: "sh-mount", label: "Team" } as never],
      }),
      { query: "tokyo" },
    );

    expect(result.mountsCovered).toBe(false);
    expect(result.complete).toBe(true);
  });

  it("refreshes live shared channels when chat is included and folds uncovered rows into complete", async () => {
    const retrieveWorkspace = vi.fn(async () => baseResult({ sharedChannelRowsUncovered: 1 }));
    const syncWorkspaceSharedChannels = vi.fn(async () => 2);
    const reader = createWorkspaceRetrievalReader({
      withAdapter: async (_workspace, run) => run({ retrieveWorkspace } as never),
      syncWorkspaceSharedChannels,
    });
    const workspace = ownerWorkspace({
      sharedChannels: [{ channelWireId: "ch-1", ended: false } as never],
    });

    const withChat = await reader.search(workspace, { query: "tokyo" });
    expect(syncWorkspaceSharedChannels).toHaveBeenCalledTimes(1);
    expect(withChat.sharedChannelRowsUncovered).toBe(3);
    expect(withChat.complete).toBe(false);

    syncWorkspaceSharedChannels.mockClear();
    retrieveWorkspace.mockResolvedValueOnce(baseResult());
    const pagesOnly = await reader.search(workspace, { query: "tokyo", surfaces: ["page"] });
    expect(syncWorkspaceSharedChannels).not.toHaveBeenCalled();
    expect(pagesOnly.complete).toBe(true);
  });

  it("throws when the workspace engine is unavailable", async () => {
    const reader = createWorkspaceRetrievalReader({
      withAdapter: async () => null,
      syncWorkspaceSharedChannels: async () => 0,
    });
    await expect(reader.search(ownerWorkspace(), { query: "tokyo" })).rejects.toThrow(
      "Workspace engine is unavailable.",
    );
  });
});
