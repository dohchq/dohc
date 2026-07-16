import { describe, expect, it, vi } from "vitest";
import { writeChatBookmarkProjection } from "./chatBookmarkProjectionWrite";
import type { WorkspaceEngineCapture } from "./workspaceEngineCapture";

type GeneratedWriteInput = Parameters<WorkspaceEngineCapture["writeGeneratedTextFile"]>[0];

describe("chat bookmark projection ownership", () => {
  it("does not grant first projection authority over a pre-existing destination", async () => {
    const writeGeneratedTextFile = vi.fn(async (input: GeneratedWriteInput) => {
      if (!input.expectedObjectId) {
        throw new Error("Generated Markdown destination already exists");
      }
      return { path: "Bookmarks/Chats/post.md", objectId: input.expectedObjectId, changed: true };
    });

    await expect(
      writeChatBookmarkProjection({
        bookmark: { destinationPath: "Bookmarks/Chats/post.md" },
        text: "# Saved post\n",
        capture: { writeGeneratedTextFile },
      }),
    ).rejects.toThrow(/destination already exists/u);
    expect(writeGeneratedTextFile).toHaveBeenCalledWith({
      path: "Bookmarks/Chats/post.md",
      text: "# Saved post\n",
      createOnly: true,
    });
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
