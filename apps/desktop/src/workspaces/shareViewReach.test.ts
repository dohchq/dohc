import { describe, expect, it } from "vitest";
import { grantLevels } from "./shareViewReach";

const workspace = (access: "view" | "comment" | "edit") => ({
  paths: [],
  versionId: null,
  access,
  wholeWorkspace: true as const,
});

const reach = (groupDefault: string, groups: Array<{ channelWireId: string; level: string }>) => ({
  signature: "r",
  visibilitySignature: "v",
  rootLevel: "comment",
  folders: [],
  groupDefault,
  groups,
});

describe("a joined workspace's Group levels", () => {
  it("takes each listed Group's level, and the default for any other", () => {
    const levels = grantLevels(
      workspace("comment"),
      reach("comment", [{ channelWireId: "wire-news", level: "view" }]),
    );
    expect(levels.group("wire-news")).toBe("view");
    expect(levels.group("wire-team")).toBe("comment");
    expect(levels.postsInSomeGroup).toBe(true);
  });

  it("posts in some Group when only a listed Group takes posts", () => {
    const levels = grantLevels(
      workspace("view"),
      reach("view", [{ channelWireId: "wire-open", level: "comment" }]),
    );
    expect(levels.group("wire-open")).toBe("comment");
    expect(levels.group("wire-team")).toBe("view");
    expect(levels.postsInSomeGroup).toBe(true);
    expect(grantLevels(workspace("view"), reach("view", [])).postsInSomeGroup).toBe(false);
  });

  it("takes the member level in every Group until a reach is stored, and none from one it can't read", () => {
    const unlisted = grantLevels(workspace("view"), undefined);
    expect(unlisted.group("wire-team")).toBe("view");
    expect(unlisted.postsInSomeGroup).toBe(false);
    const unreadable = grantLevels(workspace("comment"), { ...reach("comment", []), groups: 7 });
    expect(unreadable.group("wire-team")).toBeNull();
    expect(unreadable.postsInSomeGroup).toBe(false);
  });
});
