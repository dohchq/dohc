import { expect, it } from "vitest";
import type { ChatMessage } from "@dohc/workspace-contracts/engine";
import type { WriteCommand } from "./accountChatWrites";
import {
  MAX_WAKE_CANDIDATES,
  resolveWakeTargets,
  TooManyWakeCandidates,
  type DmSource,
  type WakeSources,
} from "./chatWakes";
import type { ChatRunner } from "./storage/chatWakes";

const runner = (
  installId: string,
  agentId: string,
  displayName: string,
  handle: string,
  memory = false,
): ChatRunner => ({
  installId,
  computerLabel: installId,
  agentId,
  handle,
  displayName,
  enabled: true,
  memory,
});
const agentMessage = (id: string, displayName: string, authorAgentId = "default"): ChatMessage => ({
  id,
  workspaceId: "trip",
  threadId: "thread-1",
  author: { kind: "agent", displayName },
  authorUserId: "ana",
  authorAgentId,
  body: "Done.",
  createdAtMs: 1,
  attachments: [],
});
const sources = (
  runners: ChatRunner[],
  messages: ChatMessage[] = [],
  dm: Pick<WakeSources, "dmAgent" | "latest"> = {
    dmAgent: async () => null,
    latest: async () => ({ complete: true, message: null }),
  },
): WakeSources => ({
  runners,
  message: async (messageId) => messages.find((message) => message.id === messageId) ?? null,
  thread: async (threadId) => ({
    id: threadId,
    workspaceId: "trip",
    title: "Post",
    createdAtMs: 1,
    updatedAtMs: 1,
    lane: "posts",
    channelId: "group",
  }),
  opening: async () => null,
  ...dm,
});
const reply = (body: string, parentMessageId?: string): WriteCommand => ({
  kind: "reply",
  threadId: "thread-1",
  messageId: "reply-1",
  body,
  ...(parentMessageId === undefined ? {} : { parentMessageId }),
});

it("keeps the hint for an agent it answers that matched several computers, unless a mention names that same agent", async () => {
  const runners = [
    runner("mac", "default", "Claude", "claude"),
    runner("laptop", "default", "Claude", "claude"),
    runner("desktop", "default", "Codex", "codex"),
  ];
  const answered = [agentMessage("message-claude", "Claude")];
  expect(
    await resolveWakeTargets(
      sources(runners, answered),
      "ana",
      reply("@codex check this", "message-claude"),
    ),
  ).toEqual({
    targets: [
      {
        target: "mention:codex",
        candidates: [
          {
            installId: "desktop",
            agentId: "default",
            label: "desktop",
            matched: { handle: "codex" },
          },
        ],
      },
    ],
    unmatched: true,
  });
  expect(
    await resolveWakeTargets(
      sources(runners, answered),
      "ana",
      reply("@claude check this", "message-claude"),
    ),
  ).toMatchObject({ targets: [{ target: "mention:claude" }], unmatched: false });
});

it("wakes only the computers whose agent remembers, for a mention and for the agent it answers", async () => {
  const installs = (wakes: Awaited<ReturnType<typeof resolveWakeTargets>>) =>
    wakes.targets.map((target) => [
      target.target,
      target.candidates.map((candidate) => candidate.installId),
    ]);
  const mixed = [
    runner("mac", "default", "Nova", "nova", true),
    runner("laptop", "default", "Nova", "nova"),
  ];
  expect(installs(await resolveWakeTargets(sources(mixed), "ana", reply("@nova hi")))).toEqual([
    ["mention:nova", ["mac"]],
  ]);
  const plain = [
    runner("mac", "default", "Nova", "nova"),
    runner("laptop", "default", "Nova", "nova"),
  ];
  expect(installs(await resolveWakeTargets(sources(plain), "ana", reply("@nova hi")))).toEqual([
    ["mention:nova", ["mac", "laptop"]],
  ]);

  const answered = [agentMessage("message-nova", "Nova")];
  expect(
    await resolveWakeTargets(sources(mixed, answered), "ana", reply("thanks", "message-nova")),
  ).toMatchObject({ targets: [{ target: "implicit:mac:default" }], unmatched: false });
  for (const runners of [plain, mixed.map((each) => ({ ...each, memory: true }))])
    expect(
      await resolveWakeTargets(sources(runners, answered), "ana", reply("thanks", "message-nova")),
    ).toEqual({ targets: [], unmatched: true });

  const apart = [
    runner("mac", "default", "Nova", "nova", true),
    runner("laptop", "nova-2", "Nova", "nova"),
  ];
  expect(
    installs(
      await resolveWakeTargets(
        sources(apart, [agentMessage("message-laptop", "Nova", "nova-2")]),
        "ana",
        reply("@nova go on", "message-laptop"),
      ),
    ),
  ).toEqual([["mention:nova", ["mac"]]]);
});

it("keeps every target up to its candidate limit, and refuses a message past it", async () => {
  const helpers = (installId: string, count: number) =>
    Array.from({ length: count }, (_, index) =>
      runner(installId, `helper-${index}`, `Helper ${index}`, `helper${index}`),
    );
  const body = (count: number) =>
    Array.from({ length: count }, (_, index) => `@helper${index}`).join(" ");
  expect(
    (await resolveWakeTargets(sources(helpers("mac", 33)), "ana", reply(body(33)))).targets,
  ).toHaveLength(33);
  const half = MAX_WAKE_CANDIDATES / 2;
  const both = [...helpers("mac", half + 1), ...helpers("laptop", half + 1)];
  expect(
    (await resolveWakeTargets(sources(both), "ana", reply(body(half)))).targets.flatMap(
      (target) => target.candidates,
    ),
  ).toHaveLength(MAX_WAKE_CANDIDATES);
  await expect(
    resolveWakeTargets(sources(both), "ana", reply(body(half + 1))),
  ).rejects.toBeInstanceOf(TooManyWakeCandidates);
});

it("wakes no one in a DM whose agent the bounded read didn't reach, without refusing, and keeps the hint", async () => {
  const runners = [runner("mac", "default", "Claude", "claude")];
  const send: WriteCommand = {
    kind: "start",
    lane: "chat",
    channelId: "dm",
    threadId: "thread-dm",
    messageId: "message-1",
    body: "Still there?",
  };
  const dm = (source: DmSource): Pick<WakeSources, "dmAgent" | "latest"> => ({
    dmAgent: async () => "default",
    latest: async () => source,
  });
  expect(
    await resolveWakeTargets(sources(runners, [], dm({ complete: false })), "ana", send),
  ).toEqual({ targets: [], unmatched: true });
  expect(
    await resolveWakeTargets(
      sources(runners, [], dm({ complete: true, message: null })),
      "ana",
      send,
    ),
  ).toEqual({ targets: [], unmatched: false });
  expect(
    await resolveWakeTargets(
      sources(
        runners,
        [],
        dm({ complete: true, message: agentMessage("message-claude", "Claude") }),
      ),
      "ana",
      send,
    ),
  ).toMatchObject({ targets: [{ target: "implicit:mac:default" }], unmatched: false });
});
