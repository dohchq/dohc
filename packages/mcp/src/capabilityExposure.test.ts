import { expect, it } from "vitest";
import { advertisedCapabilityTools } from "./capabilityExposure.fixture";
import syncStopTools from "./toolsList.syncStop.json";
import mainTools from "./toolsList.main.json";
import publicationTools from "./toolsList.pr1659.json";
import chatBodyTools from "./toolsList.pr1705.json";

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
    expected.push(...publicationTools.ownerToolAdditions, ...syncStopTools.ownerToolAdditions);
    expected.sort((a, b) => a.name.localeCompare(b.name));
  }
  // Hand-reviewed #1705 removals: desktop admission counts normalized UTF-8 bytes.
  for (const removal of chatBodyTools.bodyMaxLengthRemovals) {
    const tool = expected.find(tool => tool.name === removal.name);
    if (!tool) continue;
    const schema = tool.inputSchema as { properties: { body: { maxLength?: number } } };
    expect(schema.properties.body.maxLength).toBe(removal.maxLength);
    delete schema.properties.body.maxLength;
  }
  expect(await advertisedCapabilityTools(level === "owner" ? undefined : level)).toEqual(expected);
});
