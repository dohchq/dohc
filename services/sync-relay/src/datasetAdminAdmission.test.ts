import { expect, it, vi } from "vitest";
import { createDatasetRoutes } from "./datasetRoutes";
import type { RelayDatasetHost } from "./datasetHost";
import type { SyncRelayStorage } from "./storage";

it("admits a workspace Admin on their own member grant at the Owner's rate, and anyone else at a participant's", async () => {
  const approvedArtifacts = vi.fn(async () => ({}));
  const roles: Record<string, "admin" | "member"> = { kai: "admin", sam: "member" };
  const storage = {
    unavailable: new AbortController().signal,
    workspaceIsOwnedBy: () => false,
    workspaceRoleOf: (_workspaceId: string, userId: string) =>
      roles[userId] ? { role: roles[userId], memberId: userId } : null,
  } as unknown as SyncRelayStorage;
  const memberAdmin = vi.fn(
    (auth: { userId: string; grantId?: string; launch?: unknown }) =>
      roles[auth.userId] === "admin" && auth.grantId === "member" && !auth.launch,
  );
  const host = { approvedArtifacts, memberAdmin } as unknown as RelayDatasetHost;
  const route = createDatasetRoutes(host, storage, {
    nowMs: () => 1000,
    limits: { participant: { capacity: 2, refillPerSecond: 0.001 } },
  });
  const read = (userId: string, auth: { grantId?: string; launch?: unknown } = {}) =>
    route(
      new Request("https://relay/sync/w/datasets/d/artifacts"),
      { route: "dataset", workspaceId: "w", datasetId: "d", action: "artifacts" },
      { kind: "named", workspaceId: "w", userId, grantId: "member", ...auth } as never,
    ).then(
      (response) => response.status,
      (error: { code?: string }) => error.code,
    );
  const statuses = async (userId: string, auth: { grantId?: string; launch?: unknown } = {}) => {
    const seen = [];
    for (let attempt = 0; attempt < 4; attempt++) seen.push(await read(userId, auth));
    return seen;
  };
  expect(await statuses("kai")).toEqual([200, 200, 200, 200]);
  expect(await statuses("sam")).toEqual([
    200,
    200,
    "link_read_rate_limited",
    "link_read_rate_limited",
  ]);
  expect(memberAdmin).toHaveBeenCalledWith(expect.objectContaining({ userId: "kai" }), "w");
  roles.ana = "admin";
  expect(await statuses("ana", { launch: {} })).toEqual([
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
