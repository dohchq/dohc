export type ChatBookmarkProjectionMode = "live" | "snapshot";
export type ChatBookmarkProjectionState = "current" | "stale";

export interface ChatBookmarkProjectionMessage {
  id: string;
  authorKind: "human" | "agent";
  authorDisplayName: string;
  body: string;
  createdAtMs: number;
  parentMessageId?: string;
}

export interface ChatBookmarkProjectionInput {
  bookmarkId: string;
  threadId: string;
  messageId?: string;
  channelId?: string;
  channelName?: string;
  sourceGrantId?: string;
  title: string;
  mode: ChatBookmarkProjectionMode;
  state?: ChatBookmarkProjectionState;
  updatedAtMs: number;
  snapshotAtMs?: number;
  staleAtMs?: number;
  messages: readonly ChatBookmarkProjectionMessage[];
}

function yamlString(value: string): string {
  // JSON strings are valid YAML double-quoted scalars and give us a small,
  // deterministic escaping surface for ids/titles controlled by chat data.
  return JSON.stringify(value);
}

function iso(ms: number): string {
  if (!Number.isFinite(ms)) throw new Error("Chat bookmark timestamps must be finite.");
  return new Date(ms).toISOString();
}

function markdownLine(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").trim();
}

function agentLabel(message: ChatBookmarkProjectionMessage): string {
  const name = markdownLine(message.authorDisplayName);
  if (message.authorKind === "human") return name;
  return /(?:['’]s agent)$/iu.test(name) ? name : `${name}'s agent`;
}

/**
 * Formats a receiver-owned, read-only Markdown projection of authorized chat.
 * Authorization and message selection happen before this pure formatter is
 * called; it never resolves ids or reads hidden source state by itself.
 */
export function formatChatBookmarkProjection(
  input: ChatBookmarkProjectionInput,
): string {
  const state = input.state ?? "current";
  if (input.mode === "snapshot" && input.snapshotAtMs === undefined) {
    throw new Error("Snapshot chat bookmarks require snapshotAtMs.");
  }
  if (state === "stale" && input.staleAtMs === undefined) {
    throw new Error("Stale chat bookmarks require staleAtMs.");
  }

  const frontmatter = [
    "---",
    "dohc_type: chat-bookmark",
    `bookmark_id: ${yamlString(input.bookmarkId)}`,
    `source_thread_id: ${yamlString(input.threadId)}`,
    ...(input.messageId
      ? [`source_message_id: ${yamlString(input.messageId)}`]
      : []),
    ...(input.channelId
      ? [`source_channel_id: ${yamlString(input.channelId)}`]
      : []),
    ...(input.sourceGrantId
      ? [`source_grant_id: ${yamlString(input.sourceGrantId)}`]
      : []),
    `projection_mode: ${input.mode}`,
    `projection_state: ${state}`,
    `last_updated: ${yamlString(iso(input.updatedAtMs))}`,
    ...(input.snapshotAtMs !== undefined
      ? [`snapshot_at: ${yamlString(iso(input.snapshotAtMs))}`]
      : []),
    ...(input.staleAtMs !== undefined
      ? [`stale_at: ${yamlString(iso(input.staleAtMs))}`]
      : []),
    "---",
    "",
  ];

  const source = input.channelName ? `#${markdownLine(input.channelName)}` : "Chats";
  const notice =
    state === "stale"
      ? `> Saved from ${source}. This read-only copy is stale because source access is no longer available.`
      : input.mode === "snapshot"
        ? `> Saved from ${source} as a read-only snapshot on ${iso(input.snapshotAtMs!)}.`
        : `> Saved from ${source}. This read-only copy is maintained by dohc.`;

  const body = [`# ${markdownLine(input.title)}`, "", notice, ""];
  for (const message of input.messages) {
    body.push(`## ${agentLabel(message)}`);
    body.push("");
    body.push(`_${iso(message.createdAtMs)}_`);
    if (message.parentMessageId) {
      body.push("");
      body.push(`Reply to message ${markdownLine(message.parentMessageId)}`);
    }
    body.push("");
    body.push(message.body);
    body.push("");
  }

  return `${[...frontmatter, ...body].join("\n").trimEnd()}\n`;
}
