import { renderThreadMarkdown } from "@dohc/cli/thread-markdown";
import type { CliResultByVerb } from "@dohc/cli/protocol";
import type {
  ChatMessage,
  ChatThreadId,
  LinkedChatStore,
  WorkspaceId,
} from "@dohc/workspace-contracts/engine";

type RunnerThreadStore = Pick<
  LinkedChatStore,
  "listChannels" | "listMessages" | "listThreadDecisions" | "listThreads"
>;

export interface RunnerThreadContextInput {
  store: RunnerThreadStore;
  workspaceId: WorkspaceId;
  threadId: ChatThreadId;
}

function messageForMarkdown(
  message: ChatMessage,
  decisionByMessage: ReadonlyMap<string, "open" | "resolved">,
): CliResultByVerb["show"]["messages"][number] {
  return {
    id: message.id,
    author: message.author,
    body: message.body,
    createdAtMs: message.createdAtMs,
    ...(message.parentMessageId ? { parentMessageId: message.parentMessageId } : {}),
    ...(decisionByMessage.has(message.id)
      ? { decisionState: decisionByMessage.get(message.id)! }
      : {}),
    attachments: message.attachments.map((attachment) => ({
      ...(attachment.objectId ? { objectId: attachment.objectId } : {}),
      ...(attachment.pathHint ? { pathHint: attachment.pathHint } : {}),
    })),
  };
}

export async function buildRunnerThreadContext(
  input: RunnerThreadContextInput,
): Promise<string> {
  const [threads, channels, messages, decisions] = await Promise.all([
    input.store.listThreads({ workspaceId: input.workspaceId }),
    input.store.listChannels({ workspaceId: input.workspaceId }),
    input.store.listMessages({
      workspaceId: input.workspaceId,
      threadId: input.threadId,
    }),
    input.store.listThreadDecisions(input.workspaceId, input.threadId),
  ]);
  const thread = threads.find((candidate) => candidate.id === input.threadId);
  if (!thread) {
    throw new Error(`Chat thread ${JSON.stringify(input.threadId)} was not found.`);
  }
  const channel = thread.channelId
    ? channels.find((candidate) => candidate.id === thread.channelId)
    : undefined;
  if (thread.channelId && !channel) {
    throw new Error(`Chat channel for thread ${JSON.stringify(input.threadId)} was not found.`);
  }
  const decisionByMessage = new Map(
    decisions.map((decision) => [decision.messageId, decision.state]),
  );
  const markdownInput: CliResultByVerb["show"] = {
    thread: {
      id: thread.id,
      title: thread.title,
      channel: channel
        ? {
            id: channel.id,
            name: channel.kind === "agent" ? "my-agent" : channel.name,
            slug: channel.slug,
            kind: channel.kind,
          }
        : {
            id: "files",
            name: "files",
            slug: "files",
            kind: "channel",
          },
      commentCount: Math.max(0, messages.length - 1),
      openDecisionCount: decisions.filter((decision) => decision.state === "open").length,
    },
    messages: messages.map((message) => messageForMarkdown(message, decisionByMessage)),
  };
  return renderThreadMarkdown(markdownInput);
}
