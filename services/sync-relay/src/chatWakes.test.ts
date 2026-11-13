import { expect, it } from "vitest";
import type { ChatMessage } from "@dohc/workspace-contracts/engine";
import type { WriteCommand } from "./accountChatWrites";
import { MAX_WAKE_CANDIDATES, resolveWakeTargets, TooManyWakeCandidates, type WakeSources } from "./chatWakes";
import type { ChatRunner } from "./storage/chatWakes";

// Resolution over fixed sources: a post in a Group, and the account's own agent messages by ID.

const runner = (installId: string, agentId: string, displayName: string, handle: string): ChatRunner =>
  ({ installId, computerLabel: installId, agentId, handle, displayName, enabled: true });
const agentMessage = (id: string, displayName: string): ChatMessage => ({
  id, workspaceId: "trip", threadId: "thread-1", author: { kind: "agent", displayName }, authorUserId: "ana", authorAgentId: "default",
  body: "Done.", createdAtMs: 1, attachments: [],
});
const sources = (runners: ChatRunner[], messages: ChatMessage[] = []): WakeSources => ({
  runners,
  message: async (messageId) => messages.find((message) => message.id === messageId) ?? null,
  thread: async (threadId) => ({ id: threadId, workspaceId: "trip", title: "Post", createdAtMs: 1, updatedAtMs: 1, lane: "posts", channelId: "group" }),
  opening: async () => null,
  dmAgent: async () => null,
  latest: async () => null,
});
const reply = (body: string, parentMessageId?: string): WriteCommand =>
  ({ kind: "reply", threadId: "thread-1", messageId: "reply-1", body, ...(parentMessageId === undefined ? {} : { parentMessageId }) });

it("keeps the hint for an agent it answers that matched several computers, unless a mention names that same agent", async () => {
  // Claude runs on two computers as `default`; a third computer's `default` is Codex.
  const runners = [runner("mac", "default", "Claude", "claude"), runner("laptop", "default", "Claude", "claude"), runner("desktop", "default", "Codex", "codex")];
  const answered = [agentMessage("message-claude", "Claude")];
  expect(await resolveWakeTargets(sources(runners, answered), "ana", reply("@codex check this", "message-claude"))).toEqual({
    targets: [{ target: "mention:codex", candidates: [{ installId: "desktop", agentId: "default", label: "desktop", matched: { handle: "codex" } }] }],
    unmatched: true,
  });
  expect(await resolveWakeTargets(sources(runners, answered), "ana", reply("@claude check this", "message-claude")))
    .toMatchObject({ targets: [{ target: "mention:claude" }], unmatched: false });
});

it("keeps every target up to its candidate limit, and refuses a message past it", async () => {
  const helpers = (installId: string, count: number) =>
    Array.from({ length: count }, (_, index) => runner(installId, `helper-${index}`, `Helper ${index}`, `helper${index}`));
  const body = (count: number) => Array.from({ length: count }, (_, index) => `@helper${index}`).join(" ");
  expect((await resolveWakeTargets(sources(helpers("mac", 33)), "ana", reply(body(33)))).targets).toHaveLength(33);
  const half = MAX_WAKE_CANDIDATES / 2;
  const both = [...helpers("mac", half + 1), ...helpers("laptop", half + 1)];
  expect((await resolveWakeTargets(sources(both), "ana", reply(body(half)))).targets.flatMap((target) => target.candidates))
    .toHaveLength(MAX_WAKE_CANDIDATES);
  await expect(resolveWakeTargets(sources(both), "ana", reply(body(half + 1)))).rejects.toBeInstanceOf(TooManyWakeCandidates);
});
