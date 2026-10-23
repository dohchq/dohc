import { expect, it } from "vitest";
import { advertisedRemoteTools, REMOTE_MCP_INVENTORY_CASES } from "./remoteMcpInventory.fixture";
import mainTools from "./remoteMcpTools.main.json";

it.each(REMOTE_MCP_INVENTORY_CASES)("preserves main share-link MCP names and input schemas for $key", async condition => {
  // A Group link offers its files' tools, at their access, and the channel's.
  const files = condition.channel === null ? condition.key : `${condition.access}/current/live`;
  const expected = [...mainTools[files as Exclude<keyof typeof mainTools, "group-channel">], ...(condition.channel === null ? [] : mainTools["group-channel"])]
    .filter(tool => condition.access === "edit" || tool.name !== "dohc_list_changes")
    .sort((a, b) => a.name.localeCompare(b.name));
  expect(await advertisedRemoteTools(condition)).toEqual(expected);
});
