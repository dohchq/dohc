import { describe, expect, it } from "vitest";
import { editorTitle } from "./Explorer";
import { collectionTabPath, siteTabPath, versionCompareTabPath } from "./workbenchState";

// Open-editor rows must show product names for virtual tabs, never internal
// ids. The compare tab regressed to its raw `version_<id>` leaf until the
// PR 0M manual drive caught it.
describe("editorTitle", () => {
  it("keeps the Explorer title for a collection", () => {
    const path = collectionTabPath("notes/旅");
    expect(editorTitle(path)).toBe("旅");
    expect(editorTitle(path, "Discovered name")).toBe("旅");
  });

  it("names an app as its tab does: its folder until its page reads the app's title", () => {
    const path = siteTabPath("apps/trip");
    expect(editorTitle(path)).toBe("trip");
    expect(editorTitle(path, "Trip planner")).toBe("Trip planner");
  });

  it("names the version compare tab instead of leaking the version id", () => {
    expect(editorTitle(versionCompareTabPath("98ece0ac-1234"))).toBe(
      "Compare with Main",
    );
  });

  it("keeps plain file tabs on their basename", () => {
    expect(editorTitle("notes/plan.md")).toBe("plan.md");
  });
});
