import { open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DurableFileOperations } from "../atomicReplaceFile";
import { createTestScratch } from "../workspaces/testTemp";
import {
  createChatWakeIntents,
  ChatWakeIntentsUnreadableError,
  type ChatWakeIntent,
} from "./chatWakeIntents";

const intent: ChatWakeIntent = {
  account: "https://dohc.test#https://relay.test#ana",
  userId: "ana",
  installId: "mac",
  wakeId: `wake-${"a".repeat(32)}`,
  generation: 1,
  workspaceId: "ws",
  threadId: "t1",
  messageId: "m1",
  prerequisiteMessageId: null,
  candidate: { installId: "mac", agentId: "default", label: "Mac", matched: { handle: "claude" } },
  phase: "claim-pending",
};

const scratchFile = async () =>
  join(await createTestScratch("chat-wake-intents-"), "state", "chat-wakes.json");

type OpenFile = NonNullable<DurableFileOperations["open"]>;

/** Opens real files, and fails the fsync of the temporary file ("w") or of its folder ("r"). */
const failingSync =
  (flagsToFail: "w" | "r"): OpenFile =>
  async (path, flags, mode) => {
    const handle = await open(path, flags, mode);
    return {
      writeFile: (data: string) => handle.writeFile(data),
      close: () => handle.close(),
      sync: async () => {
        if (flags === flagsToFail) throw new Error("fsync failed");
        await handle.sync();
      },
    };
  };

describe("saved chat wakes", () => {
  it("saves, replaces by account, computer, and wake, and removes", async () => {
    const file = await scratchFile();
    const intents = createChatWakeIntents(file);
    const otherAccount = {
      ...intent,
      account: "https://dohc.test#https://relay.test#ben",
      userId: "ben",
    };
    const otherInstall = { ...intent, installId: "old-install" };
    await Promise.all([
      intents.save(intent),
      intents.save(otherAccount),
      intents.save(otherInstall),
    ]);
    await intents.save({ ...intent, phase: "won" });
    expect(await intents.list()).toEqual([{ ...intent, phase: "won" }, otherAccount, otherInstall]);
    await intents.remove(intent);
    expect(await createChatWakeIntents(file).list()).toEqual([otherAccount, otherInstall]);
  });

  it("keeps no credentials or message text: a row with another field can't be read", async () => {
    const file = await scratchFile();
    await createChatWakeIntents(file).save(intent);
    const text = JSON.stringify([{ ...intent, body: "hello" }]);
    await writeFile(file, text);
    const intents = createChatWakeIntents(file);
    await expect(intents.list()).rejects.toBeInstanceOf(ChatWakeIntentsUnreadableError);
    await expect(intents.save(intent)).rejects.toBeInstanceOf(ChatWakeIntentsUnreadableError);
    expect(await readFile(file, "utf8")).toBe(text);
  });

  it("never replaces a corrupt file with an empty list", async () => {
    const file = await scratchFile();
    await createChatWakeIntents(file).save(intent);
    await writeFile(file, "{broken");
    const intents = createChatWakeIntents(file);
    await expect(intents.remove(intent)).rejects.toBeInstanceOf(ChatWakeIntentsUnreadableError);
    await expect(intents.save(intent)).rejects.toBeInstanceOf(ChatWakeIntentsUnreadableError);
    expect(await readFile(file, "utf8")).toBe("{broken");
  });

  it.each<[string, DurableFileOperations]>([
    [
      "the rename",
      {
        rename: async () => {
          throw new Error("rename failed");
        },
      },
    ],
    ["the file's fsync", { open: failingSync("w"), platform: "linux" }],
  ])("keeps the saved file when %s fails", async (_name, operations) => {
    const file = await scratchFile();
    await createChatWakeIntents(file).save(intent);
    const before = await readFile(file, "utf8");
    await expect(
      createChatWakeIntents(file, operations).save({ ...intent, phase: "won" }),
    ).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("reports a failed folder fsync, so nothing that waits on the save goes ahead", async () => {
    const file = await scratchFile();
    await expect(
      createChatWakeIntents(file, { open: failingSync("r"), platform: "linux" }).save(intent),
    ).rejects.toThrow("fsync failed");
  });
});
