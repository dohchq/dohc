import { expect, it } from "vitest";
import { advertisedCapabilityTools } from "./capabilityExposure.fixture";
import mainTools from "./toolsList.main.json";

it.each(["owner", "view", "comment", "edit"] as const)(
  "preserves main tools/list output for %s",
  async (level) => {
    // Hand-reviewed baseline. A PR that adds or changes an MCP tool edits this file directly;
    // the generator does not regenerate it and folded changes must not hide in delta files.
    const expected: { name: string; inputSchema: Record<string, unknown> }[] = structuredClone(
      mainTools[level],
    );
    // Hand-reviewed removals: desktop admission counts normalized UTF-8 bytes.
    for (const name of ["dohc_start_file_chat", "dohc_start_group_chat", "dohc_reply_to_chat"]) {
      const tool = expected.find((tool) => tool.name === name);
      if (!tool) continue;
      const schema = tool.inputSchema as { properties: { body: { maxLength?: number } } };
      expect(schema.properties.body).not.toHaveProperty("maxLength");
    }
    expect(await advertisedCapabilityTools(level === "owner" ? undefined : level)).toEqual(
      expected,
    );
  },
);

it("offers workspace setup only to the owner's own agents", async () => {
  const setup = [
    "dohc_read_automation_host",
    "dohc_use_server_for_automations",
    "dohc_list_incoming_webhooks",
    "dohc_create_incoming_webhook",
  ];
  const names = async (level?: "view" | "comment" | "edit") =>
    (await advertisedCapabilityTools(level)).map((tool) => tool.name);
  expect(await names()).toEqual(expect.arrayContaining(setup));
  for (const level of ["view", "comment", "edit"] as const)
    expect((await names(level)).filter((name) => setup.includes(name))).toEqual([]);
});
