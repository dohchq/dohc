import {
  MemberAppForkInput,
  MemberAppForkResult,
  MemberAppForkSocketResult,
  MemberAppShareInput,
  MemberAppShareResult,
  MemberAppShareSocketResult,
  MemberAppSharingInput,
  MemberAppSharingResult,
  MemberAppSharingSocketResult,
  MemberAppWithdrawInput,
  MemberAppWithdrawResult,
  MemberAppWithdrawSocketResult,
} from "./memberApps";
import { EVERY_MCP_LEVEL } from "./operationDeclaration";
import type { SocketAdmission, WriteFamily } from "./writeDeclaration";

const admission: SocketAdmission = {
  receivedShare: "owner",
  readOnlyWorkspace: "handler-decides",
  run: "never-a-run",
  paths: "none",
};
const reason =
  "The server decides each change by the signed-in account's role, at every share level.";

export const MEMBER_APPS_WRITE_DECLARATIONS = {
  memberAppShare: {
    access: "write",
    capabilityId: "app.member.share",
    ipc: {
      channel: "desktop:member-app-share",
      input: MemberAppShareInput,
      result: MemberAppShareResult,
      inactiveMessage: "Sharing stopped because this window changed workspaces.",
    },
    socket: {
      verb: "memberAppShare",
      input: MemberAppShareInput,
      result: MemberAppShareSocketResult,
      admission,
    },
    cli: {
      command: ["member-apps", "share"],
      summary: "Share a Personal app with the workspace's members, or update it.",
      operands: "<app-folder>",
      flags: [
        {
          name: "--slug",
          value: "<name>",
          text: "Name the app keeps in the workspace (default: the folder name).",
        },
      ],
      notes: ["Sharing again under the same name updates the app. Members allow it again."],
      example: ["trip-board"],
    },
    mcp: {
      tool: "dohc_share_member_app",
      description:
        "Share a Personal app (a folder in the Personal app folder) with the members of a workspace you joined, or update the one you shared under the same slug. Members review and allow it in their browser before it runs. It can do only what both its author and each viewer can do.",
      levels: EVERY_MCP_LEVEL,
      reason,
    },
  },
  memberAppFork: {
    access: "write",
    capabilityId: "app.member.fork",
    ipc: {
      channel: "desktop:member-app-fork",
      input: MemberAppForkInput,
      result: MemberAppForkResult,
      inactiveMessage: "Copying stopped because this window changed workspaces.",
    },
    socket: {
      verb: "memberAppFork",
      input: MemberAppForkInput,
      result: MemberAppForkSocketResult,
      admission,
    },
    cli: {
      command: ["member-apps", "fork"],
      summary: "Copy a Member app's source into a new Personal app folder.",
      operands: "<app-id> <new-folder>",
      example: ["0".repeat(64), "my-trip-board"],
    },
    mcp: {
      tool: "dohc_fork_member_app",
      description:
        "Copy a Member app's source into a new folder in the Personal app folder, to read or change it. The copy is a Personal app that only you use until you approve or share it. Refuses a folder that exists.",
      levels: EVERY_MCP_LEVEL,
      reason,
    },
  },
  memberAppWithdraw: {
    access: "write",
    capabilityId: "app.member.withdraw",
    ipc: {
      channel: "desktop:member-app-withdraw",
      input: MemberAppWithdrawInput,
      result: MemberAppWithdrawResult,
      inactiveMessage: "Withdrawing stopped because this window changed workspaces.",
    },
    socket: {
      verb: "memberAppWithdraw",
      input: MemberAppWithdrawInput,
      result: MemberAppWithdrawSocketResult,
      admission,
    },
    cli: {
      command: ["member-apps", "withdraw"],
      summary: "Stop sharing a Member app with the workspace.",
      operands: "<app-id>",
      notes: [
        "Authors withdraw their own apps. The owner and admins can withdraw any. Sharing it again brings it back.",
      ],
      example: ["0".repeat(64)],
    },
    mcp: {
      tool: "dohc_withdraw_member_app",
      description:
        "Stop sharing a Member app. Authors withdraw their own; the workspace owner and admins can withdraw any member's app. Members can no longer open it. The author can share it again. Ask the person you work for before you withdraw someone else's app.",
      levels: EVERY_MCP_LEVEL,
      reason,
    },
  },
  memberAppSharing: {
    access: "write",
    capabilityId: "app.member.sharing",
    ipc: {
      channel: "desktop:member-app-sharing",
      input: MemberAppSharingInput,
      result: MemberAppSharingResult,
      inactiveMessage: "The change stopped because this window changed workspaces.",
    },
    socket: {
      verb: "memberAppSharing",
      input: MemberAppSharingInput,
      result: MemberAppSharingSocketResult,
      admission,
    },
    cli: {
      command: ["member-apps", "sharing"],
      summary: "Turn members' app sharing on or off.",
      operands: "<on|off>",
      notes: ["Only the owner and admins can change it. Apps already shared stay shared."],
      example: ["on"],
    },
    mcp: {
      tool: "dohc_set_member_app_sharing",
      description:
        "Turn on or off whether members of a workspace can share apps with each other. Only its owner and admins can change it. Apps already shared stay shared. Ask the person you work for first.",
      levels: EVERY_MCP_LEVEL,
      reason,
    },
  },
} as const satisfies WriteFamily;
