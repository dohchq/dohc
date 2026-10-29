import { readThreadDispatchState } from "./threadDispatchState";
import type { AwaitableAgentDispatchStore } from "./awaitableAgentDispatchStore";
import { renderThreadMarkdown } from "@dohc/cli/thread-markdown";
import type { CliShowThreadResult } from "@dohc/cli/protocol";
import type {
  ChatMessage,
  ChatThreadId,
  LinkedChatStore,
  WorkspaceId,
} from "@dohc/workspace-contracts/engine";
import { cliGroupKind, FILES_GROUP } from "../cli/cliServer";

// A run sees the message that asked for it and every message after it, since
// its claim answers each request queued there. Older messages fill the rest
// of a size its agent can read at once.
export const RUNNER_CONTEXT_MESSAGES = 40;
export const RUNNER_CONTEXT_CHARS = 48_000;

type RunnerThreadStore = Pick<
  LinkedChatStore,
  "getThread" | "listMessagesPage" | "listThreadDecisions"
>;

interface RunnerThreadContextInput {
  store: RunnerThreadStore;
  dispatchStore: AwaitableAgentDispatchStore;
  workspaceId: WorkspaceId;
  threadId: ChatThreadId;
  askingMessageId: string;
  /** How this run reads what was left out, when it can. */
  readEarlier?: string;
}

function messageForMarkdown(
  message: ChatMessage,
  decisionByMessage: ReadonlyMap<
    string,
    { state: "open" | "resolved"; options?: readonly string[]; chosenOption?: string }
  >,
): CliShowThreadResult["messages"][number] {
  const decision = decisionByMessage.get(message.id);
  return {
    id: message.id,
    author: { kind: message.author.kind, displayName: message.author.displayName },
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
  const { workspaceId, threadId } = input;
  const { thread, channel, messageCount } = await input.store.getThread({ workspaceId, threadId });
  // The engine cuts a page at a byte budget, so long messages take more than one.
  const read = async (after: number | null, limit: number): Promise<ChatMessage[]> => {
    const read: ChatMessage[] = [];
    do {
      const page = await input.store.listMessagesPage({
        workspaceId,
        threadId,
        ...(after === null ? {} : { afterMessageOrder: after }),
        limit: Math.min(limit - read.length, RUNNER_CONTEXT_MESSAGES),
      });
      read.push(...page.messages);
      after = page.messages.length > 0 ? page.nextAfterMessageOrder : null;
    } while (after !== null && read.length < limit);
    return read;
  };
  const [newestMessages, decisions, dispatch] = await Promise.all([
    read(messageCount > RUNNER_CONTEXT_MESSAGES ? messageCount - RUNNER_CONTEXT_MESSAGES - 1 : null, RUNNER_CONTEXT_MESSAGES),
    input.store.listThreadDecisions(workspaceId, threadId),
    readThreadDispatchState(input.dispatchStore, workspaceId, threadId),
  ]);
  let messages = newestMessages;
  if (!messages.some((message) => message.id === input.askingMessageId)) {
    const all = await read(null, Number.POSITIVE_INFINITY);
    messages = all.slice(Math.max(0, all.findIndex((message) => message.id === input.askingMessageId)));
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
  const render = (shown: readonly ChatMessage[]): string => {
    const markdown = renderThreadMarkdown({
      dispatch,
      thread: {
        id: thread.id,
        title: thread.title,
        group: channel
          ? {
              id: channel.id,
              name: channel.kind === "agent" ? channel.slug : channel.name,
              slug: channel.slug,
              kind: cliGroupKind(channel.kind),
            }
          : FILES_GROUP,
        commentCount: Math.max(0, messageCount - 1),
        openDecisionCount: decisions.filter((decision) => decision.state === "open").length,
      },
      messages: shown.map((message) => messageForMarkdown(message, decisionByMessage)),
    });
    const omitted = messageCount - shown.length;
    if (omitted <= 0) return markdown;
    const note = `${omitted} earlier ${omitted === 1 ? "message in this thread isn't" : "messages in this thread aren't"} shown.${
      input.readEarlier ? ` Read ${omitted === 1 ? "it" : "them"} with \`${input.readEarlier}\`.` : ""
    }`;
    // The note goes under the thread's header, before its first message.
    return markdown.replace("\n\n", `\n${note}\n\n`);
  };
  let markdown = render(messages);
  while (markdown.length > RUNNER_CONTEXT_CHARS && messages.length > 1 && messages[0]?.id !== input.askingMessageId) {
    messages = messages.slice(1);
    markdown = render(messages);
  }
  return markdown;
}
