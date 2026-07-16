import { describe, expect, it, vi } from "vitest";
import { writeChatBookmarkProjection } from "./chatBookmarkProjectionWrite";
import type { WorkspaceEngineCapture } from "./workspaceEngineCapture";

type GeneratedWriteInput = Parameters<WorkspaceEngineCapture["writeGeneratedTextFile"]>[0];

describe("chat bookmark projection ownership", () => {
  it("does not grant first projection authority over a pre-existing destination", async () => {
    const writeGeneratedTextFile = vi.fn(async (input: GeneratedWriteInput) => {
      if (
        !input.recoverExistingText ||
        !input.recoverExistingText(
          "---\ndohc_type: chat-bookmark\nbookmark_id: \"someone-elses-bookmark\"\n---\n",
        )
      ) {
        throw new Error("Generated Markdown destination already exists");
      }
      return {
        path: "Bookmarks/Chats/post.md",
        objectId: input.expectedObjectId ?? "object-recovered-projection",
        changed: true,
      };
    });

    await expect(
      writeChatBookmarkProjection({
        bookmark: {
          bookmarkId: "bookmark-post",
          destinationPath: "Bookmarks/Chats/post.md",
        },
        text: "# Saved post\n",
        capture: { writeGeneratedTextFile },
      }),
    ).rejects.toThrow(/destination already exists/u);
    const recoveryInput = writeGeneratedTextFile.mock.calls[0]?.[0];
    expect(recoveryInput).toMatchObject({
      path: "Bookmarks/Chats/post.md",
      text: "# Saved post\n",
    });
    expect(recoveryInput?.recoverExistingText).toEqual(expect.any(Function));
  });

  it("reuses only the object id already persisted as this bookmark's projection", async () => {
    const writeGeneratedTextFile = vi.fn(async (input) => ({
      path: input.path,
      objectId: input.expectedObjectId!,
      changed: true,
    }));

    await expect(
      writeChatBookmarkProjection({
        bookmark: {
          bookmarkId: "bookmark-post",
          destinationPath: "Bookmarks/Chats/post.md",
          projectionObjectId: "object-owned-projection",
        },
        text: "# Refreshed post\n",
        capture: { writeGeneratedTextFile },
      }),
    ).resolves.toMatchObject({ objectId: "object-owned-projection" });
    expect(writeGeneratedTextFile).toHaveBeenCalledWith({
      path: "Bookmarks/Chats/post.md",
      text: "# Refreshed post\n",
      expectedObjectId: "object-owned-projection",
    });
  });
});
