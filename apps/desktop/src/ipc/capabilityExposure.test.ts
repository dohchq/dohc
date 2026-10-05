import { CLI_CAPABILITIES, cliRequestSchema, DATASET_CAPABILITIES } from "@dohc/cli/protocol";
import { CLI_COMMANDS } from "@dohc/cli/args";
import { DatasetRequest } from "@dohc/cli/dataset";
import { renderCliHelp } from "@dohc/cli/help";
import { advertisedCapabilityTools as advertisedTools } from "@dohc/mcp/capability-exposure-fixture";
import { MCP_TOOL_CAPABILITIES } from "@dohc/mcp/tools";
import { CAPABILITIES } from "@dohc/workspace-contracts/capabilities";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CHANNELS } from "./channels";
import type { OperationDefinition } from "./operationTable";
import { OPERATION_TABLES } from "./operationTables";
import mainIpc from "./ipcExposure.main.json";
import mainCli from "./cliExposure.main.json";
import admission from "./operationAdmission.json";

const rows: OperationDefinition[] = OPERATION_TABLES.flatMap(table => Object.values(table));
const publicVerbs = Object.entries(CLI_COMMANDS).flatMap(([group, command]) => Object.keys(command.verbs).map(verb => `${group} ${verb}`));
const socketVerbs = cliRequestSchema.options.map(option => option.shape.verb.value).sort();

function carriesWorkspaceId(payload: z.core.$ZodType): boolean {
  if (payload instanceof z.ZodObject) return "workspaceId" in payload.shape;
  if (payload instanceof z.ZodUnion) return payload.options.some(option => carriesWorkspaceId(option));
  return false;
}

function assertAdmission(row: Pick<OperationDefinition, "channel" | "guard" | "scope" | "payload"> & {
  readonly handlerCheck?: { readonly check: string; readonly reason: string };
}) {
  expect(["device", "workspace"]).toContain(row.scope);
  if (row.guard === "active-workspace" || carriesWorkspaceId(row.payload)) expect(row.scope, row.channel).toBe("workspace");
  if (row.guard === "trusted-sender" && (row.scope === "workspace" || carriesWorkspaceId(row.payload))) {
    expect(row.handlerCheck?.check, row.channel).toBeTruthy();
    expect(row.handlerCheck?.reason, row.channel).toBeTruthy();
  }
}

describe("B1 main inventories (a4be19d5b)", () => {
  it("preserves every IPC wire name and the 26 enforced table guards", () => {
    expect([...Object.values(CHANNELS), ...rows.map(row => row.channel)].sort()).toEqual(mainIpc.names);
    // B5 retains these guards while adding rows to the hand-edited admission record.
    const guards = Object.fromEntries(rows.map(row => [row.channel, row.guard]));
    expect(Object.fromEntries(Object.keys(mainIpc.guards).map(channel => [channel, guards[channel]]))).toEqual(mainIpc.guards);
  });
  it("preserves socket verbs, public verbs, and all public help", () => {
    expect(socketVerbs).toEqual(mainCli.socketVerbs);
    expect(Object.keys(CLI_COMMANDS)).toEqual(mainCli.publicGroups);
    const internal = new Set(mainCli.internalVerbs);
    expect(socketVerbs.filter(verb => internal.has(verb))).toEqual(mainCli.internalVerbs);
    expect(socketVerbs.filter(verb => !internal.has(verb))).toEqual(mainCli.publicSocketVerbs);
    expect(publicVerbs).toEqual(mainCli.publicVerbs);
    const help: Record<string, string> = { top: renderCliHelp({ help: [] }) };
    for (const [group, command] of Object.entries(CLI_COMMANDS)) {
      help[group] = renderCliHelp({ help: [group] });
      for (const verb of Object.keys(command.verbs)) help[`${group} ${verb}`] = renderCliHelp({ help: [group, verb] });
    }
    expect(help).toEqual(mainCli.help);
  });
  it("pins each row's guard, scope, and handler check to the hand-edited admission record", () => {
    expect(Object.fromEntries(rows.map(row => [row.channel, {
      guard: row.guard, scope: row.scope, handlerCheck: "handlerCheck" in row ? { check: row.handlerCheck.check } : null,
    }]))).toEqual(admission);
  });
});

describe("capability identities and exposure", () => {
  it("rejects a trusted-sender row that disguises its workspace payload as device scope", () => {
    const repro = {
      capabilityId: "file.read", channel: "desktop:repro", guard: "trusted-sender", scope: "device",
      payload: z.object({ workspaceId: z.string() }),
    } as const satisfies OperationDefinition;
    expect(() => assertAdmission(repro)).toThrow();
    expect(() => assertAdmission({ ...repro, scope: "workspace" })).toThrow();
    expect(() => assertAdmission({ ...repro, scope: "workspace", handlerCheck: { check: "existingHandler.check", reason: "Existing lifetime check." } })).not.toThrow();
  });

  it("can tag all dataset actions on one operation row without changing its payload", () => {
    const row = {
      capabilityIdsByAction: DATASET_CAPABILITIES, channel: "desktop:dataset", payload: DatasetRequest,
      guard: "trusted-sender", scope: "workspace",
      handlerCheck: { check: "existingDatasetHandler.check", reason: "Test-only row for the B5 dataset map." },
    } as const satisfies OperationDefinition;
    expect(Object.keys(row.capabilityIdsByAction).sort()).toEqual(DatasetRequest.options.map(option => option.shape.action.value).sort());
    expect(Object.values(row.capabilityIdsByAction)).toHaveLength(34);
    assertAdmission(row);
  });

  it("matches each door's declared exposure to its actual rows, verbs, help, and advertised tools", async () => {
    const entries = Object.entries(CAPABILITIES);
    const sorted = (values: readonly (readonly string[])[]) => values.map(value => value.join(":")).sort();
    const actualIpc = OPERATION_TABLES.flatMap(table => Object.entries<OperationDefinition>(table).flatMap(([name, row]) =>
      (row.capabilityId ? [row.capabilityId] : Object.values(row.capabilityIdsByAction)).map(id => [name, id])));
    expect(sorted(actualIpc)).toEqual(sorted(entries.flatMap(([id, meta]) => meta.ipc.operations.map(name => [name, id]))));
    for (const row of rows) assertAdmission(row);
    expect(Object.keys(CLI_CAPABILITIES).sort()).toEqual(socketVerbs);
    expect(sorted(Object.entries(CLI_CAPABILITIES).flatMap(([verb, ids]) => ids.map(id => [verb, id]))))
      .toEqual(sorted(entries.flatMap(([id, meta]) => meta.cli.socket.map(verb => [verb, id]))));
    const actualPublic = Object.entries(CLI_COMMANDS).flatMap(([group, command]) => Object.entries(command.verbs).map(([name, verb]) => [`${group} ${name}`, verb.capabilityId]));
    expect(sorted(actualPublic)).toEqual(sorted(entries.flatMap(([id, meta]) => meta.cli.public.map(verb => [verb, id]))));
    expect(actualPublic.map(([verb]) => verb)).toEqual(publicVerbs);
    const offeredTools = new Set<string>();
    for (const level of ["owner", "view", "comment", "edit"] as const) {
      const tools = await advertisedTools(level === "owner" ? undefined : level);
      const tagged = tools.flatMap(tool => {
        offeredTools.add(tool.name);
        const ids = (MCP_TOOL_CAPABILITIES as Readonly<Record<string, readonly string[]>>)[tool.name];
        expect(ids, tool.name).toBeDefined();
        return ids.map(id => [tool.name, id]);
      });
      expect(sorted(tagged)).toEqual(sorted(entries.flatMap(([id, meta]) => meta.mcp[level].map(tool => [tool, id]))));
    }
    expect(Object.keys(MCP_TOOL_CAPABILITIES).sort()).toEqual([...offeredTools].sort());
    for (const [, meta] of entries) {
      expect(meta.description).toBeTruthy();
      for (const door of [meta.ipc, meta.cli, meta.mcp]) expect(door.reason).toBeTruthy();
    }
  });
});
