import { describe, expect, it } from "vitest";
import { canStartFileComment, fileCommentWrite } from "../conversation/conversationWrites";

describe("file comment controls", () => {
  it("gates new file comments on phoneWrites, objectId, and Member read-write access", () => {
    expect(canStartFileComment({ enabled: true, joined: false, objectId: "obj-1" })).toBe(true);
    expect(canStartFileComment({ enabled: false, joined: false, objectId: "obj-1" })).toBe(false);
    expect(canStartFileComment({ enabled: true, joined: false, objectId: null })).toBe(false);
    expect(
      canStartFileComment({ enabled: true, joined: true, objectId: "obj-1", access: "read-write" }),
    ).toBe(true);
    expect(
      canStartFileComment({ enabled: true, joined: true, objectId: "obj-1", access: "read-only" }),
    ).toBe(false);
    expect(canStartFileComment({ enabled: true, joined: true, objectId: "obj-1" })).toBe(false);
  });

  it("builds a file comment write bound to expectedObjectId only for non-empty inputs", () => {
    expect(fileCommentWrite("docs/plan.md", "obj-1", "Looks good")).toEqual({
      operation: "comment",
      args: { path: "docs/plan.md", expectedObjectId: "obj-1", body: "Looks good" },
    });
    expect(fileCommentWrite("docs/plan.md", "obj-1", "   ")).toBeNull();
    expect(fileCommentWrite("", "obj-1", "Hi")).toBeNull();
    expect(fileCommentWrite("docs/plan.md", "", "Hi")).toBeNull();
  });
});
