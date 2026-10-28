import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it, vi } from "vitest";
import { advertisedCapabilityTools } from "./capabilityExposure.fixture";
import { createDohcMcpServer } from "./server";
import type { ToolContext } from "./tools";

const tools = ["dohc_list_versions", "dohc_compare_version", "dohc_list_version_conflicts"];

it("offers the version reads to the owner only and sends them as the agent", async () => {
  expect((await advertisedCapabilityTools(undefined)).map(tool => tool.name)).toEqual(expect.arrayContaining(tools));
  for (const shareAccess of ["view", "comment", "edit"] as const) {
    const names = (await advertisedCapabilityTools(shareAccess)).map(tool => tool.name);
    for (const tool of tools) expect(names).not.toContain(tool);
  }
  const request = vi.fn<NonNullable<ToolContext["request"]>>(async () => ({ ok: false, reason: "Versions belong to the owning workspace. Open it to continue." }));
  const server = createDohcMcpServer({ root: process.cwd(), home: process.cwd(), request });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await client.callTool({ name: "dohc_list_versions", arguments: {} });
    await client.callTool({ name: "dohc_compare_version", arguments: { version: "Draft", afterPath: "a.md" } });
    await client.callTool({ name: "dohc_list_version_conflicts", arguments: { afterConflictId: "c1" } });
  } finally {
    await client.close();
    await server.close();
  }
  expect(request.mock.calls.map(([sent]) => sent)).toEqual([
    expect.objectContaining({ verb: "versionList", args: expect.objectContaining({ actor: "agent" }) }),
    expect.objectContaining({ verb: "versionCompare", args: expect.objectContaining({ actor: "agent", version: "Draft", afterPath: "a.md" }) }),
    expect.objectContaining({ verb: "versionConflicts", args: expect.objectContaining({ actor: "agent", afterConflictId: "c1" }) }),
  ]);
});
