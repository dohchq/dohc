import {createLiveBufferBudget, LiveConnectionLimitError} from "@dohc/live-session-contract/live-connection";
import {afterEach, expect, it} from "vitest";
import {cleanupLiveDeliveryFixtures, registered} from "../../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport.js";

afterEach(cleanupLiveDeliveryFixtures);

it("refuses corrupted stored snapshots, nonempty seed coverage and deletion ranges", () => {
  const f = registered({deployment: true});
  try {
    for (let index = 0; index < 2; index++) {
      const input = f.capture(f.update("status", `value-${index}`), `corrupt-${index}`);
      expect(f.storage.commitLiveUpdateJournal({...input, trustedAccount: {accountId: "owner", name: "Owner"},
        metadata: {...input.metadata, authorContext: {kind: "account", accountId: "owner"}}}).result.kind).toBe("accepted");
    }
    const original = f.raw.prepare("SELECT * FROM sync_relay_live_update_journal WHERE delivery_id='corrupt-1'").get()!;
    const document = f.input.evidence.document;
    for (const [column, damaged] of [
      ["author_snapshot_json", JSON.stringify([{kind: "automation", automationId: '"'.repeat(512),
        attribution: {actorKind: "automation", depth: 1, onBehalfOf: '"'.repeat(512),
          run: {claimId: '"'.repeat(512), automationName: '"'.repeat(1024)}}}])],
      ["author_snapshot_json", JSON.stringify([{kind: "agent", agentId: "agent"}, {kind: "human", humanId: "owner", humanName: "Owner"}])],
      ["seed_first_seen_json", JSON.stringify([{clientId: 999, startClock: 0, endClock: 1}])],
      ["first_seen_deletes_json", JSON.stringify([{clientId: 999, startClock: -1, endClock: 1}])],
    ] as const) {
      f.write(db => db.prepare(`UPDATE sync_relay_live_update_journal SET ${column}=? WHERE delivery_id='corrupt-1'`).run(damaged));
      expect(() => f.storage.readLiveUpdateJournalCut({document})).toThrow();
      f.write(db => db.prepare(`UPDATE sync_relay_live_update_journal SET ${column}=? WHERE delivery_id='corrupt-1'`).run(original[column] as string | null));
      expect(f.storage.readLiveUpdateJournalCut({document}).kind).toBe("cut");
    }
  } finally {f.close();}
});

it("charges journal bytes before materializing the cut", () => {
  const f = registered({deployment: true});
  try {
    const document = f.input.evidence.document;
    const budget = createLiveBufferBudget(1);
    expect(() => f.storage.readLiveUpdateJournalCut({document}, budget.reserve)).toThrowError(LiveConnectionLimitError);
    expect(budget.usage()).toBe(0);
    let charge = 0;
    const read = f.storage.readLiveUpdateJournalCut({document}, size => {charge = size;});
    expect(read.kind).toBe("cut");
    expect(charge).toBeGreaterThan(1);
  } finally {f.close();}
});
