import { describe, expect, it } from "vitest";
import { editorTitle } from "./Explorer";
import { pluginPanelTabPath, versionCompareTabPath } from "./workbenchState";

// Open-editor rows must show product names for virtual tabs, never internal
// ids. The compare tab regressed to its raw `version_<id>` leaf until the
// PR 0M manual drive caught it.
describe("editorTitle", () => {
  it("names the version compare tab instead of leaking the version id", () => {
    expect(editorTitle(versionCompareTabPath("98ece0ac-1234"))).toBe(
      "Compare with Main",
    );
  });

  it("keeps plain file tabs on their basename", () => {
    expect(editorTitle("notes/plan.md")).toBe("plan.md");
  });

  it("names plugin panel tabs instead of leaking their URI", () => {
    expect(editorTitle(pluginPanelTabPath("hello-plugin", "main panel"))).toBe(
      "Plugin: main panel",
    );
  });
});
