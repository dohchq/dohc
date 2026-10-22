import { expect, it } from "vitest";
import { advertisedCapabilityTools } from "./capabilityExposure.fixture";
import mainTools from "./toolsList.main.json";

it.each(["owner", "view", "comment", "edit"] as const)("preserves main tools/list output for %s", async level => {
  // Hand-reviewed baseline. A PR that adds or changes an MCP tool edits this file directly;
  // the generator does not regenerate it and folded changes must not hide in delta files.
  const expected: { name: string; inputSchema: Record<string, unknown> }[] = structuredClone(mainTools[level]);
  // Hand-reviewed #1705 removals: desktop admission counts normalized UTF-8 bytes.
  for (const name of ["dohc_start_file_chat", "dohc_start_group_chat", "dohc_reply_to_chat"]) {
    const tool = expected.find(tool => tool.name === name);
    if (!tool) continue;
    const schema = tool.inputSchema as { properties: { body: { maxLength?: number } } };
    expect(schema.properties.body).not.toHaveProperty("maxLength");
  }
  // Keep the baseline's diff to the move description; pin the other two reviewed descriptions here.
  for (const [name, description] of [
    ["dohc_read_operation", "List the paths changed by one operation, up to 50 per page. Returns change references and paths without retained contents, and a file move's link update state. Owner workspace only."],
    ["dohc_undo_operation", "Undo a delete, move, or rename by its operation id. Requires dohc open and the owning workspace. Returns History restoration state, restored paths, and remaining paths with reasons and retry flags. Undo again to retry each remaining path marked retry. Undo of a move also reverses its link updates."],
  ]) {
    const tool = expected.find(tool => tool.name === name);
    if (tool) Object.assign(tool, {description});
  }
  expect(await advertisedCapabilityTools(level === "owner" ? undefined : level)).toEqual(expected);
});
