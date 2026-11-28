import { describe, expect, it } from "vitest";
import { fileCommentSendState, fileCommentWrite } from "../conversation/conversationWrites";

describe("file comment controls", () => {
  it("gates new file comments on phoneWrites, matching file read, Member access, and detects replacement while drafting", () => {
    expect(
      fileCommentSendState({
        enabled: true,
        joined: false,
        objectId: "obj-1",
        readObjectId: "obj-1",
        draftObjectId: null,
      }),
    ).toEqual({ canShow: true, canSend: true, replaced: false });

    expect(
      fileCommentSendState({
        enabled: false,
        joined: false,
        objectId: "obj-1",
        readObjectId: "obj-1",
        draftObjectId: null,
      }),
    ).toEqual({ canShow: false, canSend: false, replaced: false });

    // Cannot send before fileChats confirms matching fileObjectId.
    expect(
      fileCommentSendState({
        enabled: true,
        joined: false,
        objectId: "obj-1",
        readObjectId: undefined,
        draftObjectId: null,
      }),
    ).toEqual({ canShow: true, canSend: false, replaced: false });

    // Joined Member requires read-write access.
    expect(
      fileCommentSendState({
        enabled: true,
        joined: true,
        objectId: "obj-1",
        readObjectId: "obj-1",
        draftObjectId: null,
        access: "read-write",
      }),
    ).toEqual({ canShow: true, canSend: true, replaced: false });
    expect(
      fileCommentSendState({
        enabled: true,
        joined: true,
        objectId: "obj-1",
        readObjectId: "obj-1",
        draftObjectId: null,
        access: "read-only",
      }),
    ).toEqual({ canShow: false, canSend: false, replaced: false });

    // File replaced while draft is open: Send stays disabled and replaced is flagged.
    expect(
      fileCommentSendState({
        enabled: true,
        joined: true,
        objectId: "obj-2",
        readObjectId: "obj-2",
        draftObjectId: "obj-1",
        access: "read-write",
      }),
    ).toEqual({ canShow: true, canSend: false, replaced: true });
    expect(
      fileCommentSendState({
        enabled: true,
        joined: false,
        objectId: "obj-1",
        readObjectId: "obj-2",
        draftObjectId: "obj-1",
      }),
    ).toEqual({ canShow: true, canSend: false, replaced: true });
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
