import { createHash } from "node:crypto";
import type { ChatChannelKind, ChatChannelType, ChatThreadLane, LinkedChatStore } from "@dohc/workspace-contracts/engine";
import type { Automation } from "@dohc/workspace-contracts/automations";
import type { ReachRoster } from "./automationReach";

// Where an automation's messages go (item 6, section 2). A post goes to a
// Group this workspace has, found by its name. A direct message goes only to
// a direct message this workspace's owner already started with exactly that
// person: starting one grants access, and automations never grant anything.

/** A chat channel as the directory reads it. */
export interface ChatDirectoryChannel {
  id: string;
  name: string;
  slug: string;
  kind: ChatChannelKind;
  type: ChatChannelType;
  wireId: string;
  /** The direct message's one running conversation, or null before its first message. */
  runningThreadId: string | null;
  /** A joined Group whose grant is read-only, or ended, so this computer may not post in it. */
  readOnly?: true;
  /** A joined Group whose grant ended: its copy here takes no new messages. */
  ended?: true;
}

interface ChatGroupTarget {
  channelId: string;
  wireId: string;
  name: string;
  lane: ChatThreadLane;
  readOnly: boolean;
  ended: boolean;
}

/** Why an automation cannot post in a Group this computer may only read. */
export const GROUP_READ_ONLY = "This computer can only read this Group, so an automation cannot post in it.";
/** Why a Group whose grant ended cannot start an automation. */
export const GROUP_ENDED = "This Group's share ended, so its messages no longer reach this computer.";

interface ChatDirectMessageTarget {
  channelId: string;
  wireId: string;
  threadId: string;
  /** How the reach check and errors name it. */
  name: string;
}

export interface ChatDirectory {
  group(name: string): ChatGroupTarget | { problem: string };
  directMessage(userId: string): ChatDirectMessageTarget | { problem: string };
  /** How a person is named to the owner: "you", their email, or "that person". */
  person(userId: string): string;
  /**
   * A person a notice can go to: the owner, or someone who accepted one of
   * the workspace's shares. A pending invite has no account yet.
   */
  noticeRecipient(userId: string): { name: string } | { problem: string };
}

/** The Groups and direct messages an automation on this computer can write to. */
export function chatDirectoryOf(
  channels: readonly ChatDirectoryChannel[],
  roster: Exclude<ReachRoster, { kind: "unknown" }>,
): ChatDirectory {
  const grants = roster.kind === "owner" ? roster.grants : [];
  // This computer's person, by their account or, in a workspace proved never
  // shared, by this computer's own id for them.
  const isOwner = (userId: string) =>
    roster.kind === "owner" && (userId === roster.ownerUserId || userId === roster.localPersonId);
  const personName = (userId: string) => isOwner(userId)
    ? "you"
    : grants.find((grant) => grant.recipientUserId === userId && grant.recipientEmail)?.recipientEmail ?? "that person";
  return {
    person: personName,
    noticeRecipient(userId) {
      if (isOwner(userId) || grants.some((grant) => grant.recipientUserId === userId)) {
        return { name: personName(userId) };
      }
      return { problem: "dohc cannot find that person among the people this workspace is shared with. They may not have accepted your share yet." };
    },
    group(name) {
      // A slug names one Group; a name can match several, or another Group's slug.
      const groups = channels.filter((channel) => channel.kind === "channel");
      const bySlug = groups.find((channel) => channel.slug === name);
      const matches = bySlug ? [bySlug] : groups.filter((channel) => channel.name === name);
      if (matches.length === 0) return { problem: `dohc cannot find the Group ${name}.` };
      if (matches.length > 1) {
        return { problem: `More than one Group is called ${name}. Name one by its slug instead: ${matches.map((channel) => channel.slug).join(" or ")}.` };
      }
      const [channel] = matches as [ChatDirectoryChannel];
      return {
        channelId: channel.id,
        wireId: channel.wireId,
        name: channel.name,
        lane: channel.type === "chat" ? "chat" : "posts",
        readOnly: channel.readOnly === true,
        ended: channel.ended === true,
      };
    },
    directMessage(userId) {
      const name = `your direct message with ${personName(userId)}`;
      // Only a direct message this workspace's owner started: its wire id is
      // its own id. Its people are the grants on that wire, and a pending
      // invite counts as someone else.
      const found = channels.find((channel) => {
        if (channel.kind !== "dm" || channel.wireId !== channel.id || channel.runningThreadId === null) return false;
        const people = new Set(grants
          .filter((grant) => grant.channel?.wireId === channel.wireId)
          .map((grant) => grant.recipientUserId ?? `email:${grant.recipientEmail ?? ""}`));
        return people.size === 1 && people.has(userId);
      });
      if (!found) {
        return { problem: `There is no direct message with ${personName(userId)} yet. Start one first: automations never start one.` };
      }
      return { channelId: found.id, wireId: found.wireId, threadId: found.runningThreadId!, name };
    },
  };
}

// The single running conversation (the anti-forum rule): the oldest thread in
// the DM channel, deterministically (createdAtMs, then thread id), so every
// participant picks the same one even if a race ever minted a duplicate. The
// DM list, startDm, and automations' direct messages all use this one rule
// (they must never drift).
export function runningThread<
  T extends { thread: { id: string; createdAtMs: number } },
>(threads: T[]): T | undefined {
  return threads
    .slice()
    .sort(
      (a, b) =>
        a.thread.createdAtMs - b.thread.createdAtMs ||
        (a.thread.id < b.thread.id ? -1 : 1),
    )[0];
}

/** A notice an automation sends to one person (item 6, section 3). */
export interface AutomationNotice {
  noticeId: string;
  kind: "automation-notify";
  title: string;
  body: string;
  target: { path: string; record?: string; automation: string; run: string };
  recipientUserId: string;
}

// A notice for another person that did not reach them. The message says why.
export class NoticeNotSentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoticeNotSentError";
  }
}

/**
 * A notice's id, the same on every attempt, so the outbox and the relay
 * drop a repeat.
 */
export function automationNoticeId(stepKey: string, recipientUserId: string): string {
  return `automation-notify:${createHash("sha256").update(`${stepKey}/notify/${recipientUserId}`).digest("hex")}`;
}

/** `text` cut to `max` characters, ending with "…" when it was longer. */
export function cutText(text: string, max: number): string {
  const characters = [...text];
  return characters.length <= max ? text : `${characters.slice(0, max - 1).join("")}…`;
}

/** One message an automation writes, keyed so a retry writes it once. */
export interface AutomationChatMessage {
  target:
    | { kind: "group"; channelId: string; lane: ChatThreadLane }
    | { kind: "direct-message"; threadId: string }
    // The person's own agent, in its "My agent" thread for this automation.
    | { kind: "agent" };
  /** Also the idempotency key: a retry replays the recorded message. */
  effectId: string;
  messageId: string;
  /** The thread a new post starts; a Group's chat lane keeps its running one. */
  threadId: string;
  automation: { automationId: string; name: string; depth: number };
  body: string;
}

const hashed = (prefix: string, value: string) =>
  `${prefix}${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;

/** The message id an effect writes, the same on every attempt. */
export function automationMessageId(effectId: string): string {
  return hashed("message-auto-", effectId);
}

/** The "My agent" thread an automation's wakes go to, one per automation. */
export function automationWakeThreadId(automationId: string): string {
  return hashed("thread-auto-", `wake/${automationId}`);
}

/** The thread id a post starts, the same on every attempt. */
export function automationThreadId(effectId: string): string {
  return hashed("thread-auto-", effectId);
}

/**
 * The signed-in session this synced workspace needs is missing: a message
 * written now would stay on this computer and reach nobody, so the step
 * waits for a session.
 */
export class AutomationChatSessionWait extends Error {
  constructor() {
    super("Sign in to your server so this automation can post.");
    this.name = "AutomationChatSessionWait";
  }
}

type ChatDirectoryStore = Pick<LinkedChatStore, "listChannels" | "getChannelWireId" | "listChannelThreads">;

/** What an automation's messages need from the directory: Groups by name, and direct messages. */
export interface ChatNeeds {
  groups: Set<string>;
  /** People whose direct messages a step writes to. A run adds those its formulas named once they are evaluated. */
  people: Set<string>;
}

/** The Groups and the people's direct messages these automations name outright. */
export function chatNeedsOf(automations: readonly Automation[]): ChatNeeds {
  const needs: ChatNeeds = { groups: new Set(), people: new Set() };
  const walk = (steps: Automation["do"]) => {
    for (const step of steps) {
      if (step.kind === "if") {
        walk(step.do);
        walk(step.otherwise);
      } else if (step.kind === "post") {
        needs.groups.add(step.group);
      } else if (step.kind === "direct-message") {
        for (const person of step.to) {
          if (person.kind === "literal" && typeof person.value === "string") needs.people.add(person.value);
        }
      }
    }
  };
  for (const automation of automations) {
    if (automation.when.kind === "group-message") needs.groups.add(automation.when.group);
    walk(automation.do);
  }
  return needs;
}

/**
 * Reads what `needs` names into a directory under this roster: the named
 * Groups' wire ids, and the running conversation of each direct message the
 * owner started with one person the needs can name. Nothing else is read.
 */
export async function readChatDirectory(
  store: ChatDirectoryStore,
  workspaceId: string,
  roster: Exclude<ReachRoster, { kind: "unknown" }>,
  needs: ChatNeeds,
  /** What this computer may do in a joined Group, by its wire id; null for one it owns. */
  joined: (wireId: string) => { readOnly: boolean; ended: boolean } | null = () => null,
): Promise<ChatDirectory> {
  const channels = await store.listChannels({ workspaceId });
  const grants = roster.kind === "owner" ? roster.grants : [];
  // A direct message the owner started keeps its own id as its wire id, and
  // its grants name its people.
  const onePerson = (wireId: string): string | undefined => {
    const people = new Set(grants
      .filter((grant) => grant.channel?.wireId === wireId)
      .map((grant) => grant.recipientUserId ?? `email:${grant.recipientEmail ?? ""}`));
    const [person] = people;
    return people.size === 1 ? person : undefined;
  };
  const entries: ChatDirectoryChannel[] = [];
  for (const channel of channels) {
    const base = { id: channel.id, name: channel.name, slug: channel.slug, kind: channel.kind, type: channel.type };
    if (channel.kind === "channel" && (needs.groups.has(channel.name) || needs.groups.has(channel.slug))) {
      const wireId = (await store.getChannelWireId({ workspaceId, channelId: channel.id })) ?? channel.id;
      const access = joined(wireId);
      entries.push({
        ...base, wireId, runningThreadId: null,
        ...(access?.readOnly || access?.ended ? { readOnly: true as const } : {}),
        ...(access?.ended ? { ended: true as const } : {}),
      });
    } else if (channel.kind === "dm") {
      const person = onePerson(channel.id);
      if (person === undefined || !needs.people.has(person)) continue;
      const running = runningThread(await store.listChannelThreads({ workspaceId, channelId: channel.id }));
      entries.push({ ...base, wireId: channel.id, runningThreadId: running?.thread.id ?? null });
    }
  }
  return chatDirectoryOf(entries, roster);
}
