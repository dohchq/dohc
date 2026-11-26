import {
  MemberAppInspectInput,
  MemberAppInspectResult,
  MemberAppsListInput,
  MemberAppsListResult,
} from "./memberApps";
import { CURSOR_FLAG, EVERY_MCP_LEVEL, type OperationFamily } from "./operationDeclaration";

const unavailable = "Workspace apps are unavailable in this workspace.";

export const MEMBER_APPS_DECLARATIONS = {
  memberAppsList: {
    access: "read",
    capabilityId: "app.member.list",
    input: MemberAppsListInput,
    result: MemberAppsListResult,
    ipc: {
      channel: "desktop:member-apps-list",
      inactiveMessage: "Workspace apps stopped loading because this window changed workspaces.",
    },
    cli: {
      verb: "memberAppsList",
      command: ["member-apps", "list"],
      summary: "List the workspace's official apps, then the apps members shared.",
      operands: "",
      flags: [CURSOR_FLAG],
      unavailable,
      example: [],
    },
    mcp: {
      tool: "dohc_list_member_apps",
      levels: EVERY_MCP_LEVEL,
      description:
        "List the apps you can open in this workspace: official apps its owner published (kind workspace), then apps members shared (kind member). Continue with nextCursor until it is null; a page can be empty and still have a next page. url opens the app in a browser. consent says whether the person you work for allowed a Member app: none, current, or changed (allowed an earlier version). Only that person can allow a Member app, in their browser. membersCanShare, on the first page, says whether members may share apps.",
    },
  },
  memberAppInspect: {
    access: "read",
    capabilityId: "app.member.inspect",
    input: MemberAppInspectInput,
    result: MemberAppInspectResult,
    ipc: {
      channel: "desktop:member-app-inspect",
      inactiveMessage: "App review stopped because this window changed workspaces.",
    },
    cli: {
      verb: "memberAppInspect",
      command: ["member-apps", "inspect"],
      summary: "Show a Member app's author, Collection access, and source files.",
      operands: "<app-id>",
      unavailable,
      example: ["0".repeat(64)],
    },
    mcp: {
      tool: "dohc_inspect_member_app",
      levels: EVERY_MCP_LEVEL,
      description:
        "Show what a Member app can do before anyone allows it: its author, each Collection with the access and actions it uses (readOnly false changes data), and its source files. dohc_fork_member_app copies the source into a Personal app.",
    },
  },
} as const satisfies OperationFamily;
