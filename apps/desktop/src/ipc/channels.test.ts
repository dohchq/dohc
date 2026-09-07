import { describe, expect, it } from "vitest";
import { MENU_COMMANDS, WORKBENCH_MENU_COMMANDS } from "./channels";

describe("editor-group menu command channels", () => {
  it("routes split through the application menu and both group actions through tab menus", () => {
    expect(MENU_COMMANDS).toContain("new-editor-group-right");
    expect(MENU_COMMANDS).not.toContain("move-tab-to-new-group");
    expect(MENU_COMMANDS).not.toContain("close-editor-group");
    expect(WORKBENCH_MENU_COMMANDS).toEqual(
      expect.arrayContaining(["move-tab-to-new-group", "close-editor-group"]),
    );
    expect(WORKBENCH_MENU_COMMANDS).not.toContain("new-editor-group-right");
  });
});
