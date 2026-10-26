// A PR that adds a channel or command edits the main inventory directly. Do not add a delta file.
import { APP_PUBLICATION_CAPABILITIES, CLI_CAPABILITIES, cliRequestSchema } from "@dohc/cli/protocol";
import { CLI_COMMANDS, parseCliArguments } from "@dohc/cli/args";
import { DATASET_CAPABILITIES, DatasetRequest, DatasetResult } from "@dohc/cli/dataset";
import { OwnerAppPublicationRequest } from "@dohc/cli/app-publication";
import { renderCliHelp } from "@dohc/cli/help";
import { advertisedCapabilityTools as advertisedTools } from "@dohc/mcp/capability-exposure-fixture";
import { MCP_TOOL_CAPABILITIES } from "@dohc/mcp/tools";
import { CAPABILITIES } from "@dohc/workspace-contracts/capabilities";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CHANNELS } from "./channels";
import { SetAppPinnedPayload } from "./bridgeContract";
import type { OperationDefinition } from "./operationTable";
import { OPERATION_TABLES } from "./operationTables";
import mainIpc from "./ipcExposure.main.json";
import mainCli from "./cliExposure.main.json";
import pinnedCliCapabilities from "./cliCapabilities.pinned.json";
import { CLI_DISPATCH_ARGUMENTS } from "./cliDispatchInputs.fixture";
import admission from "./operationAdmission.json";

const rows: OperationDefinition[] = OPERATION_TABLES.flatMap(table => Object.values(table));
const publicVerbs = Object.entries(CLI_COMMANDS).flatMap(([group, command]) => Object.keys(command.verbs).map(verb => `${group} ${verb}`));
const socketVerbs = cliRequestSchema.options.map(option => option.shape.verb.value).sort();

function carriesWorkspaceId(payload: z.core.$ZodType): boolean {
  if (payload instanceof z.ZodVoid) return false;
  if (payload instanceof z.ZodObject) return "workspaceId" in payload.shape;
  if (payload instanceof z.ZodUnion) return payload.options.map(carriesWorkspaceId).some(Boolean);
  if (payload instanceof z.ZodPipe) return carriesWorkspaceId(payload.in);
  if (payload instanceof z.ZodIntersection) return [payload.def.left, payload.def.right].map(carriesWorkspaceId).some(Boolean);
  throw new Error(`Unhandled operation payload schema "${payload._zod.def.type}". Handle it explicitly in carriesWorkspaceId.`);
}

function assertAdmission(row: Pick<OperationDefinition, "channel" | "guard" | "scope" | "payload"> & {
  readonly handlerCheck?: { readonly check: string; readonly reason: string };
}) {
  // The selector chooses a pin in the device's user settings, not workspace access.
  if (row.channel === "desktop:set-app-pinned") {
    expect(row.payload).toBe(SetAppPinnedPayload);
    expect(row.scope).toBe("device");
    expect(row.guard).toBe("trusted-sender");
    return;
  }
  const workspacePayload = carriesWorkspaceId(row.payload);
  expect(["device", "workspace"]).toContain(row.scope);
  if (row.guard === "active-workspace" || workspacePayload) expect(row.scope, row.channel).toBe("workspace");
  if (row.guard === "trusted-sender" && (row.scope === "workspace" || workspacePayload)) {
    expect(row.handlerCheck?.check, row.channel).toBeTruthy();
    expect(row.handlerCheck?.reason, row.channel).toBeTruthy();
  }
}

describe("main inventories", () => {
  it("preserves every IPC wire name and the enforced table guards", () => {
    expect([...Object.values(CHANNELS), ...rows.map(row => row.channel)].sort()).toEqual([...mainIpc.names].sort());
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
  it("records the 14 settings operations", () => {
    const channels = [
      "get-user-settings", "reload-user-settings", "set-user-settings", "set-app-pinned", "set-agent-color",
      "reset-user-settings", "get-user-settings-file-path", "open-user-settings-file",
      "open-workspace-settings-file", "get-workspace-settings", "set-workspace-settings",
      "reset-workspace-settings", "get-workspace-ui-state", "set-workspace-ui-state",
    ].map(name => `desktop:${name}`);
    expect(rows.filter(row => channels.includes(row.channel))).toHaveLength(14);
  });
  it("records all 23 chat operations with their sender-workspace admission", () => {
    const channels = [
      "list-file-chats", "chat-file-mentions-page", "chat-links", "list-chat-bookmarks", "save-chat-bookmark",
      "archive-chat-bookmark", "create-file-chat", "list-chat-messages", "get-chat-thread-revision",
      "send-chat-message", "list-chat-thread-decisions", "list-chat-thread-attachments",
      "list-chat-channels", "list-chat-follows", "set-chat-follow", "list-personal-chat-feed",
      "mark-personal-chat-feed-seen", "create-chat-channel", "list-channel-threads", "start-channel-thread",
      "mark-chat-thread-read", "list-chat-reactions", "set-chat-reaction",
    ].map(name => `desktop:${name}`);
    const chatRows = rows.filter(row => channels.includes(row.channel));
    expect(chatRows.map(row => row.channel).sort()).toEqual(channels.sort());
    for (const row of chatRows) {
      const chatRefusal = [
        "desktop:list-chat-channels", "desktop:chat-file-mentions-page", "desktop:chat-links", "desktop:list-chat-messages",
        "desktop:send-chat-message", "desktop:list-personal-chat-feed", "desktop:list-channel-threads",
        "desktop:start-channel-thread",
      ].includes(row.channel);
      expect(row, row.channel).toMatchObject({
        guard: "active-workspace", scope: "workspace",
        inactiveMessage: chatRefusal
          ? "Chats stopped because this window changed workspaces."
          : "This workspace is no longer active.",
      });
    }
  });
  it("records the eight small share operations with their existing admission", () => {
    const deviceChannels = [
      "get-share-handoff-status", "accept-share-handoff", "retry-share-handoff",
      "dismiss-share-handoff", "open-shared-view",
    ].map(name => `desktop:${name}`);
    const mountChannels = ["mount-share", "refresh-share-mounts", "unmount-share"]
      .map(name => `desktop:${name}`);
    const channels = [...deviceChannels, ...mountChannels];
    const shareRows = rows.filter(row => channels.includes(row.channel));
    expect(shareRows.map(row => row.channel).sort()).toEqual(channels.sort());
    for (const row of shareRows) {
      expect(row, row.channel).toMatchObject(mountChannels.includes(row.channel) ? {
        guard: "active-workspace", scope: "workspace",
        inactiveMessage: "Share update stopped because this window changed workspaces.",
      } : { guard: "trusted-sender", scope: "device" });
      expect(row).not.toHaveProperty("handlerCheck");
    }
  });
  it("records the 14 proposal and Group operations with their existing admission", () => {
    const messages = {
      "desktop:list-share-proposals": "Share changes stopped because this window changed workspaces.",
      "desktop:read-share-proposal-changes": "Share changes stopped because this window changed workspaces.",
      "desktop:read-share-proposal-file-content": "Share changes stopped because this window changed workspaces.",
      "desktop:settle-share-proposal": "Share changes stopped because this window changed workspaces.",
      "desktop:submit-share-changes": "Share changes stopped because this window changed workspaces.",
      "desktop:push-share-direct-writes": "Share changes stopped because this window changed workspaces.",
      "desktop:list-my-share-changes": "Share changes stopped because this window changed workspaces.",
      "desktop:withdraw-share-changes": "Share changes stopped because this window changed workspaces.",
      "desktop:share-chat-channel": "Sharing stopped because this window changed workspaces.",
      "desktop:list-joined-shared-channels": "Sharing stopped because this window changed workspaces.",
      "desktop:list-chat-channel-shares": "Sharing stopped because this window changed workspaces.",
      "desktop:join-shared-channel": "Joining stopped because this window changed workspaces.",
      "desktop:leave-shared-channel": "Leaving stopped because this window changed workspaces.",
      "desktop:dismiss-share-skips": "Share warning update stopped because this window changed workspaces.",
    };
    const channels = Object.keys(messages);
    const shareRows = rows.filter(row => channels.includes(row.channel));
    expect(shareRows.map(row => row.channel).sort()).toEqual(channels.sort());
    for (const row of shareRows) {
      expect(row, row.channel).toMatchObject({
        guard: "active-workspace", scope: "workspace",
        inactiveMessage: messages[row.channel as keyof typeof messages],
      });
      expect(row).not.toHaveProperty("handlerCheck");
    }
  });
  it("records the 19 owner relay operations with their existing admission", () => {
    const channels = [
      "desktop:list-owner-live-documents",
      "desktop:list-owner-live-refusals",
      "desktop:retry-owner-live-share",
      "desktop:create-relay-share",
      "desktop:create-relay-share-link",
      "desktop:add-relay-share-link",
      "desktop:list-relay-share-links",
      "desktop:retune-relay-share-link",
      "desktop:rotate-relay-share-link",
      "desktop:revoke-relay-share-link",
      "desktop:list-relay-share-discussion",
      "desktop:append-relay-share-discussion",
      "desktop:delete-relay-share-discussion-message",
      "desktop:block-relay-share-discussion-principal",
      "desktop:unblock-relay-share-discussion-principal",
      "desktop:pause-relay-share-discussion",
      "desktop:resume-relay-share-discussion",
      "desktop:promote-relay-share-grant",
      "desktop:revoke-relay-share-grant"
    ];
    const ownerRows = rows.filter(row => channels.includes(row.channel));
    expect(ownerRows.map(row => row.channel)).toEqual(channels);
    for (const row of ownerRows) {
      expect(row, row.channel).toMatchObject({
        guard: "active-workspace", scope: "workspace",
        inactiveMessage: "Sharing stopped because this window changed workspaces.",
      });
      expect(row).not.toHaveProperty("handlerCheck");
    }
  });
  it("records the nine remaining relay operation rows with their existing admission", () => {
    const workspaceChannels = ["owner-restore", "stop-owner-live-document", "resume-owner-live-document", "poll-relay-share-discussion-activity"]
      .map(name => `desktop:${name}`);
    const deviceChannels = ["list-relay-shares", "get-relay-received-share", "revoke-relay-share", "undo-relay-share", "cancel-relay-share-discussion-activity"]
      .map(name => `desktop:${name}`);
    const channels = [...workspaceChannels, ...deviceChannels];
    const migrated = rows.filter(row => channels.includes(row.channel));
    expect(migrated.map(row => row.channel).sort()).toEqual(channels.sort());
    for (const row of migrated) {
      if (workspaceChannels.includes(row.channel)) {
        expect(row, row.channel).toMatchObject({
          guard: "active-workspace", scope: "workspace",
          inactiveMessage: ["desktop:stop-owner-live-document", "desktop:resume-owner-live-document"].includes(row.channel)
            ? "Live editing stopped because this window changed workspaces."
            : "Sharing stopped because this window changed workspaces.",
        });
      } else {
        expect(row, row.channel).toMatchObject({ guard: "trusted-sender", scope: "device" });
        expect(row).not.toHaveProperty("inactiveMessage");
      }
      expect(row).not.toHaveProperty("handlerCheck");
    }
  });
  it("preserves socket verbs, public verbs, and all public help", () => {
    expect(socketVerbs).toEqual(mainCli.socketVerbs);
    expect(Object.keys(CLI_COMMANDS)).toEqual(mainCli.publicGroups);
    expect(publicVerbs).toEqual(mainCli.publicVerbs);
    const help: Record<string, string> = { top: renderCliHelp({ help: [] }) };
    for (const [group, command] of Object.entries(CLI_COMMANDS)) {
      help[group] = renderCliHelp({ help: [group] });
      for (const verb of Object.keys(command.verbs)) help[`${group} ${verb}`] = renderCliHelp({ help: [group, verb] });
    }
    const top = mainCli.help.top;
    expect(top.commands.map(command => command.group)).toEqual(Object.keys(CLI_COMMANDS));
    const expectedHelp = { ...mainCli.help, top: `${top.prefix}${top.commands.map(command => command.block).join("")}${top.suffix}` };
    expect(help).toEqual(expectedHelp);
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
    ["void", z.void(), false],
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

  it("records the multiplexed dataset operation with its existing admission", () => {
    const datasetRows = rows.filter(row => row.channel === "desktop:dataset");
    expect(datasetRows).toHaveLength(1);
    const row = datasetRows[0]!;
    expect(row).toMatchObject({
      capabilityIdsByAction: DATASET_CAPABILITIES, payload: DatasetRequest,
      guard: "trusted-sender", scope: "workspace",
      handlerCheck: { check: "datasetHandler.withRendererWorkspaceOperation" },
    });
    expect(row).not.toHaveProperty("capabilityId");
    expect(row).not.toHaveProperty("inactiveMessage");
    expect(row.capabilityIdsByAction).toBe(DATASET_CAPABILITIES);
    expect(row.payload).toBe(DatasetRequest);
    expect(row.result).toBe(DatasetResult);
    expect(Object.keys(row.capabilityIdsByAction!).sort()).toEqual(DatasetRequest.options.map(option => option.shape.action.value).sort());
    expect(Object.values(row.capabilityIdsByAction!)).toHaveLength(34);
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
    const publicSocketVerbs = new Set(mainCli.publicSocketVerbs);
    const internalVerbs = socketVerbs.filter(verb => !publicSocketVerbs.has(verb));
    expect(internalVerbs).toEqual(mainCli.internalVerbs);
  });

  it("matches IPC and MCP exposure to their actual rows and advertised tools", async () => {
    const entries = Object.entries(CAPABILITIES);
    const sorted = (values: readonly (readonly string[])[]) => values.map(value => value.join(":")).sort();
    const actualIpc = OPERATION_TABLES.flatMap(table => Object.entries<OperationDefinition>(table).flatMap(([name, row]) =>
      (row.capabilityId ? [row.capabilityId] : Object.values(row.capabilityIdsByAction)).map(id => [name, id])));
    const expectedIpc = entries.flatMap(([id, meta]) => meta.ipc.operations.map(name => [name, id]));
    expect(sorted(actualIpc)).toEqual(sorted(expectedIpc));
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
