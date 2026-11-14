import type { ChatWrite } from "../server/chatWrites";
import { OutboxError, type OutboxState } from "../server/outbox";
import type { Lanes, WriteOutbox } from "./conversationWrites";
import type { Author, Message } from "./types";

// Sample conversation for design review only. Real messages come from the server's chat operations.

const maya: Author = {
  id: "maya",
  name: "Maya Chen",
  kind: "person",
  initials: "MC",
  hue: "#b4583e",
};
const sam: Author = {
  id: "sam",
  name: "Sam Ortiz",
  kind: "person",
  initials: "SO",
  hue: "#4f6aa8",
};
const me: Author = { id: "me", name: "You", kind: "person", initials: "IV", hue: "#3f7f86" };
const nova: Author = { id: "nova", name: "Nova", kind: "agent", owner: "Ice" };
const scout: Author = {
  id: "scout",
  name: "Scout",
  kind: "agent",
  connected: true,
  agentHue: "amber",
  reported: { product: "Claude Code", version: "2.1", model: "Claude Opus 5.5" },
};

export const sampleConversation = { name: "planning", members: 6 };

/** #planning's chat, as one thread, as a Group's chat lane is. */
const PLANNING_THREAD = "t-planning";
/** The thread that hangs from the Porto day trip message. */
export const PORTO_THREAD = "thread-porto";

/** The message the Porto thread hangs from. */
const portoAsk: Message = {
  id: "m4",
  threadId: PORTO_THREAD,
  author: me,
  at: "9:24",
  minute: 22,
  body: [
    { mention: "Nova", agent: true },
    { text: " can you add the Porto day trip to the itinerary app and check train times?" },
  ],
};

export const sampleMessages: readonly Message[] = [
  {
    id: "m1",
    threadId: PLANNING_THREAD,
    author: maya,
    at: "9:02",
    minute: 0,
    body: [{ text: "Booked the flat in Alfama 🎉 Check-in is from 3pm on the 12th." }],
    reactions: [
      { emoji: "🙌", count: 3, mine: true },
      { emoji: "🏠", count: 1 },
    ],
  },
  {
    id: "m2",
    threadId: PLANNING_THREAD,
    author: maya,
    at: "9:03",
    minute: 1,
    body: [{ text: "It has a terrace, so dinners at home are an option." }],
  },
  {
    id: "m3",
    threadId: PLANNING_THREAD,
    author: sam,
    at: "9:20",
    minute: 18,
    body: [{ text: "Nice. Can someone look at trains from Porto on the 15th?" }],
  },
  { ...portoAsk, replies: { count: 3, last: "9:31", people: [nova, sam] } },
  {
    id: "m5",
    threadId: PLANNING_THREAD,
    author: nova,
    at: "9:31",
    minute: 29,
    body: [
      {
        text: "The 8:09 Alfa Pendular gets you to Porto at 10:58. Which return should the itinerary use?",
      },
    ],
    question: { options: ["17:52", "19:52", "21:07"], chosen: "19:52" },
  },
  {
    id: "m6",
    threadId: PLANNING_THREAD,
    author: sam,
    at: "9:40",
    minute: 38,
    body: [{ text: "19:52 works for me, gives us dinner by the river." }],
    reactions: [{ emoji: "👍", count: 2 }],
  },
  {
    id: "m7",
    threadId: PLANNING_THREAD,
    author: nova,
    at: "9:41",
    minute: 39,
    body: [],
    working: "Updating the itinerary app",
  },
];

// A direct chat with one agent shows only you and that agent.
const novaMessages: readonly Message[] = [
  {
    id: "n1",
    author: me,
    at: "8:40",
    minute: 0,
    body: [{ text: "Can you draft a packing list for the 12th to the 19th? It should be warm." }],
  },
  {
    id: "n2",
    author: nova,
    at: "8:42",
    minute: 2,
    body: [
      { text: "Added packing-list.md with clothes, documents and the adapter Sam mentioned." },
    ],
  },
];

const scoutMessages: readonly Message[] = [
  {
    id: "s1",
    author: me,
    at: "10:12",
    minute: 0,
    body: [{ text: "Can you check the flat's cancellation terms?" }],
  },
  {
    id: "s2",
    author: scout,
    at: "10:14",
    minute: 2,
    body: [
      {
        text: "Free cancellation until Nov 5. After that, the first night is charged. I added this to budget.md under Lodging.",
      },
    ],
  },
  {
    id: "s3",
    author: me,
    at: "10:15",
    minute: 3,
    body: [{ text: "Thanks. Remind me on the 4th." }],
  },
];

/** The sample messages for a chat: the agents' direct chats have their own; every other chat shows #planning's. */
export function sampleMessagesFor(chatId: string): readonly Message[] {
  if (chatId === "a-nova") return novaMessages;
  if (chatId === "a-scout") return scoutMessages;
  return sampleMessages;
}

/** The Porto thread: the message it hangs from, then its replies. */
const portoMessages: readonly Message[] = [
  portoAsk,
  {
    id: "r1",
    threadId: PORTO_THREAD,
    author: nova,
    at: "9:27",
    minute: 25,
    body: [
      { text: "Added a Porto day on the 15th to the itinerary app, with the 8:09 train out." },
    ],
    reactions: [
      { emoji: "👍", count: 2 },
      { emoji: "🎉", count: 1, mine: true },
    ],
  },
  {
    id: "r2",
    threadId: PORTO_THREAD,
    author: sam,
    at: "9:29",
    minute: 27,
    body: [{ text: "Can we leave a bit later? 8:09 is early after a late dinner." }],
  },
  {
    id: "r3",
    threadId: PORTO_THREAD,
    author: nova,
    at: "9:31",
    minute: 29,
    body: [{ text: "The 9:09 gets in at 11:58. I kept 8:09 for now and noted the later one." }],
    reactions: [{ emoji: "👀", count: 1 }],
  },
];

/** A thread's messages: the Porto thread's, and #planning's for its chat, which is one thread. */
export function sampleThreadFor(threadId: string): readonly Message[] {
  return threadId === PORTO_THREAD ? portoMessages : sampleMessages;
}

/** An agent in this sample, by its author id, for its card. */
export function sampleAgent(id: string): Author | undefined {
  return [nova, scout].find((agent) => agent.id === id);
}

/** The author of what the sample's composer sends. */
export const sampleYou = me;

/** Whose records the sample's outbox keeps, and where. */
export const sampleScope = {
  origin: "https://sample.dohc.invalid",
  accountId: "me",
  workspaceId: "sample",
} as const;

/** The sample's chats take what the desktop's do: a Group takes posts and messages, and every other chat messages. */
export const sampleLanes = (kind: string): Lanes => ({ post: kind === "group", send: true });

type SampleRecord = OutboxState["records"][number];

/** A message in #planning as the outbox would keep it, at each stage `talk-outbox` shows. */
function seeded(sequence: number, body: string, fields: Partial<SampleRecord>): SampleRecord {
  return {
    ...sampleScope,
    operationId: `sample-op-${sequence}`,
    messageId: `sample-message-${sequence}`,
    sequence,
    dependsOn: null,
    target: { kind: "stream", id: "g-planning" },
    write: { operation: "send", args: { streamId: "g-planning", body } },
    stage: "queued",
    attempted: false,
    withheld: false,
    pendingSinceMs: null,
    result: null,
    ...fields,
  };
}

/** Design review only: `-dohcDemo talk-outbox` opens #planning with a message at each state that needs the person. */
const talkOutbox = (): SampleRecord[] => [
  seeded(1, "Can we push dinner to 8?", { withheld: true }),
  seeded(2, "Booked the 19:52 back from Porto.", { stage: "stalled", attempted: true }),
  seeded(3, "I'll bring the adapter.", {
    stage: "refused",
    attempted: true,
    result: {
      kind: "refused",
      reason: "Couldn't send",
      threadId: null,
      winnerMessageId: null,
    },
  }),
  seeded(4, "On my way.", {}),
];

/** A reaction in the Porto thread as the outbox would keep it. */
const reacted = (
  sequence: number,
  messageId: string,
  emoji: string,
  fields: Partial<SampleRecord>,
): SampleRecord =>
  seeded(sequence, "", {
    messageId: null,
    target: { kind: "thread", id: PORTO_THREAD },
    write: { operation: "react", args: { messageId, emoji, state: "added" } },
    ...fields,
  });

/**
 * Design review only: `-dohcDemo talk-thread` opens with a reply on its way in the Porto thread, a reaction kept
 * withheld, and one the server refused.
 */
const talkThread = (): SampleRecord[] => [
  seeded(1, "Later works for me too.", {
    target: { kind: "thread", id: PORTO_THREAD },
    write: {
      operation: "reply",
      args: { threadId: PORTO_THREAD, body: "Later works for me too.", parentMessageId: "r2" },
    },
    stage: "sending",
    attempted: true,
  }),
  reacted(2, "r2", "🙌", { withheld: true }),
  reacted(3, "r3", "✅", {
    stage: "refused",
    attempted: true,
    result: { kind: "refused", reason: "Couldn't send", threadId: null, winnerMessageId: null },
  }),
];

/**
 * The sample build's outbox, in memory: it never reaches a server. A write it takes shows Waiting to send, then
 * Sending, then stays as a message, or a reaction. Send on a withheld message does the same. Discard deletes it. A
 * reply to a post or send still here waits until that one is saved, then takes the thread it names.
 */
export function createSampleOutbox(seed: string | null): WriteOutbox {
  let records: SampleRecord[] =
    seed === "talk-outbox" ? talkOutbox() : seed === "talk-thread" ? talkThread() : [];
  let next = records.length + 1;
  let snapshot: OutboxState | null = null;
  const listeners = new Set<() => void>();
  const changed = () => {
    snapshot = null;
    for (const listener of listeners) listener();
  };
  const update = (operationId: string, fields: Partial<SampleRecord>) => {
    records = records.map((record) =>
      record.operationId === operationId ? { ...record, ...fields } : record,
    );
    changed();
  };
  const find = (operationId: string | null) =>
    records.find((record) => record.operationId === operationId);
  const savedThread = (record: SampleRecord | undefined) =>
    record?.result?.kind === "saved" ? record.result.threadId : null;
  const run = (record: SampleRecord) => {
    const { write } = record;
    // A reply waiting for its post or send asks again until that one is saved, then takes its thread.
    if (write.operation === "reply" && write.args.threadId === null) {
      const parent = find(record.dependsOn);
      if (!parent || parent.stage === "refused") {
        update(record.operationId, {
          stage: "refused",
          result: {
            kind: "refused",
            reason: "The message it replies to wasn't sent",
            threadId: null,
            winnerMessageId: null,
          },
        });
        return;
      }
      const threadId = savedThread(parent);
      if (threadId === null) {
        setTimeout(() => {
          const current = find(record.operationId);
          if (current && !current.withheld) run(current);
        }, 1000);
        return;
      }
      const bound: SampleRecord = {
        ...record,
        target: { kind: "thread", id: threadId },
        write: { operation: "reply", args: { ...write.args, threadId } },
      };
      update(record.operationId, { target: bound.target, write: bound.write });
      run(bound);
      return;
    }
    setTimeout(() => update(record.operationId, { stage: "sending", attempted: true }), 700);
    setTimeout(
      () =>
        update(record.operationId, {
          stage: "saved",
          result: {
            kind: "saved",
            // A post or send starts a thread here; a reply stays in its own.
            threadId:
              write.operation === "reply"
                ? write.args.threadId
                : write.operation === "react"
                  ? null
                  : `sample-thread-${record.sequence}`,
            messageId: record.messageId,
          },
        }),
      1600,
    );
  };
  const make = (
    write: ChatWrite,
    dependsOn: string | undefined,
    thread: string | undefined,
  ): SampleRecord => {
    const sequence = next;
    next += 1;
    const target =
      write.operation === "send"
        ? { kind: "stream" as const, id: write.args.streamId }
        : write.operation === "post"
          ? { kind: "stream" as const, id: write.args.groupId }
          : write.operation === "reply"
            ? write.args.threadId === null
              ? null
              : { kind: "thread" as const, id: write.args.threadId }
            : { kind: "thread" as const, id: thread ?? "" };
    return {
      ...seeded(sequence, "", {}),
      messageId: write.operation === "react" ? null : `sample-message-${sequence}`,
      dependsOn: dependsOn ?? null,
      target,
      write,
    };
  };
  return {
    state: () =>
      (snapshot ??= {
        status: "ready",
        records,
        aside: [],
        unreadable: [],
        deletion: "none",
      }),
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    async enqueue({ write, dependsOn, thread }) {
      const parent = dependsOn === undefined ? undefined : find(dependsOn);
      // As the outbox does: a reply waits only for a post or send it still has, that wasn't refused.
      if (
        dependsOn !== undefined &&
        (!parent || parent.stage === "refused" || parent.result?.kind === "missing")
      )
        throw new OutboxError("invalid");
      const record = make(write, dependsOn, thread);
      records = [...records, record];
      changed();
      run(record);
      return record;
    },
    async retryEnqueue(operationId) {
      const record = records.find((entry) => entry.operationId === operationId && entry.withheld);
      if (!record) throw new Error("No withheld message");
      const sendable = { ...record, withheld: false };
      update(operationId, { withheld: false });
      run(sendable);
      return sendable;
    },
    async discard(target) {
      if (target.kind === "record")
        records = records.filter((record) => record.operationId !== target.operationId);
      changed();
    },
    wake: () => undefined,
  };
}
