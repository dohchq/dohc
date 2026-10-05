import {afterEach, expect, it} from "vitest";
import {cleanupLiveDeliveryFixtures, registered} from "../../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport.js";

afterEach(cleanupLiveDeliveryFixtures);

it("keeps repeated stored snapshots independent and validates changed bytes on the next cut", () => {
  const f = registered({deployment: true});
  try {
    for (let index = 0; index < 3; index++) {
      const input = f.capture(f.update("status", `value-${index}`), `snapshot-${index}`);
      expect(f.storage.commitLiveUpdateJournal({...input, trustedAccount: {accountId: "owner", name: "Owner"},
        metadata: {...input.metadata, authorContext: {kind: "account", accountId: "owner"}}}).result.kind).toBe("accepted");
    }
    const document = f.input.evidence.document;
    const read = f.storage.readLiveUpdateJournalCut({document});
    if (read.kind !== "cut") throw new Error("Expected cut");
    expect(read.cut.suffix).toHaveLength(3);
    const first = read.cut.suffix[0]!.metadata.authorSnapshot![0]!;
    if (first.kind !== "human") throw new Error("Expected human credit");
    (first as {humanName: string}).humanName = "Changed by caller";
    expect(read.cut.suffix[1]!.metadata.authorSnapshot).toEqual([{kind: "human", humanId: "owner", humanName: "Owner"}]);
    const changed = [{kind: "human", humanId: "owner", humanName: "Renamed"}];
    f.write(db => db.prepare("UPDATE sync_relay_live_update_journal SET author_snapshot_json=? WHERE delivery_id='snapshot-2'").run(JSON.stringify(changed)));
    const next = f.storage.readLiveUpdateJournalCut({document});
    if (next.kind !== "cut") throw new Error("Expected next cut");
    expect(next.cut.suffix[2]!.metadata.authorSnapshot).toEqual(changed);
    expect(next.cut.suffix[0]!.metadata.authorSnapshot).toEqual([{kind: "human", humanId: "owner", humanName: "Owner"}]);
  } finally {f.close();}
});

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
      ["author_snapshot_json", JSON.stringify([{kind: "human", humanId: "owner", humanName: "Owner"},
        {kind: "agent", agentId: '"'.repeat(512), agentName: '"'.repeat(512), onBehalfOf: '"'.repeat(512)}])],
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

it("refuses non-canonical coverage on a stored checkpoint", () => {
  const f = registered({deployment: true});
  try {
    const large = f.update("payload", "x".repeat(1_048_576));
    for (let index = 0; index < 20; index++) {
      expect(f.storage.commitLiveUpdateJournal(f.capture(large, `checkpoint-${index}`)).result.kind).toBe("accepted");
    }
    const document = f.input.evidence.document;
    const original = f.storage.readLiveUpdateJournalCut({document});
    if (original.kind !== "cut") throw new Error("Expected checkpoint cut");
    expect(original.cut.checkpoint.cursor).not.toBeNull();
    expect(original.cut.checkpoint.metadata?.checkpointCoverage).toEqual([]);
    expect(original.cut.suffix).toEqual([]);
    const coverage = JSON.stringify([{author: {kind: "human", humanId: "owner", humanName: "Owner"},
      structRanges: [{clientId: 999, startClock: 5, endClock: 6}, {clientId: 999, startClock: 0, endClock: 1}], deletionRanges: []}]);
    f.write(db => db.prepare("UPDATE sync_relay_live_update_journal SET checkpoint_coverage_json=? WHERE journal_cursor=?")
      .run(coverage, original.cut.checkpoint.cursor));
    expect(() => f.storage.readLiveUpdateJournalCut({document})).toThrow("Invalid live application range.");
    f.write(db => db.prepare("UPDATE sync_relay_live_update_journal SET checkpoint_coverage_json=? WHERE journal_cursor=?")
      .run(JSON.stringify(original.cut.checkpoint.metadata!.checkpointCoverage), original.cut.checkpoint.cursor));
    expect(f.storage.readLiveUpdateJournalCut({document})).toEqual(original);
  } finally {f.close();}
}, 120_000);

it.each([{coverage: []}, {coverage: [{author: {kind: "human", humanId: "owner", humanName: "Owner"},
  structRanges: [{clientId: 999, startClock: 0, endClock: 1}], deletionRanges: []}]}])(
  "refuses canonical checkpoint coverage without a checkpoint: $coverage", ({coverage}) => {
    const f = registered({deployment: true});
    try {
      expect(f.storage.commitLiveUpdateJournal(f.capture(f.update(), "suffix")).result.kind).toBe("accepted");
      const document = f.input.evidence.document;
      const original = f.storage.readLiveUpdateJournalCut({document});
      if (original.kind !== "cut") throw new Error("Expected suffix cut");
      expect(original.cut.checkpoint.cursor).toBeNull();
      expect(original.cut.suffix).toHaveLength(1);
      expect(original.cut.suffix[0]!.metadata.checkpointCoverage).toBeUndefined();
      f.write(db => db.prepare("UPDATE sync_relay_live_update_journal SET checkpoint_coverage_json=? WHERE delivery_id='suffix'")
        .run(JSON.stringify(coverage)));
      expect(() => f.storage.readLiveUpdateJournalCut({document})).toThrow();
      f.write(db => db.prepare("UPDATE sync_relay_live_update_journal SET checkpoint_coverage_json=NULL WHERE delivery_id='suffix'").run());
      expect(f.storage.readLiveUpdateJournalCut({document})).toEqual(original);
    } finally {f.close();}
  });
