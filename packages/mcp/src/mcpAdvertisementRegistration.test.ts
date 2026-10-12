import { expect, it, vi } from "vitest";
import { advertisedCapabilityTools } from "./capabilityExposure.fixture";

vi.mock("@dohc/workspace-contracts/capabilities", async importOriginal => {
  const actual = await importOriginal<typeof import("@dohc/workspace-contracts/capabilities")>();
  const workspaceList = actual.CAPABILITIES["workspace.list"];
  return {
    ...actual,
    CAPABILITIES: {
      ...actual.CAPABILITIES,
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
