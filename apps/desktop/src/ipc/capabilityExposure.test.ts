import { CLI_CAPABILITIES, cliRequestSchema } from "@dohc/cli/protocol";
import { CLI_COMMANDS } from "@dohc/cli/args";
import { CAPABILITIES } from "@dohc/workspace-contracts/capabilities";
import { renderCliHelp } from "../../../../packages/cli/src/help";
import { advertisedCapabilityTools as advertisedTools } from "../../../../packages/mcp/src/capabilityExposure.fixture";
import { describe, expect, it } from "vitest";
import * as contract from "./bridgeContract";
import { CHANNELS } from "./channels";
import type { OperationDefinition } from "./operationTable";

function operationRows(value: unknown): OperationDefinition[] {
  if (!value || typeof value !== "object") return [];
  const rows = Object.values(value);
  return rows.length && rows.every(row => row && typeof row === "object" && "channel" in row && "payload" in row && "guard" in row)
    ? rows as OperationDefinition[] : [];
}
const rows = Object.values(contract).flatMap(operationRows);
const publicVerbs = Object.entries(CLI_COMMANDS).flatMap(([group, command]) => Object.keys(command.verbs).map(verb => `${group} ${verb}`));
const socketVerbs = cliRequestSchema.options.map(option => option.shape.verb.value).sort();
const mainInternalVerbs = ["fileChats", "chat", "groupsFull", "collectionQuery", "collectionRecord", "collectionSetFields", "collectionCreateRecord", "fileWrite", "fileMove", "fileDelete", "keptCopies", "saveKeptCopy", "fileChatStart"];

describe("B1 main inventories (a4be19d5b)", () => {
  it("preserves every IPC wire name and the 26 enforced table guards", () => {
    expect(rows).toHaveLength(26);
    expect([...Object.values(CHANNELS), ...rows.map(row => row.channel)].sort()).toMatchSnapshot("IPC names");
    expect(Object.fromEntries(rows.map(row => [row.channel, row.guard]).sort(([a],[b]) => a.localeCompare(b)))).toMatchSnapshot("table guards");
  });
  it("preserves socket verbs, public verbs, and all public help", () => {
    expect(socketVerbs).toMatchSnapshot("socket verbs");
    expect(socketVerbs.filter(verb => mainInternalVerbs.includes(verb))).toMatchSnapshot("internal verbs");
    expect(socketVerbs.filter(verb => !mainInternalVerbs.includes(verb))).toMatchSnapshot("public socket verbs");
    expect(publicVerbs).toMatchSnapshot("public verbs");
    const help: Record<string,string> = { top: renderCliHelp({ help: [] }) };
    for (const [group, command] of Object.entries(CLI_COMMANDS)) {
      help[group] = renderCliHelp({ help: [group] });
      for (const verb of Object.keys(command.verbs)) help[`${group} ${verb}`] = renderCliHelp({ help: [group,verb] });
    }
    expect(help).toMatchSnapshot("help");
  });
  it.each([undefined, "view", "comment", "edit"] as const)("preserves MCP tools for %s", async level => {
    expect((await advertisedTools(level)).map(tool => tool.name)).toMatchSnapshot();
  });
});

describe("capability identities and exposure", () => {
  it("matches each door's declared exposure to its actual rows, verbs, help, and advertised tools", async () => {
    const entries = Object.entries(CAPABILITIES);
    const sorted = (values: readonly (readonly string[])[]) => values.map(value => value.join(":" )).sort();
    const tableEntries = Object.values(contract).filter(value => operationRows(value).length);
    const actualIpc = tableEntries.flatMap(table => Object.entries(table).map(([name, row]) => [name, (row as OperationDefinition).capabilityId]));
    expect(sorted(actualIpc)).toEqual(sorted(entries.flatMap(([id, meta]) => meta.ipc.operations.map(name => [name, id]))));
    for (const row of rows) {
      expect(["device", "workspace"]).toContain(row.scope);
      if (row.guard === "active-workspace") expect(row.scope).toBe("workspace");
      if (row.scope === "workspace" && row.guard === "trusted-sender") {
        expect(row.handlerCheck?.check).toBeTruthy();
        expect(row.handlerCheck?.reason).toBeTruthy();
      }
    }
    expect(Object.keys(CLI_CAPABILITIES).sort()).toEqual(socketVerbs);
    expect(sorted(Object.entries(CLI_CAPABILITIES).flatMap(([verb, ids]) => ids.map(id => [verb, id]))))
      .toEqual(sorted(entries.flatMap(([id, meta]) => meta.cli.socket.map(verb => [verb, id]))));
    const actualPublic = Object.entries(CLI_COMMANDS).flatMap(([group, command]) => Object.entries(command.verbs).map(([name, verb]) => [`${group} ${name}`, verb.capabilityId]));
    expect(sorted(actualPublic)).toEqual(sorted(entries.flatMap(([id, meta]) => meta.cli.public.map(verb => [verb, id]))));
    expect(actualPublic.map(([verb]) => verb)).toEqual(publicVerbs);
    for (const level of ["owner", "view", "comment", "edit"] as const) {
      const tools = await advertisedTools(level === "owner" ? undefined : level);
      const tagged = tools.flatMap(tool => {
        const ids = tool._meta?.["dohc/capabilityIds"];
        expect(Array.isArray(ids), tool.name).toBe(true);
        return (ids as string[]).map(id => [tool.name, id]);
      });
      expect(sorted(tagged)).toEqual(sorted(entries.flatMap(([id, meta]) => meta.mcp[level].map(tool => [tool, id]))));
    }
    for (const [, meta] of entries) {
      expect(meta.description).toBeTruthy();
      for (const door of [meta.ipc, meta.cli, meta.mcp]) expect(door.reason).toBeTruthy();
    }
  });
});
