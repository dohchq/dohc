import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestScratch } from "../workspaces/testTemp";
import { createRunNowIntents, type RunNowIntent } from "./runNowIntents";

const intent = (noticeId: string): RunNowIntent => ({
  notice: { store: "account", noticeId },
  account: "https://server.test#ana",
  workspaceId: "ws",
  automationId: "collection:Reports#weekday",
});

describe("Run now intents", () => {
  it("keeps each begun Run now across a restart until it is taken away", async () => {
    const file = join(await createTestScratch("dohc-run-now-"), "state", "run-now.json");
    const first = createRunNowIntents(file);
    expect(await first.list(), "none before the first").toEqual([]);
    await first.save(intent("a"));
    await first.save(intent("b"));
    await first.save({ ...intent("a"), account: null });

    // As after a crash: a new start reads the same file.
    const restarted = createRunNowIntents(file);
    expect(await restarted.list()).toEqual([intent("b"), { ...intent("a"), account: null }]);
    await restarted.remove({ store: "account", noticeId: "b" });
    await restarted.remove({ store: "local", noticeId: "a" });
    expect(await restarted.list(), "only the same store and id goes").toEqual([{ ...intent("a"), account: null }]);
  });

  it("reads past a damaged file or entry", async () => {
    const file = join(await createTestScratch("dohc-run-now-"), "run-now.json");
    const intents = createRunNowIntents(file);
    await writeFile(file, "{");
    expect(await intents.list()).toEqual([]);
    await writeFile(file, JSON.stringify([intent("a"), { notice: { store: "elsewhere", noticeId: "b" } }]));
    expect(await intents.list()).toEqual([intent("a")]);
  });
});
