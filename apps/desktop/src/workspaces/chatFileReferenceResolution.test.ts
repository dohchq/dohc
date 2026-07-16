import { describe, expect, it, vi } from "vitest";
import { extractChatFileReferences } from "../renderer/workbench/chatFileMentions";
import {
  resolveChatFileMentionPath,
  resolveTrackedChatFilePath,
} from "./chatFileReferenceResolution";

describe("resolveChatFileMentionPath", () => {
  it("rejects an object-owned row returned by an untracked path-hint fallback", () => {
    expect(resolveChatFileMentionPath({
      requestedObjectId: null,
      attachmentObjectId: "object_moved",
      attachmentPathHint: "docs/old-name.md",
      pathByObjectId: new Map([["object_moved", "docs/new-name.md"]]),
    })).toBeNull();
  });

  it("retains legacy path-only rows for an untracked path-hint fallback", () => {
    expect(resolveChatFileMentionPath({
      requestedObjectId: null,
      attachmentPathHint: "docs/legacy.md",
      pathByObjectId: new Map(),
    })).toBe("docs/legacy.md");
  });

  it("resolves an object-owned mention through its authoritative current path", () => {
    expect(resolveChatFileMentionPath({
      requestedObjectId: "object_plan",
      attachmentObjectId: "object_plan",
      attachmentPathHint: "docs/old-plan.md",
      pathByObjectId: new Map([["object_plan", "docs/plan.md"]]),
    })).toBe("docs/plan.md");
  });
});

describe("resolveTrackedChatFilePath", () => {
  it("supports a hand-typed leading space when only the trimmed file exists", async () => {
    const [reference] = extractChatFileReferences("@[ docs/plan.md]");
    const lookup = vi.fn(async (path: string) =>
      path === "docs/plan.md" ? "object_plan" : null,
    );

    await expect(resolveTrackedChatFilePath(reference!.path, lookup)).resolves.toEqual({
      objectId: "object_plan",
      path: "docs/plan.md",
    });
    expect(lookup.mock.calls).toEqual([[" docs/plan.md"], ["docs/plan.md"]]);
  });

  it("supports a space before a hand-typed heading delimiter", async () => {
    const [reference] = extractChatFileReferences("@[docs/plan.md #scope]");
    const lookup = vi.fn(async (path: string) =>
      path === "docs/plan.md" ? "object_plan" : null,
    );

    expect(reference).toEqual({
      path: "docs/plan.md ",
      headingAnchor: "scope",
    });
    await expect(resolveTrackedChatFilePath(reference!.path, lookup)).resolves.toEqual({
      objectId: "object_plan",
      path: "docs/plan.md",
    });
  });

  it("prefers an exact space-prefixed filename over a trimmed collision", async () => {
    const lookup = vi.fn(async (path: string) => {
      if (path === " docs/plan.md") return "object_spaced";
      if (path === "docs/plan.md") return "object_trimmed";
      return null;
    });

    await expect(resolveTrackedChatFilePath(" docs/plan.md", lookup)).resolves.toEqual({
      objectId: "object_spaced",
      path: " docs/plan.md",
    });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith(" docs/plan.md");
  });

  it("does not invent a fallback when neither exact nor trimmed paths exist", async () => {
    const lookup = vi.fn(async () => null);

    await expect(resolveTrackedChatFilePath(" missing.md ", lookup)).resolves.toBeNull();
    expect(lookup.mock.calls).toEqual([[" missing.md "], ["missing.md"]]);
  });

  it("does not repeat lookup for an already-trimmed missing path", async () => {
    const lookup = vi.fn(async () => null);

    await expect(resolveTrackedChatFilePath("missing.md", lookup)).resolves.toBeNull();
    expect(lookup.mock.calls).toEqual([["missing.md"]]);
  });
});
