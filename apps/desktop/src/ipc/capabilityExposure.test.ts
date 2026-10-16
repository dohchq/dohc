import { APP_PUBLICATION_CAPABILITIES, CLI_CAPABILITIES, cliRequestSchema, DATASET_CAPABILITIES } from "@dohc/cli/protocol";
import { CLI_COMMANDS, parseCliArguments } from "@dohc/cli/args";
import { DatasetRequest } from "@dohc/cli/dataset";
import { OwnerAppPublicationRequest } from "@dohc/cli/app-publication";
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
import clipboardIpc from "./ipcExposure.pr1639.json";
import recipientRecordsIpc from "./ipcExposure.pr1688.json";
import launchOpenIpc from "./ipcExposure.pr1701.json";
import restartCaptureIpc from "./ipcExposure.pr1719.json";
import earlyQuitIpc from "./ipcExposure.earlyQuit.json";
import historyTimelineIpc from "./ipcExposure.historyTimeline.json";
import historyNamesIpc from "./ipcExposure.pr1785.json";
import liveDraftRecoveryIpc from "./ipcExposure.pr1747.json";
import liveDraftListingIpc from "./ipcExposure.liveDraftListing.json";
import stopAndRestoreIpc from "./ipcExposure.stopAndRestore.json";
import reportsIpc from "./ipcExposure.reports.json";
import saveRetryIpc from "./ipcExposure.saveRetry.json";
import fileObservationIpc from "./ipcExposure.fileObservation.json";
import usageRecordIpc from "./ipcExposure.usageRecord.json";
import shareCopyCli from "./cliExposure.shareCopy.json";
import mainCli from "./cliExposure.main.json";
import pinnedCliCapabilities from "./cliCapabilities.pinned.json";
import { CLI_DISPATCH_ARGUMENTS } from "./cliDispatchInputs.fixture";
import publicationCli from "./cliExposure.pr1659.json";
import commentsCli from "./cliExposure.pr1700.json";
import fileChatsCli from "./cliExposure.pr2000.json";
import accountDeletion from "./cliExposure.accountDeletion.json";
import admission from "./operationAdmission.json";
import accessExposure from "./accessExposure.delta.json";
import shareCopyExposure from "./ipcExposure.shareCopy.json";
import offersIpc from "./ipcExposure.offers.json";
import sharedWriteFeedback from "./ipcExposure.sharedWriteFeedback.json";
import systemMotionIpc from "./ipcExposure.systemMotion.json";
import captureHoldsIpc from "./ipcExposure.captureHolds.json";
import agentRunStateIpc from "./ipcExposure.agentRunState.json";

const rows: OperationDefinition[] = OPERATION_TABLES.flatMap(table => Object.values(table));
const publicVerbs = Object.entries(CLI_COMMANDS).flatMap(([group, command]) => Object.keys(command.verbs).map(verb => `${group} ${verb}`));
const socketVerbs = cliRequestSchema.options.map(option => option.shape.verb.value).sort();

function carriesWorkspaceId(payload: z.core.$ZodType): boolean {
  if (payload instanceof z.ZodObject) return "workspaceId" in payload.shape;
  if (payload instanceof z.ZodUnion) return payload.options.map(carriesWorkspaceId).some(Boolean);
  if (payload instanceof z.ZodPipe) return carriesWorkspaceId(payload.in);
  if (payload instanceof z.ZodIntersection) return [payload.def.left, payload.def.right].map(carriesWorkspaceId).some(Boolean);
  throw new Error(`Unhandled operation payload schema "${payload._zod.def.type}". Handle it explicitly in carriesWorkspaceId.`);
}

function assertAdmission(row: Pick<OperationDefinition, "channel" | "guard" | "scope" | "payload"> & {
  readonly handlerCheck?: { readonly check: string; readonly reason: string };
}) {
  const workspacePayload = carriesWorkspaceId(row.payload);
  expect(["device", "workspace"]).toContain(row.scope);
  if (row.guard === "active-workspace" || workspacePayload) expect(row.scope, row.channel).toBe("workspace");
  if (row.guard === "trusted-sender" && (row.scope === "workspace" || workspacePayload)) {
    expect(row.handlerCheck?.check, row.channel).toBeTruthy();
    expect(row.handlerCheck?.reason, row.channel).toBeTruthy();
  }
}

describe("B1 main inventories (a4be19d5b)", () => {
  it("preserves every IPC wire name and the 26 enforced table guards", () => {
    // Hand-reviewed #1639 removals and #1701, #1688, #1747, reports, save retry,
    // capture recovery, History names, shared write feedback, Stop and restore,
    // usage record, share copy, early-quit typing recovery, offer, system motion, account
    // deletion and agent run state additions, separate from the hashed main baseline.
    const expectedNames = [...mainIpc.names];
    expectedNames.push("desktop:check-shared-view-access");
    expectedNames.push("desktop:dismiss-share-capture-notice");
    for (const name of clipboardIpc.nameRemovals) {
      expect(expectedNames).toContain(name);
      expectedNames.splice(expectedNames.indexOf(name), 1);
    }
    for (const name of [...launchOpenIpc.nameAdditions, ...recipientRecordsIpc.nameAdditions, ...liveDraftRecoveryIpc.nameAdditions, ...liveDraftListingIpc.nameAdditions, ...restartCaptureIpc.nameAdditions, ...historyNamesIpc.nameAdditions, ...historyTimelineIpc.nameAdditions, ...reportsIpc.nameAdditions, ...saveRetryIpc.nameAdditions, ...accessExposure.nameAdditions, ...sharedWriteFeedback.nameAdditions, ...fileObservationIpc.nameAdditions, ...stopAndRestoreIpc.nameAdditions, ...usageRecordIpc.nameAdditions, ...shareCopyExposure.nameAdditions, ...earlyQuitIpc.nameAdditions, ...offersIpc.nameAdditions, ...systemMotionIpc.nameAdditions, ...captureHoldsIpc.nameAdditions, ...accountDeletion.nameAdditions, ...agentRunStateIpc.nameAdditions]) {
      expect(expectedNames).not.toContain(name);
      expectedNames.push(name);
    }
    expect([...Object.values(CHANNELS), ...rows.map(row => row.channel)].sort()).toEqual(expectedNames.sort());
    // B5 retains these guards while adding rows to the hand-edited admission record.
    const guards = Object.fromEntries(rows.map(row => [row.channel, row.guard]));
    expect(Object.fromEntries(Object.keys(mainIpc.guards).map(channel => [channel, guards[channel]]))).toEqual(mainIpc.guards);
  });
  it("records the 13 migrated file operations", () => {
    const channels = [
      "list-workspace-files", "create-workspace-file", "create-workspace-folder",
      "move-workspace-path", "delete-workspace-path", "export-workspace-zip",
      "export-document-file", "import-workspace-files", "read-workspace-text",
      "write-workspace-text", "write-workspace-asset", "pick-image-files", "open-file-externally",
    ].map(name => `desktop:${name}`);
    expect(rows.filter(row => channels.includes(row.channel))).toHaveLength(13);
  });
  it("preserves socket verbs, public verbs, and all public help", () => {
    expect(socketVerbs).toEqual([...mainCli.socketVerbs, ...accessExposure.socketVerbAdditions, ...shareCopyCli.socketVerbAdditions, ...accountDeletion.socketVerbAdditions].sort());
    const expectedGroups = [...accessExposure.publicGroupAdditions, ...mainCli.publicGroups];
    for (const { group, before } of shareCopyCli.publicGroupAdditions) {
      expect(expectedGroups).not.toContain(group);
      expect(expectedGroups).toContain(before);
      expectedGroups.splice(expectedGroups.indexOf(before), 0, group);
    }
    expect(Object.keys(CLI_COMMANDS)).toEqual([...expectedGroups, ...accountDeletion.publicGroupAdditions]);
    // Hand-reviewed #1659 additions, separate from the hashed main baseline.
    const expectedPublicVerbs = [...accessExposure.publicVerbAdditions, ...mainCli.publicVerbs, ...accountDeletion.publicVerbAdditions];
    for (const { verb, before } of [...publicationCli.publicVerbAdditions, ...commentsCli.publicVerbAdditions, ...fileChatsCli.publicVerbAdditions, ...shareCopyCli.publicVerbAdditions]) {
      expect(expectedPublicVerbs).not.toContain(verb);
      expect(expectedPublicVerbs).toContain(before);
      expectedPublicVerbs.splice(expectedPublicVerbs.indexOf(before), 0, verb);
    }
    expect(publicVerbs).toEqual(expectedPublicVerbs);
    const help: Record<string, string> = { top: renderCliHelp({ help: [] }) };
    for (const [group, command] of Object.entries(CLI_COMMANDS)) {
      help[group] = renderCliHelp({ help: [group] });
      for (const verb of Object.keys(command.verbs)) help[`${group} ${verb}`] = renderCliHelp({ help: [group, verb] });
    }
    expect(help).toEqual({ ...mainCli.help, ...publicationCli.help, ...commentsCli.help, ...accessExposure.help, ...shareCopyCli.help, ...fileChatsCli.help, ...accountDeletion.help });
  });
  it("pins each row's guard, scope, and handler check to the hand-edited admission record", () => {
    expect(Object.fromEntries(rows.map(row => [row.channel, {
      guard: row.guard, scope: row.scope, handlerCheck: "handlerCheck" in row ? { check: row.handlerCheck.check } : null,
    }]))).toEqual(admission);
  });
});

describe("capability identities and exposure", () => {
  const workspacePayload = z.object({ workspaceId: z.string() });
  const devicePayload = z.object({});
  it.each([
    ["pipe input", workspacePayload.pipe(workspacePayload), true],
    ["transform input", workspacePayload.transform(() => ({})), true],
    ["transform output only", devicePayload.transform(() => ({ workspaceId: "output-only" })), false],
    ["intersection left", z.intersection(workspacePayload, devicePayload), true],
    ["intersection right", z.intersection(devicePayload, workspacePayload), true],
    ["device intersection", z.intersection(devicePayload, devicePayload), false],
    ["union", z.union([devicePayload, workspacePayload]), true],
  ] as const)("inspects the %s for a workspace selector", (_name, payload, expected) => {
    expect(carriesWorkspaceId(payload)).toBe(expected);
    if (expected) expect(() => assertAdmission({
      channel: "desktop:wrapped-repro", guard: "trusted-sender", scope: "device", payload,
    })).toThrow("workspace");
  });

  it.each([
    ["lazy", z.lazy(() => workspacePayload)],
    ["array", z.array(workspacePayload)],
    ["optional", workspacePayload.optional()],
    ["transform before parsing", z.preprocess(value => value, workspacePayload)],
    ["union with an unknown sibling", z.union([workspacePayload, z.lazy(() => devicePayload)])],
    ["intersection with an unknown sibling", z.intersection(workspacePayload, z.lazy(() => devicePayload))],
  ] as const)("rejects the unhandled %s payload instead of skipping the pin", (_name, payload) => {
    expect(() => carriesWorkspaceId(payload)).toThrow("Unhandled operation payload schema");
    expect(() => assertAdmission({
      channel: "desktop:unknown-repro", guard: "active-workspace", scope: "workspace", payload,
    })).toThrow("Unhandled operation payload schema");
  });

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

  it("tags every publication action offered by #1659 without replacing approval ids", () => {
    expect(Object.keys(APP_PUBLICATION_CAPABILITIES).sort())
      .toEqual(OwnerAppPublicationRequest.options.map(option => option.shape.action.value).sort());
    expect(MCP_TOOL_CAPABILITIES.dohc_publish_app).toEqual(Object.values(APP_PUBLICATION_CAPABILITIES));
    expect(APP_PUBLICATION_CAPABILITIES.createLink).toBe("app.link.create");
    expect(APP_PUBLICATION_CAPABILITIES.approve).toBe("app.publication.approve");
    expect(DATASET_CAPABILITIES.approve).toBe("dataset.approve");
    expect(DATASET_CAPABILITIES.approveMigration).toBe("dataset.migration.approve");
  });

  it("pins every socket verb's capability ids", () => {
    expect(Object.keys(CLI_CAPABILITIES).sort()).toEqual(socketVerbs);
    expect(CLI_CAPABILITIES).toEqual(pinnedCliCapabilities.socket);
    for (const [verb, ids] of Object.entries(CLI_CAPABILITIES)) expect(ids.length, verb).toBeGreaterThan(0);
  });

  it("pins every public verb's capability id", () => {
    const ids = Object.fromEntries(Object.entries(CLI_COMMANDS).flatMap(([group, command]) =>
      Object.entries(command.verbs).map(([name, verb]) => [`${group} ${name}`, verb.capabilityId])));
    expect(ids).toEqual(pinnedCliCapabilities.public);
  });

  it("uses a public verb's capability among its parser's socket capabilities", () => {
    expect(Object.keys(CLI_DISPATCH_ARGUMENTS).sort()).toEqual([...publicVerbs].sort());
    for (const [group, command] of Object.entries(CLI_COMMANDS)) {
      for (const [name, verb] of Object.entries(command.verbs)) {
        const label = `${group} ${name}`;
        const parsed = parseCliArguments([group, name, ...CLI_DISPATCH_ARGUMENTS[label]!], {});
        if ("help" in parsed) throw new Error(`Expected socket dispatch for ${label}.`);
        expect(CLI_CAPABILITIES[parsed.verb], label).toContain(verb.capabilityId);
      }
    }
  });

  it("exposes document chats as the existing file-chat list capability", () => {
    expect(CLI_COMMANDS.document!.verbs.chats?.capabilityId).toBe("file.chats.list");
    expect(parseCliArguments(["document", "chats", "Notes/a.md"], {}))
      .toMatchObject({ verb: "fileChats", path: "Notes/a.md" });
    expect(CLI_CAPABILITIES.fileChats).toEqual(["file.chats.list"]);
    expect(pinnedCliCapabilities.public).toHaveProperty("document chats", "file.chats.list");
  });

  it("pins every internal-only socket verb in the main CLI inventory", () => {
    const publicSocketVerbs = new Set([...mainCli.publicSocketVerbs, ...commentsCli.publicSocketPromotions, ...fileChatsCli.publicSocketPromotions, ...accessExposure.socketVerbAdditions, ...shareCopyCli.socketVerbAdditions, ...accountDeletion.socketVerbAdditions]);
    const internalVerbs = socketVerbs.filter(verb => !publicSocketVerbs.has(verb));
    expect(internalVerbs).toEqual(mainCli.internalVerbs.filter(verb => ![...commentsCli.publicSocketPromotions, ...fileChatsCli.publicSocketPromotions].includes(verb)));
  });

  it("matches IPC and MCP exposure to their actual rows and advertised tools", async () => {
    const entries = Object.entries(CAPABILITIES);
    const sorted = (values: readonly (readonly string[])[]) => values.map(value => value.join(":")).sort();
    const actualIpc = OPERATION_TABLES.flatMap(table => Object.entries<OperationDefinition>(table).flatMap(([name, row]) =>
      (row.capabilityId ? [row.capabilityId] : Object.values(row.capabilityIdsByAction)).map(id => [name, id])));
    expect(sorted(actualIpc)).toEqual(sorted(entries.flatMap(([id, meta]) => meta.ipc.operations.map(name => [name, id]))));
    for (const row of rows) assertAdmission(row);
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
      for (const door of [meta.ipc, meta.mcp]) expect(door.reason).toBeTruthy();
    }
  });
});
