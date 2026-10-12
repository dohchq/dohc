import { expect, it, vi } from "vitest";
import { advertisedCapabilityTools } from "./capabilityExposure.fixture";

vi.mock("@dohc/workspace-contracts/capabilities", async importOriginal => {
  const actual = await importOriginal<typeof import("@dohc/workspace-contracts/capabilities")>();
  const workspaceList = actual.CAPABILITIES["workspace.list"];
  const fileWrite = actual.CAPABILITIES["file.write"];
  return {
    ...actual,
    CAPABILITIES: {
      ...actual.CAPABILITIES,
      "file.write": {
        ...fileWrite,
        mcp: { ...fileWrite.mcp, edit: [...fileWrite.mcp.edit, "dohc_write_file"] },
      },
      "workspace.list": {
        ...workspaceList,
        mcp: { ...workspaceList.mcp, owner: [], comment: [], edit: [] },
      },
    },
  };
});

it.each(["owner", "view", "comment", "edit"] as const)(
  "uses table exposure even for previously unconditional registrations at %s", async level => {
    const tools = await advertisedCapabilityTools(level === "owner" ? undefined : level);
    expect(tools.some(tool => tool.name === "dohc_list_workspaces")).toBe(level === "view");
  },
);

it.each(["owner", "view", "comment", "edit"] as const)(
  "uses table exposure even for previously Owner-only registrations at %s", async level => {
    const tools = await advertisedCapabilityTools(level === "owner" ? undefined : level);
    expect(tools.some(tool => tool.name === "dohc_write_file"))
      .toBe(level === "owner" || level === "edit");
  },
);
