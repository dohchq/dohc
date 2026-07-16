import { describe, expect, it, vi } from "vitest";
import { projectChatBookmarksAfterPull } from "./chatBookmarkPullProjection";

describe("post-pull chat bookmark projection", () => {
  it("does not write personal bookmark files into a shared view", async () => {
    const project = vi.fn(async () => undefined);
    const reportError = vi.fn();

    await projectChatBookmarksAfterPull({ readOnly: true, project, reportError });

    expect(project).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("contains projection failures after an owned-workspace pull", async () => {
    const failure = new Error("projection failed");
    const reportError = vi.fn();

    await expect(projectChatBookmarksAfterPull({
      readOnly: false,
      project: async () => {
        throw failure;
      },
      reportError,
    })).resolves.toBeUndefined();
    expect(reportError).toHaveBeenCalledWith(failure);
  });
});
