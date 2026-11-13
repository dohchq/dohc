import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CHAT_WAKE_ID, ChatWakeCandidate } from "@dohc/workspace-contracts/chat-wakes";
import { z } from "zod";
import { atomicWriteFile, type DurableFileOperations } from "../atomicReplaceFile";

// What this computer owes for each chat wake it decided to claim, saved in
// the desktop's state folder before each step with an effect outside it. It
// holds IDs and the frozen candidate only: no credentials and no message text.
//
// claim-pending: the claim may have been sent; its answer is not saved.
// won: the relay said this computer won; the local trigger may not exist yet.
// recorded: the local trigger exists durably; the relay may not have heard.

const Id = z.string().min(1).max(1_024);

const ChatWakeIntent = z.strictObject({
  /** The account scope: server, relay, and user, as chatShareSessionKey names it. */
  account: z.string().min(1).max(4_096),
  userId: Id,
  installId: z.string().min(1).max(256),
  wakeId: z.string().regex(CHAT_WAKE_ID),
  generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  workspaceId: Id,
  threadId: Id,
  messageId: Id,
  prerequisiteMessageId: Id.nullable(),
  candidate: ChatWakeCandidate,
  phase: z.enum(["claim-pending", "won", "recorded"]),
});
export type ChatWakeIntent = z.infer<typeof ChatWakeIntent>;

const ChatWakeIntentFile = z.array(ChatWakeIntent);

/** The saved wakes could not be read. The file stays as it is until a person or a fixed build reads it. */
export class ChatWakeIntentsUnreadableError extends Error {
  constructor() {
    super("dohc could not read the chat wakes it saved on this computer.");
    this.name = "ChatWakeIntentsUnreadableError";
  }
}

export interface ChatWakeIntents {
  list(): Promise<ChatWakeIntent[]>;
  /** Replaces the intent with the same account, computer, and wake. */
  save(intent: ChatWakeIntent): Promise<void>;
  remove(intent: ChatWakeIntent): Promise<void>;
}

const same = (a: ChatWakeIntent, b: ChatWakeIntent) =>
  a.account === b.account && a.installId === b.installId && a.wakeId === b.wakeId;

/**
 * Every read, change, and write runs after the one before it settles. A write
 * that fails before its rename leaves the file as it was. A failed directory
 * sync can leave the new contents in place although the write rejected, so a
 * caller trusts a row it reads back only after saving it again.
 */
export function createChatWakeIntents(file: string, operations?: DurableFileOperations): ChatWakeIntents {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work);
    queue = result.catch(() => undefined);
    return result;
  };
  const read = async (): Promise<ChatWakeIntent[]> => {
    let text: string;
    try { text = await readFile(file, "utf8"); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    let value: unknown;
    try { value = JSON.parse(text); }
    catch { throw new ChatWakeIntentsUnreadableError(); }
    const rows = ChatWakeIntentFile.safeParse(value);
    if (!rows.success) throw new ChatWakeIntentsUnreadableError();
    return rows.data;
  };
  const write = async (rows: ChatWakeIntent[]) => {
    await mkdir(dirname(file), { recursive: true });
    await atomicWriteFile(file, JSON.stringify(rows) + "\n", operations);
  };
  return {
    list: () => serial(read),
    save: (intent) => serial(async () => {
      const rows = await read();
      const at = rows.findIndex((row) => same(row, intent));
      await write(at === -1 ? [...rows, intent] : rows.with(at, intent));
    }),
    remove: (intent) => serial(async () => {
      const rows = await read();
      if (rows.some((row) => same(row, intent))) await write(rows.filter((row) => !same(row, intent)));
    }),
  };
}
