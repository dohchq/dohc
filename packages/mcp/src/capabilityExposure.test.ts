import { expect, it } from "vitest";
import { advertisedCapabilityTools } from "./capabilityExposure.fixture";
import mainTools from "./toolsList.main.json";

it.each(["owner", "view", "comment", "edit"] as const)("preserves main tools/list output for %s", async level => {
  // Hand-reviewed baseline. A PR that adds or changes an MCP tool edits this file directly;
  // the generator does not regenerate it and folded changes must not hide in delta files.
  const expected: { name: string; inputSchema: Record<string, unknown> }[] = structuredClone(mainTools[level]);
  if (level === "owner") {
    const dataset = expected.find(tool => tool.name === "dohc_dataset")!;
    const schema = dataset.inputSchema as {
      properties: { request: { oneOf: { properties: { action: { const: string } } & Record<string, unknown> }[] } };
    };
    const actions = schema.properties.request.oneOf;
    for (const [action, properties] of Object.entries({
      approve: { agentLabel: { type: "string", minLength: 1, maxLength: 160 } },
      approveMigration: { agentLabel: { type: "string", minLength: 1, maxLength: 160 } },
    })) {
      const schema = actions.find(option => option.properties.action.const === action)!;
      for (const [name, value] of Object.entries(properties)) expect(schema.properties).toHaveProperty(name, value);
    }
    for (const name of ["dohc_publish_app", "dohc_read_share_copy"]) expect(expected.some(tool => tool.name === name)).toBe(true);
  }
  // Hand-reviewed #1705 removals: desktop admission counts normalized UTF-8 bytes.
  for (const name of ["dohc_start_file_chat", "dohc_start_group_chat", "dohc_reply_to_chat"]) {
    const tool = expected.find(tool => tool.name === name);
    if (!tool) continue;
    const schema = tool.inputSchema as { properties: { body: { maxLength?: number } } };
    expect(schema.properties.body).not.toHaveProperty("maxLength");
  }
  expect(await advertisedCapabilityTools(level === "owner" ? undefined : level)).toEqual(expected);
});
