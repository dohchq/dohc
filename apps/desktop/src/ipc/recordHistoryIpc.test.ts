import { describe, expect, it, vi } from "vitest";
import type { CollectionGetRecordResult } from "@dohc/workspace-contracts";
import { recordHistoryForIpc, type RecordHistoryAuthors } from "./recordHistoryIpc";

const change = (actorKind: "human" | "agent"): CollectionGetRecordResult["history"][number] => ({
  historyId: 1, field: "Status", previous: { present: true, value: "Open" }, next: { present: true, value: "Done" },
  recordedAtMs: 1, actorKind, authorOriginId: actorKind === "human" ? "ana" : "helper", onBehalfOf: "ana", depth: 0, automationRun: null,
});
const names = (): RecordHistoryAuthors => ({
  person: id => id === "ana" ? "Ana" : null,
  agent: () => "Agent", automationName: () => null, runAvailable: async () => false,
});

describe("Record History live authors", () => {
  it("names a confirmed person", async () => {
    const page = await recordHistoryForIpc({ history: [change("human")], nextBeforeHistoryId: null }, names());
    expect(page.entries[0]?.author).toEqual({ kind: "human", name: "Ana" });
  });
  it("names an agent with the person it acted for", async () => {
    const page = await recordHistoryForIpc({ history: [change("agent")], nextBeforeHistoryId: null }, names());
    expect(page.entries[0]?.author).toEqual({ kind: "agent", name: "Agent", person: "Ana" });
  });
  it("prepares each person's name once for the whole page", async () => {
    const prepare = vi.fn();
    const person = vi.fn(names().person);
    await recordHistoryForIpc({ history: [change("human"), change("agent"), change("human")], nextBeforeHistoryId: null }, { ...names(), person, prepare });
    expect(prepare).toHaveBeenCalledExactlyOnceWith(["ana"]);
    expect(person).toHaveBeenCalledExactlyOnceWith("ana");
  });
});
