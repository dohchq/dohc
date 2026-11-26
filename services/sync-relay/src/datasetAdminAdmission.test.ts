import { expect, it, vi } from "vitest";
import { createDatasetRoutes } from "./datasetRoutes";
import type { RelayDatasetHost } from "./datasetHost";
import type { SyncRelayStorage } from "./storage";

it("admits a workspace Admin at the Owner's rate on its Collections, and a Member at a participant's", async () => {
  const approvedArtifacts = vi.fn(async () => ({}));
  const roles: Record<string, "admin" | "member"> = { kai: "admin", sam: "member" };
  const storage = {
    unavailable: new AbortController().signal,
    workspaceIsOwnedBy: () => false,
    workspaceRoleOf: (_workspaceId: string, userId: string) =>
      roles[userId] ? { role: roles[userId], memberId: userId } : null,
  } as unknown as SyncRelayStorage;
  const route = createDatasetRoutes({ approvedArtifacts } as unknown as RelayDatasetHost, storage, {
    nowMs: () => 1000,
    limits: { participant: { capacity: 2, refillPerSecond: 0.001 } },
  });
  const read = (userId: string) =>
    route(
      new Request("https://relay/sync/w/datasets/d/artifacts"),
      { route: "dataset", workspaceId: "w", datasetId: "d", action: "artifacts" },
      { kind: "named", workspaceId: "w", userId },
    ).then(
      (response) => response.status,
      (error: { code?: string }) => error.code,
    );
  const statuses = async (userId: string) => {
    const seen = [];
    for (let attempt = 0; attempt < 4; attempt++) seen.push(await read(userId));
    return seen;
  };
  expect(await statuses("kai")).toEqual([200, 200, 200, 200]);
  expect(await statuses("sam")).toEqual([
    200,
    200,
    "link_read_rate_limited",
    "link_read_rate_limited",
  ]);
  roles.kai = "member";
  expect(await statuses("kai")).toEqual([
    200,
    200,
    "link_read_rate_limited",
    "link_read_rate_limited",
  ]);
});
