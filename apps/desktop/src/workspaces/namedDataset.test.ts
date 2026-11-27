import { expect, it, vi } from "vitest";
import { createNamedDatasetData } from "./namedDataset";
import { SHARE_VIEW_REOPEN_MESSAGE } from "./shareViewMarker";
import { JOINED_BY_ANOTHER_ACCOUNT } from "../ipc/joinedAccountWords";
import { markDatasetServerNotFound } from "../ipc/errorWords";

const marker = {
  shareId: "share",
  recipientUserId: "helper",
  relayUrl: "https://relay.example",
  grantedSelector: { paths: ["apps/form"], versionId: null, access: "view" },
};
const input = () => ({
  workspaceId: "local-share-copy",
  shareView: marker,
  credentials: {
    serverUrl: "https://account",
    relayUrl: "https://relay.example",
    token: "token",
    userId: "helper",
    email: "helper@example.test",
  },
  credentialGeneration: 1,
  currentCredentialGeneration: () => 1,
  signal: new AbortController().signal,
  assertCurrent() {},
  relayJson: vi.fn(async () => ({ datasets: [], nextCursor: null })),
});
it("routes source-view recipients through share identity without claiming owner or grant authority", async () => {
  const deps = input(),
    data = createNamedDatasetData(deps);
  expect(await data.list({})).toEqual({ datasets: [], nextCursor: null });
  expect(deps.relayJson).toHaveBeenCalledWith(
    deps.credentials,
    "/sync/shares/share/datasets",
    expect.anything(),
  );
  expect(data).not.toHaveProperty("approvedArtifacts");
});
it("refuses ended-share requests with the access reason before transport", () => {
  const deps = input();
  expect(() => createNamedDatasetData({ ...deps, shareView: { ...marker, ended: true } })).toThrow(
    "Your access to this share ended. Ask the owner to share it again.",
  );
  expect(deps.relayJson).not.toHaveBeenCalled();
});
it.each([
  { ...marker, recipientUserId: undefined },
  { ...marker, shareId: undefined },
])("asks to reopen a marker that lost its identity, before any read or write", (shareView) => {
  const deps = input();
  expect(() =>
    createNamedDatasetData({
      ...deps,
      shareView: { ...shareView, grantedSelector: { ...marker.grantedSelector, access: "edit" } },
    }),
  ).toThrow(SHARE_VIEW_REOPEN_MESSAGE);
  expect(deps.relayJson).not.toHaveBeenCalled();
});
it.each([
  null,
  {},
  { ...marker, grantedSelector: null },
  { ...marker, relayUrl: "https://different" },
])("refuses damaged or wrong-origin share markers before transport", (shareView) => {
  const deps = input();
  expect(() => createNamedDatasetData({ ...deps, shareView })).toThrow();
  expect(deps.relayJson).not.toHaveBeenCalled();
});
it("refuses a joined workspace's Collections while another account is signed in, before transport", async () => {
  const deps = input(),
    joined = {
      ...marker,
      grantedSelector: { paths: [], versionId: null, access: "edit", wholeWorkspace: true },
    };
  expect(() =>
    createNamedDatasetData({
      ...deps,
      shareView: joined,
      credentials: { ...deps.credentials, userId: "other" },
    }),
  ).toThrow(JOINED_BY_ANOTHER_ACCOUNT);
  expect(deps.relayJson).not.toHaveBeenCalled();
  await createNamedDatasetData({ ...deps, shareView: joined }).list({});
  expect(deps.relayJson).toHaveBeenCalledOnce();
});
it("sends an Admin's Collection access requests to the owner's workspace, not the local copy", async () => {
  const deps = {
      ...input(),
      relayJson: vi.fn(async (..._: unknown[]): Promise<unknown> => ({
        permissions: [],
        nextCursor: null,
        defaults: null,
      })),
    },
    request = {
      workspaceId: "local-share-copy",
      action: "permissions" as const,
      datasetId: "00000000-0000-4000-8000-000000000001",
    },
    joined = {
      ...marker,
      grantedSelector: { paths: [], versionId: null, access: "edit", wholeWorkspace: true },
      membersWorkspaceId: "owner-workspace",
    };
  await createNamedDatasetData({ ...deps, shareView: joined }).permissions(request);
  expect(deps.relayJson).toHaveBeenCalledWith(
    deps.credentials,
    expect.stringMatching(/^\/sync\/owner-workspace\/datasets\//),
    expect.anything(),
  );
  await expect(createNamedDatasetData(deps).permissions(request)).rejects.toThrow(
    "Only an Admin of a joined workspace manages Collection access.",
  );
});

it("reads who approved a Collection's rules on the owner's workspace, and says when the server shows an Admin nothing", async () => {
  const approval = {
    revisionSha256: "a".repeat(64),
    approvedBy: { role: "admin", name: "Ada", former: false, approvedAtMs: 1 },
    needsOwnerConfirmation: false,
  };
  const deps = {
    ...input(),
    relayJson: vi.fn(async (..._: unknown[]): Promise<unknown> => approval),
  };
  const joined = {
    ...marker,
    grantedSelector: { paths: [], versionId: null, access: "edit", wholeWorkspace: true },
    membersWorkspaceId: "owner-workspace",
    role: "admin",
  };
  const datasetId = "00000000-0000-4000-8000-000000000001";
  const governed = createNamedDatasetData({ ...deps, shareView: joined });
  expect(await governed.approval(datasetId)).toEqual(approval);
  expect(deps.relayJson).toHaveBeenCalledWith(
    deps.credentials,
    `/sync/owner-workspace/datasets/${datasetId}/approval`,
    expect.anything(),
  );
  deps.relayJson.mockRejectedValueOnce(
    markDatasetServerNotFound(new Error("Not found"), 404, { code: "not_found" }),
  );
  await expect(governed.approval(datasetId)).rejects.toThrow(
    "The server didn't show you who approved this Collection's rules. You may no longer be an Admin, or the Owner keeps this Collection on their computer.",
  );
  deps.relayJson.mockClear();
  await expect(
    createNamedDatasetData({ ...deps, shareView: { ...joined, role: "member" } }).approval(
      datasetId,
    ),
  ).resolves.toEqual(approval);
  expect(deps.relayJson).toHaveBeenCalledOnce();
  await expect(
    createNamedDatasetData({ ...deps, shareView: marker }).approval(datasetId),
  ).rejects.toThrow("Only an Admin of a joined workspace manages Collection access.");
});

it("sends an Admin's Collection rules to the owner's workspace, and says when the Owner's computer keeps them or they're no longer an Admin", async () => {
  const deps = { ...input(), relayJson: vi.fn(async (..._: unknown[]): Promise<unknown> => ({})) };
  const joined = {
    ...marker,
    grantedSelector: { paths: [], versionId: null, access: "edit", wholeWorkspace: true },
    membersWorkspaceId: "owner-workspace",
    role: "admin",
  };
  const datasetId = "00000000-0000-4000-8000-000000000001";
  const governed = createNamedDatasetData({ ...deps, shareView: joined }).governance();
  expect(governed.workspaceId).toBe("owner-workspace");
  deps.relayJson.mockRejectedValueOnce(
    markDatasetServerNotFound(new Error("Not found"), 404, { code: "not_found" }),
  );
  await expect(governed.data.approvedArtifacts!(datasetId)).rejects.toThrow(
    "This Collection is kept on the Owner's computer. Ask the Owner to move it to the server, then try again.",
  );
  deps.relayJson.mockRejectedValueOnce(
    markDatasetServerNotFound(new Error("Only the owner or an admin can do this."), 403, {
      code: "members_forbidden",
    }),
  );
  await expect(governed.data.approvedArtifacts!(datasetId)).rejects.toThrow(
    "You're no longer an Admin of this workspace, so you can't change its Collections' rules.",
  );
  expect(deps.relayJson).toHaveBeenCalledWith(
    deps.credentials,
    expect.stringMatching(/^\/sync\/owner-workspace\/datasets\//),
    expect.anything(),
  );
  for (const shareView of [marker, { ...joined, role: "member" }])
    expect(() => createNamedDatasetData({ ...deps, shareView }).governance()).toThrow(
      "Open the original workspace to manage this Collection.",
    );
});
