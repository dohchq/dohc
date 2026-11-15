import { expect, it } from "vitest";
import { createNamedRecipientDocuments } from "./namedRecipientDocuments";
import type { SyncRelayShareGrantRow, SyncRelayShareRow, SyncRelayStorage } from "./storage";

const origin = "https://share.example.test",
  exchangeKey = "k".repeat(32);
const limits = {
  maxSessions: 8,
  retentionMs: 30_000,
  maxPendingRequests: 4,
  maxRequestBytes: 16_384,
  maxResponseBytes: 16_384,
  timeoutMs: 1_000,
};
const share: SyncRelayShareRow = {
  shareId: "share",
  workspaceId: "workspace",
  granterUserId: "owner",
  selectorJson: JSON.stringify({ paths: ["docs"], versionId: null }),
  createdAtMs: 1,
};
const grant: SyncRelayShareGrantRow = {
  grantId: "grant",
  shareId: "share",
  principalKind: "user",
  principalUserId: "alice",
  principalEmail: null,
  access: "edit",
  generation: 1,
  status: "active",
  createdAtMs: 1,
  revokedAtMs: null,
  parentGrantId: null,
};

// A path share's browser lists its pages, but never a copy of a rule file.
it("leaves rule-file copies out of a path share's document list", async () => {
  const paths = ["docs/plan.md", "docs/access.yaml.md", "docs/Access.YAML~.md"];
  const storage = {
    getShare: (id: string) => (id === share.shareId ? share : null),
    getShareGrant: (id: string) => (id === grant.grantId ? grant : null),
    workspaceIsOwnedBy: () => true,
    findChannelCreateKind: () => null,
    readCurrentFileState: () => ({
      tooMany: false,
      files: paths.map((path) => ({ path, contentKind: "text" })),
    }),
    objectIdAtPathInVersion: ({ path }: { path: string }) => `object:${path}`,
    getShareLabels: () => ({ subjectName: "Docs" }),
  } as unknown as SyncRelayStorage;
  const list = createNamedRecipientDocuments({
    storage,
    publicOrigin: origin,
    exchangeKey,
    limits,
    maxFiles: 100,
    resolveActor: async (_request, workspaceId) => ({ userId: "alice", workspaceId }),
  });
  const response = await list(
    new Request(`${origin}/sync/live/named-documents`, {
      method: "POST",
      body: JSON.stringify({ grantId: "grant" }),
      headers: {
        origin,
        "content-type": "application/json",
        "x-dohc-relay-exchange-key": exchangeKey,
        cookie: "session=alice",
      },
    }),
  );
  expect(response.status).toBe(200);
  expect((await response.json()).files).toEqual([
    { objectId: "object:docs/plan.md", path: "docs/plan.md" },
  ]);
});
