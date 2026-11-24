import {
  InboxAddInput,
  InboxAddResult,
  InboxAddSocketResult,
  InboxArchiveInput,
  InboxArchiveResult,
  InboxArchiveSocketResult,
  InboxMoveInput,
  InboxMoveResult,
  InboxMoveSocketResult,
} from "./inbox";
import type { WriteFamily } from "./writeDeclaration";

const OWNER_ONLY_REASON =
  "Inbox belongs to the owning workspace. Shared profiles omit this write; socket read-only and received-share admission remain the gates.";

export const INBOX_WRITE_DECLARATIONS = {
  inboxAdd: {
    access: "write",
    capabilityId: "inbox.add",
    ipc: {
      channel: "desktop:inbox-add",
      input: InboxAddInput,
      result: InboxAddResult,
      inactiveMessage: "Inbox capture stopped because this window changed workspaces.",
    },
    socket: {
      verb: "inboxAdd",
      input: InboxAddInput,
      result: InboxAddSocketResult,
      admission: {
        receivedShare: "owner",
        readOnlyWorkspace: "refuse-file",
        run: "may-name-its-run",
        paths: "none",
      },
    },
    cli: {
      command: ["inbox", "add"],
      summary: "Capture a note or link into the workspace Inbox.",
      operands: "[body]",
      flags: [
        { name: "--title", value: "<text>", text: "Title for the Inbox item." },
        { name: "--url", value: "<https://...>", text: "Optional http or https link to capture." },
        {
          name: "--kind",
          value: "<note|file|image|link|webhook>",
          text: "Item kind (defaults to link when --url is set, otherwise note).",
        },
      ],
      notes: ["Creates Inbox/ lazily on first capture."],
      example: ["--title", "Follow up", "Remember to send receipt"],
    },
    mcp: {
      tool: "dohc_inbox_add",
      description:
        "Capture a note or link into the owning workspace's Inbox Collection (Inbox/). Creates Inbox/collection.yaml lazily on first capture and writes a Markdown record with safe YAML frontmatter.",
      levels: ["owner"],
      reason: OWNER_ONLY_REASON,
    },
  },
  inboxArchive: {
    access: "write",
    capabilityId: "inbox.archive",
    ipc: {
      channel: "desktop:inbox-archive",
      input: InboxArchiveInput,
      result: InboxArchiveResult,
      inactiveMessage: "Archiving stopped because this window changed workspaces.",
    },
    socket: {
      verb: "inboxArchive",
      input: InboxArchiveInput,
      result: InboxArchiveSocketResult,
      admission: {
        receivedShare: "owner",
        readOnlyWorkspace: "refuse-file",
        run: "may-name-its-run",
        paths: "none",
      },
    },
    cli: {
      command: ["inbox", "archive"],
      summary: "Mark an Inbox item as Archived.",
      operands: "<path>",
      notes: ["Updates Status to Archived through the item's live document session."],
      example: ["Inbox/item.md"],
    },
    mcp: {
      tool: "dohc_inbox_archive",
      description:
        "Mark a record in Inbox/ as Archived by updating its Status field through its live document session. Returns the previous Status so the change can be reversed.",
      levels: ["owner"],
      reason: OWNER_ONLY_REASON,
    },
  },
  inboxMove: {
    access: "write",
    capabilityId: "inbox.move",
    ipc: {
      channel: "desktop:inbox-move",
      input: InboxMoveInput,
      result: InboxMoveResult,
      inactiveMessage: "Moving stopped because this window changed workspaces.",
    },
    socket: {
      verb: "inboxMove",
      input: InboxMoveInput,
      result: InboxMoveSocketResult,
      admission: {
        receivedShare: "owner",
        readOnlyWorkspace: "refuse-file",
        run: "may-name-its-run",
        paths: "none",
      },
    },
    cli: {
      command: ["inbox", "move"],
      summary: "Move an Inbox item (and any linked Inbox attachments) into an owned folder.",
      operands: "<path> <folder>",
      notes: [
        "Rewrites workspace links and returns History operation id(s) for Undo.",
        'Use "" or "." as <folder> to move into the workspace root.',
      ],
      example: ["Inbox/item.md", "Projects"],
    },
    mcp: {
      tool: "dohc_inbox_move",
      description:
        "Move an Inbox Markdown record (and any linked attachments under Inbox/files/) into an owned workspace folder outside Inbox/. Rewrites workspace links and returns History operation id(s) that can be undone.",
      levels: ["owner"],
      reason: OWNER_ONLY_REASON,
    },
  },
} as const satisfies WriteFamily;
