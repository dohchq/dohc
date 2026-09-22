import { describe, expect, it } from "vitest";
import * as contract from "./bridgeContract";
import { CHANNELS, MENU_COMMANDS, WORKBENCH_MENU_COMMANDS } from "./channels";

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

function operationChannels(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return [];
  const rows = Object.values(value);
  const isTable =
    rows.length > 0 &&
    rows.every(
      (row) =>
        typeof row === "object" &&
        row !== null &&
        "channel" in row &&
        typeof row.channel === "string" &&
        "payload" in row,
    );
  return isTable ? rows.map((row: { channel: string }) => row.channel) : [];
}

describe("IPC channel names", () => {
  // ipcMain.handle throws on a second handler for one channel, which would stop
  // main at startup. Every operation table the contract exports is included.
  it("names each channel once across CHANNELS and every operation table", () => {
    const tableChannels = Object.values(contract).flatMap(operationChannels);
    expect(tableChannels).toEqual(
      expect.arrayContaining([
        contract.workspaceVersionOperations.listWorkspaceVersions.channel,
        contract.workspaceSearchOperations.searchWorkspace.channel,
      ]),
    );
    const all = [...Object.values(CHANNELS), ...tableChannels];
    const duplicates = all.filter((channel, index) => all.indexOf(channel) !== index);
    expect(duplicates).toEqual([]);
  });
});
