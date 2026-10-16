import { describe, expect, it, vi } from "vitest";
import { OPERATION_TABLES } from "./operationTables";
import { registerOperations, type OperationDefinition } from "./operationTable";

const names = [
  "getUserSettings", "reloadUserSettings", "setUserSettings", "setAppPinned",
  "resetUserSettings", "getUserSettingsFilePath", "openUserSettingsFile",
  "openWorkspaceSettingsFile", "getWorkspaceSettings", "setWorkspaceSettings",
  "resetWorkspaceSettings", "getWorkspaceUiState", "setWorkspaceUiState",
] as const;
const rows = Object.assign({}, ...OPERATION_TABLES) as Record<string, OperationDefinition>;

describe("settings operation rows", () => {
  it.each(names)("%s refuses an untrusted sender before parsing or running work", async name => {
    const row = rows[name];
    expect(row, name).toBeDefined();
    const device = names.indexOf(name) < 7;
    expect(row!.scope).toBe(device ? "device" : "workspace");
    expect(row!.guard).toBe(device || name === "openWorkspaceSettingsFile" ? "trusted-sender" : "active-workspace");
    const body = vi.fn();
    const admission = vi.fn();
    const parse = vi.spyOn(row!.payload, "parse");
    let invoke!: (event: unknown, payload: unknown) => Promise<unknown>;
    registerOperations({
      handle: (_channel, handler) => { invoke = handler; },
      assertTrustedSender: () => { throw new Error("untrusted"); },
      withActiveWorkspace: admission,
    }, { [name]: row! }, { [name]: body });
    await expect(invoke({}, {})).rejects.toThrow("untrusted");
    expect(parse).not.toHaveBeenCalled();
    expect(body).not.toHaveBeenCalled();
    expect(admission).not.toHaveBeenCalled();
    parse.mockRestore();
  });
});
