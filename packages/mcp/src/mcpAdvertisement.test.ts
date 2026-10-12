import { expect, it, vi } from "vitest";
import { deriveMcpToolLevels, MCP_TOOL_LEVELS } from "./mcpAdvertisement";

const exposure = (levels: readonly ("owner" | "view" | "comment" | "edit")[]) => ({
  mcp: {
    owner: levels.includes("owner") ? ["tool"] : [],
    view: levels.includes("view") ? ["tool"] : [],
    comment: levels.includes("comment") ? ["tool"] : [],
    edit: levels.includes("edit") ? ["tool"] : [],
  },
});

it.each(["edit", "owner"] as const)("advertises a %s-only tool only at that level", level => {
  expect(deriveMcpToolLevels({ tool: ["action"] }, { action: exposure([level]) }))
    .toEqual({ tool: [level] });
});

it("requires every id of a multiplexed tool to agree at every level", () => {
  expect(deriveMcpToolLevels({ tool: ["first", "second"] }, {
    first: exposure(["owner", "edit"]), second: exposure(["owner", "edit"]),
  })).toEqual({ tool: ["owner", "edit"] });
  expect(() => deriveMcpToolLevels({ tool: ["first", "second"] }, {
    first: exposure(["owner"]), second: exposure(["owner", "edit"]),
  })).toThrow(/tool.*edit/);
});

it("does not advertise a tool whose ids agree on no levels", () => {
  expect(deriveMcpToolLevels({ tool: ["action"] }, { action: exposure([]) }))
    .toEqual({ tool: [] });
});

it("derives the real multiplexed tools and the Edit-only exception", () => {
  expect(MCP_TOOL_LEVELS.dohc_dataset).toEqual(["owner"]);
  expect(MCP_TOOL_LEVELS.dohc_publish_app).toEqual(["owner"]);
  expect(MCP_TOOL_LEVELS.dohc_switch_automation).toEqual(["edit"]);
});

it("refuses disagreement during module load", async () => {
  vi.resetModules();
  vi.doMock("./tools", () => ({
    MCP_TOOL_CAPABILITIES: { dohc_list_workspaces: ["workspace.list", "automation.switch"] },
  }));
  try {
    await expect(import("./mcpAdvertisement")).rejects.toThrow(/dohc_list_workspaces/);
  } finally {
    vi.doUnmock("./tools");
    vi.resetModules();
  }
});
