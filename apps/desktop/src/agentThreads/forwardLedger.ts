import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { atomicWriteFile, type DurableFileOperations } from "../atomicReplaceFile";

// The forwarded messages an agent has not answered yet, saved in the
// desktop's state folder, so the line in chat and the one reminder survive a
// restart. One row for each agent in each chat thread: a newer message there
// takes the older one's place. It holds ids and times only, no message text.

const ForwardRow = z.strictObject({
  workspaceId: z.string().min(1).max(1_024),
  agentId: z.string().min(1).max(64),
  /** The chat thread the message is in, by its engine id. */
  chatThreadId: z.string().min(1).max(1_024),
  /** The agent's thread in its tool, as it was when the message went. */
  toolThreadId: z.string().min(1).max(512),
  messageId: z.string().min(1).max(1_024),
  /** The chat thread's last message order when the message went. A reply comes after it. */
  afterOrder: z.number().int().min(-1),
  forwardedAtMs: z.number().int().nonnegative(),
  /** The tool's id for the work the message started, when it gave one. */
  runId: z.string().min(1).max(512).nullable(),
  /**
   * The reminder for work that ended with no reply. `recorded` is written
   * before the reminder goes, so a restart between the two never sends a second.
   */
  reminder: z.discriminatedUnion("state", [
    z.strictObject({ state: z.literal("none") }),
    z.strictObject({ state: z.literal("recorded"), atMs: z.number().int().nonnegative() }),
    z.strictObject({
      state: z.literal("sent"),
      runId: z.string().min(1).max(512).nullable(),
      atMs: z.number().int().nonnegative(),
    }),
  ]),
});
export type ForwardRow = z.infer<typeof ForwardRow>;

/** The saved rows could not be read. Nothing is shown or reminded until they can be, and the file is left as it is. */
export class ForwardLedgerUnreadableError extends Error {
  constructor(cause?: unknown) {
    super("dohc could not read which forwarded messages wait for an answer.", { cause });
    this.name = "ForwardLedgerUnreadableError";
  }
}

export interface ForwardLedger {
  list(): Promise<ForwardRow[]>;
  /** Saves the row in place of the one for its agent and chat thread. */
  put(row: ForwardRow): Promise<void>;
  /** Removes the row for this agent and chat thread, only while it is still for `messageId`. */
  remove(
    row: Pick<ForwardRow, "workspaceId" | "agentId" | "chatThreadId" | "messageId">,
  ): Promise<void>;
  /** Removes every row of a workspace, or of one agent in every workspace. */
  removeWhere(match: (row: ForwardRow) => boolean): Promise<void>;
}

const sameSlot = (
  a: Pick<ForwardRow, "workspaceId" | "agentId" | "chatThreadId">,
  b: Pick<ForwardRow, "workspaceId" | "agentId" | "chatThreadId">,
) =>
  a.workspaceId === b.workspaceId && a.agentId === b.agentId && a.chatThreadId === b.chatThreadId;

// More rows than this means something is wrong. The oldest give way.
export const MAX_FORWARD_ROWS = 2_000;

/** Every read, change, and write runs after the one before it settles. */
export function createForwardLedger(
  file: string,
  operations?: DurableFileOperations,
): ForwardLedger {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work);
    queue = result.catch(() => undefined);
    return result;
  };
  const read = async (): Promise<ForwardRow[]> => {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw new ForwardLedgerUnreadableError(error);
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new ForwardLedgerUnreadableError();
    }
    const rows = z.array(ForwardRow).safeParse(value);
    if (!rows.success) throw new ForwardLedgerUnreadableError();
    return rows.data;
  };
  const write = async (rows: ForwardRow[]) => {
    await mkdir(dirname(file), { recursive: true });
    await atomicWriteFile(file, JSON.stringify(rows.slice(-MAX_FORWARD_ROWS)) + "\n", operations);
  };
  return {
    list: () => serial(read),
    put: (row) =>
      serial(async () => {
        const rows = await read();
        await write([...rows.filter((other) => !sameSlot(other, row)), ForwardRow.parse(row)]);
      }),
    remove: (row) =>
      serial(async () => {
        const rows = await read();
        const kept = rows.filter(
          (other) => !(sameSlot(other, row) && other.messageId === row.messageId),
        );
        if (kept.length !== rows.length) await write(kept);
      }),
    removeWhere: (match) =>
      serial(async () => {
        const rows = await read();
        const kept = rows.filter((row) => !match(row));
        if (kept.length !== rows.length) await write(kept);
      }),
  };
}
