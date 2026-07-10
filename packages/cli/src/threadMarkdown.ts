import type { CliResultByVerb } from "./protocol";

export type ThreadMarkdownInput = CliResultByVerb["show"];

function swapEnginePrefix(
  id: string,
  enginePrefix: string,
  displayPrefix: string,
): string {
  return id.startsWith(enginePrefix)
    ? `${displayPrefix}${id.slice(enginePrefix.length)}`
    : id;
}

export function formatMessageHandle(id: string): string {
  return swapEnginePrefix(id, "message_", "msg_");
}

function formatThreadHandle(id: string): string {
  return swapEnginePrefix(id, "thread_", "th_");
}

function attachmentLabel(
  attachment: ThreadMarkdownInput["messages"][number]["attachments"][number],
): string {
  return attachment.pathHint ?? attachment.objectId ?? "attachment";
}

function decisionCount(count: number): string {
  return count === 0 ? "none" : String(count);
}

export function renderThreadMarkdown(result: ThreadMarkdownInput): string {
  const { thread, messages } = result;
  const lines = [
    `# ${thread.title}`,
    `thread: ${formatThreadHandle(thread.id)} · #${thread.channel.slug} · ${thread.commentCount} comments · open decisions: ${decisionCount(thread.openDecisionCount)}`,
  ];
  for (const message of messages) {
    const metadata = [
      `**${message.author.displayName}**`,
      new Date(message.createdAtMs).toISOString(),
      formatMessageHandle(message.id),
    ];
    if (message.parentMessageId) {
      metadata.push(`replying to ${formatMessageHandle(message.parentMessageId)}`);
    }
    if (message.decisionState) metadata.push(`needs-decision(${message.decisionState})`);
    if (message.runId) metadata.push(`run ${message.runId}`);
    lines.push("", metadata.join(" · "), message.body);
    if (message.attachments.length > 0) {
      lines.push(
        message.attachments
          .map((attachment) => `[attach: ${attachmentLabel(attachment)}]`)
          .join(" "),
      );
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
