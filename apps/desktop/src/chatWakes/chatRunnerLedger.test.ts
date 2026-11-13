import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestScratch } from "../workspaces/testTemp";
import { ChatRunnerLedgerUnreadableError, createChatRunnerLedger, type ChatRunnerLedgerEntry } from "./chatRunnerLedger";

const scratchFile = async () => join(await createTestScratch("chat-runners-"), "state", "chat-runners.json");
const entry = (account: string, workspaceId: string): ChatRunnerLedgerEntry => ({ account, installId: "mac", workspaceId });

describe("the declarations ledger", () => {
  it("keeps one row per account, install, and workspace, and removes only its own", async () => {
    const file = await scratchFile();
    const ledger = createChatRunnerLedger(file);
    await ledger.add(entry("A", "ws1"));
    await ledger.add(entry("A", "ws1"));
    await ledger.add(entry("B", "ws1"));
    await ledger.remove(entry("A", "ws1"));
    expect(await createChatRunnerLedger(file).list()).toEqual([entry("B", "ws1")]);
  });

  it("refuses a file with a field it doesn't know, and never writes over it", async () => {
    const file = await scratchFile();
    const ledger = createChatRunnerLedger(file);
    await ledger.add(entry("A", "ws1"));
    const token = JSON.stringify([{ ...entry("A", "ws1"), token: "secret" }]);
    await writeFile(file, token);
    await expect(ledger.list()).rejects.toThrow("dohc could not read which workspaces");
    await expect(ledger.add(entry("A", "ws2"))).rejects.toThrow("dohc could not read which workspaces");
    expect(await readFile(file, "utf8")).toBe(token);
  });

  it("reports a file it can't open as unreadable, and reads it again once repaired", async () => {
    const file = await scratchFile();
    await mkdir(file, { recursive: true });
    const ledger = createChatRunnerLedger(file);
    await expect(ledger.list()).rejects.toBeInstanceOf(ChatRunnerLedgerUnreadableError);
    await expect(ledger.add(entry("A", "ws1"))).rejects.toBeInstanceOf(ChatRunnerLedgerUnreadableError);
    await rm(file, { recursive: true });
    await writeFile(file, JSON.stringify([entry("A", "ws1")]));
    expect(await ledger.list()).toEqual([entry("A", "ws1")]);
  });
});
