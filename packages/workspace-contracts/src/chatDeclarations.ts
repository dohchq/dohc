import { z } from "zod";
import { ChatFileMentionsInput, ChatFileMentionsPage } from "./chatFileMentions";
import { ChatLinksInput, ChatLinksPage } from "./chatLinks";
import { CURSOR_FLAG, EVERY_MCP_LEVEL, type OperationFamily } from "./operationDeclaration";

const inactiveMessage = "Chats stopped because this window changed workspaces.";

export const CHAT_DECLARATIONS = {
  chatLinks: {
    capabilityId: "chat.read", input: ChatLinksInput, result: ChatLinksPage,
    ipc: { channel: "desktop:chat-links", inactiveMessage },
    cli: {
      verb: "chatLinks", command: ["chat", "links"], summary: "Read one page of files mentioned in a chat.",
      operands: "<group>", flags: [CURSOR_FLAG], unavailable: "Chat links are unavailable.", example: ["general"],
    },
    mcp: {
      tool: "dohc_chat_links", levels: EVERY_MCP_LEVEL,
      description: "Read one bounded page of accessible files mentioned in a chat. Use channelWireId from dohc_list_groups, and continue nextCursor until null. Coverage can be partial.",
    },
  },
  chatFileMentionsPage: {
    capabilityId: "chat.read", input: ChatFileMentionsInput, result: ChatFileMentionsPage,
    ipc: {
      channel: "desktop:chat-file-mentions-page", inactiveMessage,
      // The engine adapter validates each page before the reader applies authority filtering.
      result: z.custom<z.infer<typeof ChatFileMentionsPage>>(),
    },
    cli: {
      verb: "chatFileMentions", command: ["chat", "file-mentions"], summary: "Read one bounded page of file mentions.",
      operands: "", flags: [{ name: "--subject", value: "subject", text: "A file path or objectId as JSON." }, CURSOR_FLAG],
      unavailable: "Chat mentions are unavailable.", example: [],
    },
    mcp: {
      tool: "dohc_chat_file_mentions", levels: EVERY_MCP_LEVEL,
      description: "Read a bounded page of accessible chat mentions of files. Optional subject selects one file. Continue nextCursor until null; complete and sharedChannelRowsUncovered report coverage.",
    },
  },
} as const satisfies OperationFamily;
