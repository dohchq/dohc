import type { CliShowMessage, CliShowThreadResult, CliStreamPosition } from "./protocol";
import { renderAuthorDisplayName } from "./chatIdentity";

type ThreadMarkdownInput = Omit<CliShowThreadResult, "dispatch"> &
  Partial<Pick<CliShowThreadResult, "dispatch">>;

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
  return swapEnginePrefix(id, "message-", "msg_");
}

function formatThreadHandle(id: string): string {
  return swapEnginePrefix(id, "thread-", "th_");
}

function attachmentLabel(
  attachment: ThreadMarkdownInput["messages"][number]["attachments"][number],
): string {
  return attachment.pathHint ?? attachment.objectId ?? "attachment";
}

function decisionCount(count: number): string {
  return count === 0 ? "none" : String(count);
}

/** The `--before` value that reads the page older than this position. */
export function formatStreamPosition(position: CliStreamPosition): string {
  return `${position.createdAtMs}:${position.lane}:${position.id}`;
}

// What an agent's client reported about itself, as people see it beside the
// name: `Claude Code 2.1, Claude Opus 5.5 (as reported)`.
function reportedAgentLabel(reported: CliShowMessage["authorReported"]): string[] {
  const product = reported?.product ? (reported.version ? `${reported.product} ${reported.version}` : reported.product) : undefined;
  const parts = [product, reported?.model].filter((part) => part !== undefined);
  return parts.length > 0 ? [`${parts.join(", ")} (as reported)`] : [];
}

/** A message's author, what its agent reported, how it came, when, and what its agents are doing. */
export function messageMetadata(message: CliShowMessage, handle: string): string[] {
  return [
    `**${renderAuthorDisplayName(message.author)}**`,
    ...reportedAgentLabel(message.authorReported),
    // An automation's message says so, so an agent it woke knows no
    // person wrote the request. A link holder's says it came through a link.
    ...(message.author.kind === "automation" ? ["automation"] : []),
    ...(message.author.kind === "link" ? ["link holder"] : []),
    new Date(message.createdAtMs).toISOString(),
    handle,
    ...(message.agentRequests ?? []).map((request) => {
      const failure = request.failureReason ?? (request.exitCode === undefined ? undefined : `exit ${request.exitCode}`);
      return `agent ${request.agentId} ${request.state}${failure ? ` (${failure})` : ""}`;
    }),
  ];
}

export function renderThreadMarkdown(result: ThreadMarkdownInput): string {
  const { thread, messages } = result;
  const lines = [
    `# ${thread.title}`,
    `thread: ${formatThreadHandle(thread.id)} · #${thread.group.slug} · ${thread.commentCount} comments · open decisions: ${decisionCount(thread.openDecisionCount)}`,
    ...(result.dispatch ? [`dispatch: ${JSON.stringify(result.dispatch)}`] : []),
  ];
  for (const message of messages) {
    const metadata = messageMetadata(message, formatMessageHandle(message.id));
    if (message.parentMessageId) {
      metadata.push(`replying to ${formatMessageHandle(message.parentMessageId)}`);
    }
    if (message.decisionState) metadata.push(`needs-decision(${message.decisionState})`);
    if (message.runId) metadata.push(`run ${message.runId}`);
    lines.push("", metadata.join(" · "), message.body);
    if (message.decisionOptions && message.decisionOptions.length > 0) {
      lines.push(
        ...message.decisionOptions.map((option) =>
          option === message.decisionChosenOption ? `- [x] ${option}` : `- [ ] ${option}`,
        ),
      );
    }
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
