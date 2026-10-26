import { expect, it } from "vitest";
import { AccessAnswer, AccessObjectRef } from "./access";

it("allowlists every answer field, including nested selectors and Collection capabilities", () => {
  const secret = { credentials: "secret", bearerUrl: "secret", browserInvitationUrl: "secret", shareCode: "secret" };
  const answer = AccessAnswer.parse({ ...secret, ref: { kind: "path", path: "Notes/a.md", versionId: null },
    visibility: "visible", checkedAtMs: 100, freshness: "stale", nextCursor: null, unknownReason: null,
    coverage: { kind: "granted", complete: true, observation: "interval", ...secret },
    rows: [{ ...secret, kind: "share", shareId: "s", grantId: "g", via: "named", granterUserId: "owner", granterEmail: null,
      recipientUserId: "recipient", recipientEmail: null, subjectName: null, sharerName: null, generation: 1, status: "active", access: "view",
      selector: { kind: "group", channelWireId: "group", paths: ["Notes"], versionId: null, ...secret }, fileScope: "not-served" },
    { ...secret, kind: "collection", datasetId: "00000000-0000-4000-8000-000000000001", principal: "app", appId: "app",
      operationIds: ["operation"], revision: 1, revisionSha256: "a".repeat(64), compatible: false }],
  });
  expect(JSON.stringify(answer)).not.toContain("secret");
  expect(answer.rows[0]).toMatchObject({ selector: { kind: "group" }, fileScope: "not-served" });
});
it("requires a closed reason exactly when coverage is unavailable", () => {
  const base = { ref: null, rows: [], visibility: "unknown", checkedAtMs: null, freshness: "unknown", nextCursor: null,
    coverage: { kind: "unavailable", complete: false, observation: "interval" } };
  for (const unknownReason of ["signed-out", "not-synced", "other-account", "other-server", "not-listed-yet", "changed", "unreadable"]) {
    expect(AccessAnswer.parse({ ...base, unknownReason })).toHaveProperty("unknownReason", unknownReason);
    for (const kind of ["granted", "received-own-grant", "received-account", "collection"]) {
      expect(AccessAnswer.safeParse({ ...base, unknownReason, coverage: { ...base.coverage, kind } }).success).toBe(false);
    }
  }
  for (const unknownReason of [undefined, null, "hidden", "missing", "other@test.dev", { accountId: "other" }]) {
    expect(AccessAnswer.safeParse({ ...base, unknownReason }).success).toBe(false);
  }
  expect(AccessAnswer.safeParse({ ...base, unknownReason: null, coverage: { ...base.coverage, kind: "granted" } }).success).toBe(true);
});
it("rejects identity and cross-workspace selectors in object references", () => {
  for (const ref of [{ kind: "path", path: "file", workspaceId: "other" }, { kind: "file", objectId: "id", userId: "owner" },
    { kind: "collection", datasetId: "not-a-dataset" }]) expect(AccessObjectRef.safeParse(ref).success).toBe(false);
});

it.each(["hidden", "missing"])("requires null reasons when visibility is %s", visibility => {
  const answer = { ref: null, rows: [], visibility, checkedAtMs: null, freshness: "unknown", nextCursor: null,
    coverage: { kind: "unavailable", complete: false, observation: "interval" }, unknownReason: null };
  expect(AccessAnswer.parse(answer)).toHaveProperty("unknownReason", null);
  for (const unknownReason of [undefined, "signed-out", "not-synced", "other-account", "other-server", "not-listed-yet", "changed", "unreadable"]) {
    expect(AccessAnswer.safeParse({ ...answer, unknownReason }).success).toBe(false);
  }
  for (const kind of ["granted", "received-own-grant", "received-account", "collection"]) {
    expect(AccessAnswer.parse({ ...answer, coverage: { ...answer.coverage, kind } })).toHaveProperty("unknownReason", null);
    expect(AccessAnswer.safeParse({ ...answer, unknownReason: "unreadable", coverage: { ...answer.coverage, kind } }).success).toBe(false);
  }
});

it("keeps refresh outcomes distinct from completed observations", async () => {
  const { AccessRefreshResult } = await import("./access");
  for (const status of ["requested", "joined", "paced"] as const) expect(AccessRefreshResult.parse({ status, token: "secret" })).toEqual({ status });
  expect(AccessRefreshResult.parse({ status: "unavailable", reason: "signed-out" })).toEqual({ status: "unavailable", reason: "signed-out" });
  expect(AccessRefreshResult.safeParse({ status: "complete" }).success).toBe(false);
  expect(AccessRefreshResult.safeParse({ status: "unavailable" }).success).toBe(false);
});
