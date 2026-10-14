import {describe, expect, it} from "vitest";
import {decodeWorkspaceResult, WORKSPACE_METHOD, type WorkspaceMethodParamsMap} from "./workspaceWireContract";

describe("checked delete recovery wire contract", () => {
  const pending = {momentId: "delete", versionId: "main", objectId: "object", path: "note.md",
    expectedSha256: "a".repeat(64), reason: "checked-delete-replication-dependents", action: "finish-delete"};
  it("carries the durable identity, mapped reason and explicit action", () => {
    const result = {deletions: [pending]};
    expect(decodeWorkspaceResult(WORKSPACE_METHOD.checkedDeletesList, result)).toEqual(result);
    const params: WorkspaceMethodParamsMap[typeof WORKSPACE_METHOD.checkedDeletesResolve] = {
      momentId: pending.momentId, expectedSha256: pending.expectedSha256, action: "finish-delete",
    };
    expect(params.action).toBe("finish-delete");
    expect(decodeWorkspaceResult(WORKSPACE_METHOD.checkedDeletesResolve, {settled: true})).toEqual({settled: true});
  });
  it("rejects unknown recovery reasons and mismatched actions", () => {
    for (const changed of [{reason: "unknown"}, {action: "retry"}, {expectedSha256: "bad"}]) {
      expect(() => decodeWorkspaceResult(WORKSPACE_METHOD.checkedDeletesList, {deletions: [{...pending, ...changed}]})).toThrow();
    }
  });
});
