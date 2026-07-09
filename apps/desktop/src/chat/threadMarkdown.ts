import type {
  ChatAttachment,
  ChatMessage,
  ChatThreadId,
  LinkedChatStore,
  WorkspaceId,
} from "@dohc/workspace-engine";

type ThreadMarkdownStore = Pick<
  LinkedChatStore,
  "listMessages" | "listThreadAttachments" | "listThreads"
>;

export interface RenderThreadMarkdownInput {
  store: ThreadMarkdownStore;
  workspaceId: WorkspaceId;
  threadId: ChatThreadId;
}

function titleLine(title: string): string {
  const normalized = title.replace(/\s+/gu, " ").trim();
  return `# ${normalized || "Chat thread"}`;
}

function attachmentLine(attachments: readonly ChatAttachment[]): string | null {
  if (attachments.length === 0) return null;
  return attachments
    .map((attachment) => `[attach: ${attachment.pathHint ?? attachment.objectId}]`)
    .join(" ");
}

function messageBlock(
  message: ChatMessage,
  attachments: readonly ChatAttachment[],
): string {
  const lines = [
    `**${message.author.displayName}** · ${new Date(message.createdAtMs).toISOString()} · msg_${message.id}`,
    message.body,
  ];
  const renderedAttachments = attachmentLine(attachments);
  if (renderedAttachments !== null) lines.push(renderedAttachments);
  return lines.join("\n");
}

export async function renderThreadMarkdown(
  input: RenderThreadMarkdownInput,
): Promise<string> {
  const threads = await input.store.listThreads({ workspaceId: input.workspaceId });
  const thread = threads.find((candidate) => candidate.id === input.threadId);
  if (!thread) {
    throw new Error(`Chat thread ${JSON.stringify(input.threadId)} was not found.`);
  }

  const [messages, attachments] = await Promise.all([
    input.store.listMessages({
      workspaceId: input.workspaceId,
      threadId: input.threadId,
    }),
    input.store.listThreadAttachments(input.workspaceId, input.threadId),
  ]);
  const attachmentsByMessage = new Map<ChatMessage["id"], ChatAttachment[]>();
  for (const attachment of attachments) {
    const current = attachmentsByMessage.get(attachment.messageId) ?? [];
    current.push(attachment);
    attachmentsByMessage.set(attachment.messageId, current);
  }

  const blocks = messages.map((message) =>
    messageBlock(message, attachmentsByMessage.get(message.id) ?? []),
  );
  return `${[titleLine(thread.title), ...blocks].join("\n\n").trimEnd()}\n`;
}
