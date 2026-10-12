import { expect, it } from "vitest";
import { AccessAnswer, AccessObjectRef } from "./access";

it("allowlists every answer field, including nested selectors and Collection capabilities", () => {
  const secret = { credentials: "secret", bearerUrl: "secret", browserInvitationUrl: "secret", shareCode: "secret" };
  const answer = AccessAnswer.parse({ ...secret, ref: { kind: "path", path: "Notes/a.md", versionId: null },
    visibility: "visible", checkedAtMs: 100, freshness: "stale", nextCursor: null,
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
it("rejects identity and cross-workspace selectors in object references", () => {
  for (const ref of [{ kind: "path", path: "file", workspaceId: "other" }, { kind: "file", objectId: "id", userId: "owner" },
    { kind: "collection", datasetId: "not-a-dataset" }]) expect(AccessObjectRef.safeParse(ref).success).toBe(false);
});
