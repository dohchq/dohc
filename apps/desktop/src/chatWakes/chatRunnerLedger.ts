import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CHAT_RUNNER_INSTALL_ID_MAX_CHARS } from "@dohc/workspace-contracts/chat-wakes";
import { z } from "zod";
import { atomicWriteFile, type DurableFileOperations } from "../atomicReplaceFile";

// Each workspace this computer has told the server about its agents, by
// account and install, saved in the desktop's state folder before the
// declaration goes out. A withdrawal takes its row away only once the server
// confirms it. So a withdrawal that failed, offline or at sign-out, is tried
// again the next time that account signs in here, and never with another
// account's sign-in. It holds IDs only: no credentials.

const ChatRunnerLedgerEntry = z.strictObject({
  /** The account scope, as chatShareSessionKey names it. */
  account: z.string().min(1).max(4_096),
  installId: z.string().min(1).max(CHAT_RUNNER_INSTALL_ID_MAX_CHARS),
  workspaceId: z.string().min(1).max(1_024),
});
export type ChatRunnerLedgerEntry = z.infer<typeof ChatRunnerLedgerEntry>;

/** The saved declarations could not be read. Nothing is declared until it can be, and the file is left as it is. */
export class ChatRunnerLedgerUnreadableError extends Error {
  constructor(cause?: unknown) {
    super("dohc could not read which workspaces this computer declared its agents for.", { cause });
    this.name = "ChatRunnerLedgerUnreadableError";
  }
}

export interface ChatRunnerLedger {
  list(): Promise<ChatRunnerLedgerEntry[]>;
  add(entry: ChatRunnerLedgerEntry): Promise<void>;
  remove(entry: ChatRunnerLedgerEntry): Promise<void>;
}

const same = (a: ChatRunnerLedgerEntry, b: ChatRunnerLedgerEntry) =>
  a.account === b.account && a.installId === b.installId && a.workspaceId === b.workspaceId;

/** Every read, change, and write runs after the one before it settles. */
export function createChatRunnerLedger(
  file: string,
  operations?: DurableFileOperations,
): ChatRunnerLedger {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work);
    queue = result.catch(() => undefined);
    return result;
  };
  const read = async (): Promise<ChatRunnerLedgerEntry[]> => {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      // An existing file it can't open, such as EACCES or EISDIR, needs the same repair as a damaged one.
      throw new ChatRunnerLedgerUnreadableError(error);
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new ChatRunnerLedgerUnreadableError();
    }
    const rows = z.array(ChatRunnerLedgerEntry).safeParse(value);
    if (!rows.success) throw new ChatRunnerLedgerUnreadableError();
    return rows.data;
  };
  const write = async (rows: ChatRunnerLedgerEntry[]) => {
    await mkdir(dirname(file), { recursive: true });
    await atomicWriteFile(file, JSON.stringify(rows) + "\n", operations);
  };
  return {
    list: () => serial(read),
    add: (entry) =>
      serial(async () => {
        const rows = await read();
        if (!rows.some((row) => same(row, entry))) await write([...rows, entry]);
      }),
    remove: (entry) =>
      serial(async () => {
        const rows = await read();
        if (rows.some((row) => same(row, entry)))
          await write(rows.filter((row) => !same(row, entry)));
      }),
  };
}
