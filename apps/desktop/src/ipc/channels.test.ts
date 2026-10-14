import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as contract from "./bridgeContract";
import { CHANNELS, MENU_COMMANDS, WORKBENCH_MENU_COMMANDS } from "./channels";
import launchOpenIpc from "./ipcExposure.pr1701.json";
import restartCaptureIpc from "./ipcExposure.pr1719.json";
import historyNamesIpc from "./ipcExposure.pr1785.json";
import offersIpc from "./ipcExposure.offers.json";
import usageRecordIpc from "./ipcExposure.usageRecord.json";

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
  it("adds no keys to CHANNELS beyond hand-reviewed records; migrations remove keys into operation tables", () => {
    const mainKeys = JSON.parse(readFileSync(new URL("./channelKeys.main.json", import.meta.url), "utf8")) as string[];
    // An operation table carries renderer requests only, so a new event from
    // main needs a key here and a reviewed record.
    const additions = [...launchOpenIpc.channelKeyAdditions, ...restartCaptureIpc.channelKeyAdditions, ...historyNamesIpc.channelKeyAdditions, ...offersIpc.channelKeyAdditions,
      ...usageRecordIpc.channelKeyAdditions];
    for (const key of additions) expect(mainKeys).not.toContain(key);
    const reviewed = [...mainKeys, ...additions];
    expect(Object.keys(CHANNELS).filter(key => !reviewed.includes(key))).toEqual([]);
  });
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
