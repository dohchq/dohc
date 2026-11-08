import { describe, expect, it, vi } from "vitest";
import type { CollectionGetRecordResult } from "@dohc/workspace-contracts";
import { recordHistoryForIpc, type RecordHistoryAuthors } from "./recordHistoryIpc";
import { GetCollectionRecordHistoryResult } from "./bridgeContract";
import { createHistoryLabels } from "../automations/shareRoster";

const change = (actorKind: "human" | "agent"): CollectionGetRecordResult["history"][number] => ({
  historyId: 1, field: "Status", previous: { present: true, value: "Open" }, next: { present: true, value: "Done" },
  recordedAtMs: 1, actorKind, authorOriginId: actorKind === "human" ? "ana" : "helper", onBehalfOf: "ana", depth: 0, automationRun: null, linkAuthor: null,
});
const names = (): RecordHistoryAuthors => ({
  prepare: () => {},
  person: id => id === "ana" ? "Ana" : null,
  agent: () => "Agent", automationName: () => null, runAvailable: async () => false,
});

describe("Record History live authors", () => {
  it("names the owner's Button press and automation on a recipient using real history labels", async () => {
    const labels = createHistoryLabels({
      snapshot: () => ({ roster: null, owner: false, context: "recipient", inventory: undefined,
        shareView: { granterUserId: "owner", sharerName: "Mira", granterEmail: "mira@example.test" } }),
      lookupAccounts: vi.fn(),
    });
    const page = await recordHistoryForIpc({ history: [
      { ...change("human"), actorKind: "automation", authorOriginId: "stamp", onBehalfOf: "owner",
        automationRun: { claimId: "button-press", automationName: "Stamp" } },
      { ...change("human"), historyId: 2, authorOriginId: "owner" },
    ], nextBeforeHistoryId: null }, { ...names(),
      prepare: ids => labels.prepare("received", ids.map(userId => ({ userId }))),
      person: id => labels.person("received", id),
    });
    expect(page.entries.map(entry => entry.author)).toEqual([
      { kind: "automation", automationId: "stamp", name: "Stamp", person: "Mira", run: { claimId: "button-press", location: "unchecked" } },
      { kind: "human", name: "Mira" },
    ]);
  });
  it.skipIf(process.env.DOHC_FIELD_HISTORY_COST !== "1")("measures preparation of a 50-link page", async () => {
    const history = Array.from({ length: 50 }, (_, historyId) => ({ ...change("human"), historyId, actorKind: null, authorOriginId: null, onBehalfOf: null,
      linkAuthor: { kind: "link" as const, grantId: "link", grantGeneration: 2, publicPrincipalId: `public-holder-${historyId}` } }));
    const page = { history, nextBeforeHistoryId: null };
    const authors = names();
    const samples: number[] = [];
    for (let sample = 0; sample < 35; sample++) {
      const start = performance.now();
      for (let batch = 0; batch < 100; batch++) GetCollectionRecordHistoryResult.parse(await recordHistoryForIpc(page, authors));
      if (sample >= 5) samples.push((performance.now() - start) * 1e6 / 100);
    }
    samples.sort((a, b) => a - b);
    process.stdout.write(`record_history_page_cost: rows=50 n=${samples.length} median_ns=${(samples[14]! + samples[15]!) / 2}\n`);
  });
  it("names a link without its ids or account lookups", async () => {
    const linkAuthor = { kind: "link" as const, grantId: "ended-link", grantGeneration: 2, publicPrincipalId: "public-holder" };
    const person = vi.fn();
    const prepare = vi.fn();
    const page = await recordHistoryForIpc({ history: [{ ...change("human"), actorKind: null, authorOriginId: null, onBehalfOf: null, linkAuthor }], nextBeforeHistoryId: null }, { ...names(), person, prepare });
    expect(page.entries[0]?.author).toEqual({ kind: "link" });
    expect(person).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledExactlyOnceWith([]);
  });
  it("keeps the relay-bound link agent without looking up the public principal as an account", async () => {
    const linkAuthor = { kind: "link" as const, grantId: "link", grantGeneration: 2, publicPrincipalId: "public-holder" };
    const person = vi.fn();
    const prepare = vi.fn();
    const agent = vi.fn(() => "Agent");
    const page = await recordHistoryForIpc({ history: [{ ...change("agent"), onBehalfOf: "public-holder", linkAuthor }], nextBeforeHistoryId: null }, { ...names(), person, prepare, agent });
    expect(page.entries[0]?.author).toEqual({ kind: "link", agentName: "Agent" });
    expect(GetCollectionRecordHistoryResult.parse(page)).toEqual(page);
    expect(() => GetCollectionRecordHistoryResult.parse({ ...page, entries: [{ ...page.entries[0], author: { kind: "link", principalId: "private-holder" } }] })).toThrow();
    expect(() => GetCollectionRecordHistoryResult.parse({ ...page, entries: [{ ...page.entries[0], author: { ...linkAuthor } }] })).toThrow();
    expect(person).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledExactlyOnceWith([]);
    expect(agent).toHaveBeenCalledExactlyOnceWith("helper", "public-holder");
  });
  it.each(["human", "agent"] as const)("keeps a %s row's local person unnamed and off account lookups", async actorKind => {
    const localId = "local:installation-1";
    const prepare = vi.fn();
    const person = vi.fn(() => "Someone you shared with");
    const row = { ...change(actorKind), onBehalfOf: localId, ...(actorKind === "human" ? { authorOriginId: localId } : {}) };
    const page = await recordHistoryForIpc({ history: [row], nextBeforeHistoryId: null }, { ...names(), person, prepare });
    expect.soft(page.entries[0]?.author).toEqual(actorKind === "human" ? null : { kind: "agent", name: "Agent" });
    expect.soft(prepare).toHaveBeenCalledExactlyOnceWith([]);
    expect(person).not.toHaveBeenCalled();
  });
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
