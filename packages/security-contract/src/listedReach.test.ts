import { describe, expect, it } from "vitest";
import { highestListedLevel, levelAtPath, parseListedReach, type ListedReach } from "./listedReach";

const reach: ListedReach = {
  revision: "r1",
  visibilityRevision: "v1",
  rootLevel: "comment",
  folders: [
    { path: "Plans", level: "edit" },
    { path: "Plans/Budget", level: "view" },
  ],
};

describe("levelAtPath", () => {
  it("gives each listed folder its own level", () => {
    expect(levelAtPath(reach, "notes.md")).toBe("comment");
    expect(levelAtPath(reach, "Plans/trip.md")).toBe("edit");
    expect(levelAtPath(reach, "Plans/Budget/q1.md")).toBe("view");
  });

  it("gives an unlisted folder its nearest listed ancestor's level", () => {
    expect(levelAtPath(reach, "Plans/Archive/2025/old.md")).toBe("edit");
    expect(levelAtPath(reach, "Plans/Budget/Drafts/q2.md")).toBe("view");
    expect(levelAtPath(reach, "Other/deep/file.md")).toBe("comment");
  });

  it("gives a new file under a hidden folder's name the nearest listed level", () => {
    // `Plans/Secret` is hidden on the relay, so it is never listed. The gate
    // knows nothing of it, and the relay refuses the create.
    expect(levelAtPath(reach, "Plans/Secret/new.md")).toBe("edit");
  });

  it("matches folders exactly, as a rule applies only in its own folder", () => {
    expect(levelAtPath(reach, "plans/trip.md")).toBe("comment");
    expect(levelAtPath(reach, "Plans2/trip.md")).toBe("comment");
  });

  it("gives no level at a hidden root or at a rule file", () => {
    expect(levelAtPath({ ...reach, rootLevel: null }, "notes.md")).toBeNull();
    expect(levelAtPath({ ...reach, rootLevel: null }, "Plans/trip.md")).toBe("edit");
    expect(levelAtPath(reach, "Plans/access.yaml")).toBeNull();
    expect(levelAtPath(reach, "Plans/access.yaml~")).toBeNull();
  });
});

describe("highestListedLevel", () => {
  it("is the highest level anywhere", () => {
    expect(highestListedLevel(reach)).toBe("edit");
    expect(highestListedLevel({ ...reach, rootLevel: null, folders: [] })).toBeNull();
  });
});

describe("parseListedReach", () => {
  it("reads the relay's answer and refuses any unreadable part", () => {
    expect(parseListedReach({ ok: true, watermark: 4, ...reach })).toEqual(reach);
    expect(parseListedReach({ ...reach, rootLevel: "owner" })).toBeNull();
    expect(parseListedReach({ ...reach, revision: "" })).toBeNull();
    expect(parseListedReach({ ...reach, visibilityRevision: undefined })).toBeNull();
    expect(parseListedReach({ ...reach, folders: [{ path: "", level: "edit" }] })).toBeNull();
    expect(parseListedReach({ ...reach, folders: [{ path: "a//b", level: "edit" }] })).toBeNull();
    expect(
      parseListedReach({
        ...reach,
        folders: [
          { path: "a", level: "edit" },
          { path: "a", level: "view" },
        ],
      }),
    ).toBeNull();
    expect(parseListedReach({ ...reach, folders: [{ path: "a", level: "admin" }] })).toBeNull();
  });
});
