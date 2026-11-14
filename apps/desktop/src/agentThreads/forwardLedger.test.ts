import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ForwardLedgerUnreadableError,
  createForwardLedger,
  type ForwardRow,
} from "./forwardLedger";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function ledgerFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dohc-forward-ledger-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "state", "agent-thread-forwards.json");
}

const row = (over: Partial<ForwardRow> = {}): ForwardRow => ({
  workspaceId: "ws-1",
  agentId: "chief",
  chatThreadId: "thread-a",
  toolThreadId: "t3-1",
  messageId: "m1",
  afterOrder: 3,
  forwardedAtMs: 1_000,
  runId: "run-1",
  reminder: { state: "none" },
  ...over,
});

describe("the ledger of forwarded messages", () => {
  it("is empty before anything is saved, and keeps what is saved across a restart", async () => {
    const file = await ledgerFile();
    const ledger = createForwardLedger(file);
    expect(await ledger.list()).toEqual([]);

    await ledger.put(row());
    await ledger.put(row({ chatThreadId: "thread-b", messageId: "m2" }));

    expect(await createForwardLedger(file).list()).toEqual([
      row(),
      row({ chatThreadId: "thread-b", messageId: "m2" }),
    ]);
  });

  it("keeps one row for an agent in a chat thread: the newest", async () => {
    const ledger = createForwardLedger(await ledgerFile());
    await ledger.put(row());
    await ledger.put(row({ agentId: "scout" }));

    await ledger.put(row({ messageId: "m2", reminder: { state: "recorded", atMs: 2_000 } }));

    expect(await ledger.list()).toEqual([
      row({ agentId: "scout" }),
      row({ messageId: "m2", reminder: { state: "recorded", atMs: 2_000 } }),
    ]);
  });

  it("removes a row only while it is still for the same message", async () => {
    const ledger = createForwardLedger(await ledgerFile());
    await ledger.put(row({ messageId: "m2" }));

    await ledger.remove(row({ messageId: "m1" }));
    expect(await ledger.list()).toHaveLength(1);

    await ledger.remove(row({ messageId: "m2" }));
    expect(await ledger.list()).toEqual([]);
  });

  it("removes every row that matches", async () => {
    const ledger = createForwardLedger(await ledgerFile());
    await ledger.put(row());
    await ledger.put(row({ workspaceId: "ws-2" }));

    await ledger.removeWhere((entry) => entry.workspaceId === "ws-1");

    expect((await ledger.list()).map((entry) => entry.workspaceId)).toEqual(["ws-2"]);
  });

  it("runs its changes in order", async () => {
    const ledger = createForwardLedger(await ledgerFile());

    await Promise.all([
      ledger.put(row()),
      ledger.put(row({ chatThreadId: "thread-b" })),
      ledger.remove(row()),
      ledger.put(row({ chatThreadId: "thread-c" })),
    ]);

    expect((await ledger.list()).map((entry) => entry.chatThreadId)).toEqual([
      "thread-b",
      "thread-c",
    ]);
  });

  it("refuses a file it cannot read as rows, and leaves the file as it is", async () => {
    const file = await ledgerFile();
    const ledger = createForwardLedger(file);
    await ledger.put(row());
    for (const damaged of [
      "{ not json",
      JSON.stringify([{ ...row(), reminder: { state: "twice" } }]),
    ]) {
      await writeFile(file, damaged);

      await expect(ledger.list()).rejects.toBeInstanceOf(ForwardLedgerUnreadableError);
      await expect(ledger.put(row())).rejects.toBeInstanceOf(ForwardLedgerUnreadableError);
      expect(await readFile(file, "utf8")).toBe(damaged);
    }
  });
});
