import { expect, it } from "vitest";
import { advertisedCapabilityTools } from "./capabilityExposure.fixture";
import mainTools from "./toolsList.main.json";
import publicationTools from "./toolsList.pr1659.json";

it.each(["owner", "view", "comment", "edit"] as const)("preserves main tools/list output for %s", async level => {
  // Hand-reviewed #1659 additions. Never regenerate the hashed main baseline.
  const expected: { name: string; inputSchema: Record<string, unknown> }[] = structuredClone(mainTools[level]);
  if (level === "owner") {
    const dataset = expected.find(tool => tool.name === "dohc_dataset")!;
    const schema = dataset.inputSchema as {
      properties: { request: { oneOf: { properties: { action: { const: string } } & Record<string, unknown> }[] } };
    };
    const actions = schema.properties.request.oneOf;
    for (const [action, properties] of Object.entries(publicationTools.datasetPropertyAdditions)) {
      const schema = actions.find(option => option.properties.action.const === action)!;
      for (const name of Object.keys(properties)) expect(schema.properties).not.toHaveProperty(name);
      Object.assign(schema.properties, properties);
    }
    for (const tool of publicationTools.ownerToolAdditions) {
      expect(expected.some(existing => existing.name === tool.name)).toBe(false);
    }
    expected.push(...publicationTools.ownerToolAdditions);
    expected.sort((a, b) => a.name.localeCompare(b.name));
  }
  // Body admission now uses normalized UTF-8 bytes in the desktop.
  for (const tool of expected) {
    if (!["dohc_start_file_chat", "dohc_start_group_chat", "dohc_reply_to_chat"].includes(tool.name)) continue;
    const schema = tool.inputSchema as { properties: { body: { maxLength?: number } } };
    expect(schema.properties.body.maxLength).toBe(65_536);
    delete schema.properties.body.maxLength;
  }
  expect(await advertisedCapabilityTools(level === "owner" ? undefined : level)).toEqual(expected);
});
