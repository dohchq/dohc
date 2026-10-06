import { expect, it } from "vitest";
import { advertisedRemoteTools, REMOTE_MCP_INVENTORY_CASES } from "./remoteMcpInventory.fixture";
import mainTools from "./remoteMcpTools.main.json";

it.each(REMOTE_MCP_INVENTORY_CASES)("preserves main share-link MCP names and input schemas for $key", async condition => {
  expect(await advertisedRemoteTools(condition)).toEqual(mainTools[condition.key as keyof typeof mainTools]);
});
