import { InboxListInput, InboxListResult } from "./inbox";
import type { OperationFamily } from "./operationDeclaration";

export const INBOX_DECLARATIONS = {
  inboxList: {
    access: "read",
    capabilityId: "inbox.list",
    input: InboxListInput,
    result: InboxListResult,
    ipc: {
      channel: "desktop:inbox-list",
      inactiveMessage: "Inbox stopped because this window changed workspaces.",
    },
    cli: {
      verb: "inboxList",
      command: ["inbox", "list"],
      summary: "List items waiting in the workspace Inbox.",
      operands: "",
      flags: [
        { name: "--status", value: "<New|Filed|Archived>", text: "Filter items by status." },
        {
          name: "--limit",
          value: "<n>",
          text: "Show at most this many items (default 50, max 100).",
        },
      ],
      unavailable: "Workspace Inbox is unavailable.",
      example: [],
    },
    mcp: {
      tool: "dohc_inbox_list",
      levels: ["owner"],
      description:
        "List items in the workspace's Inbox Collection (Inbox/). Returns exists: false without creating Inbox/ when none exists yet. Optionally filter by status (New, Filed, Archived).",
    },
  },
} as const satisfies OperationFamily;
