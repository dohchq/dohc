import { expect, it } from "vitest";
import { advertisedRemoteTools, REMOTE_MCP_INVENTORY_CASES } from "./remoteMcpInventory.fixture";
import mainTools from "./remoteMcpTools.main.json";

it.each(REMOTE_MCP_INVENTORY_CASES)("preserves main share-link MCP names and input schemas for $key", async condition => {
  // A Group link offers its files' tools, at their access, and the channel's in place of the discussion's,
  // as the viewer does; only a read-write link posts there.
  const files = condition.channel === null ? condition.key : `${condition.access}/current/live`;
  const expected = [...mainTools[files as Exclude<keyof typeof mainTools, "group-channel">], ...(condition.channel === null ? [] : mainTools["group-channel"])]
    .filter(tool => condition.access === "edit" || tool.name !== "dohc_list_changes")
    .filter(tool => condition.channel === "read-write" || tool.name !== "dohc_post_channel")
    .filter(tool => condition.channel === null || !["dohc_read_discussion", "dohc_post_discussion"].includes(tool.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  expect(await advertisedRemoteTools(condition)).toEqual(expected);
});
