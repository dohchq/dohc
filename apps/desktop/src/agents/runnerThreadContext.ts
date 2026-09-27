import { readThreadDispatchState } from "./threadDispatchState";
import type { AwaitableAgentDispatchStore } from "./awaitableAgentDispatchStore";
import { renderThreadMarkdown } from "@dohc/cli/thread-markdown";
import type { CliResultByVerb } from "@dohc/cli/protocol";
import type {
  ChatMessage,
  ChatThreadId,
  LinkedChatStore,
  WorkspaceId,
} from "@dohc/workspace-contracts/engine";
import { cliGroupKind, FILES_GROUP } from "../cli/cliServer";

type RunnerThreadStore = Pick<
  LinkedChatStore,
  "listChannels" | "listMessages" | "listThreadDecisions" | "listThreads"
>;

interface RunnerThreadContextInput {
  store: RunnerThreadStore;
  dispatchStore: AwaitableAgentDispatchStore;
  workspaceId: WorkspaceId;
  threadId: ChatThreadId;
}

function messageForMarkdown(
  message: ChatMessage,
  decisionByMessage: ReadonlyMap<
    string,
    { state: "open" | "resolved"; options?: readonly string[]; chosenOption?: string }
  >,
): CliResultByVerb["show"]["messages"][number] {
  const decision = decisionByMessage.get(message.id);
  return {
    id: message.id,
    author: message.author,
    body: message.body,
    createdAtMs: message.createdAtMs,
    ...(message.parentMessageId ? { parentMessageId: message.parentMessageId } : {}),
    ...(decision ? { decisionState: decision.state } : {}),
    ...(decision?.options && decision.options.length > 0
      ? { decisionOptions: [...decision.options] }
      : {}),
    ...(decision?.chosenOption ? { decisionChosenOption: decision.chosenOption } : {}),
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
    throw new Error(`The group, direct message, or agent lane holding thread ${JSON.stringify(input.threadId)} was not found.`);
  }
  const decisionByMessage = new Map(
    decisions.map((decision) => [
      decision.messageId,
      {
        state: decision.state,
        ...(decision.options ? { options: decision.options } : {}),
        ...(decision.chosenOption ? { chosenOption: decision.chosenOption } : {}),
      },
    ]),
  );
  const markdownInput: CliResultByVerb["show"] = {
    dispatch: await readThreadDispatchState(input.dispatchStore, input.workspaceId, input.threadId),
    thread: {
      id: thread.id,
      title: thread.title,
      group: channel
        ? {
            id: channel.id,
            name: channel.kind === "agent" ? "my-agent" : channel.name,
            slug: channel.slug,
            kind: cliGroupKind(channel.kind),
          }
        : FILES_GROUP,
      commentCount: Math.max(0, messages.length - 1),
      openDecisionCount: decisions.filter((decision) => decision.state === "open").length,
    },
    messages: messages.map((message) => messageForMarkdown(message, decisionByMessage)),
  };
  return renderThreadMarkdown(markdownInput);
}
