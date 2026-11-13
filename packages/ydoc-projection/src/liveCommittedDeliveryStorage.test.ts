import { afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { openSyncRelayStorage } from "../../../services/sync-relay/src/storage.js";
import {
  registered as registeredFixture,
  DatabaseSync,
  host,
  policy,
  cleanupLiveDeliveryFixtures,
} from "./liveCommittedDeliveryTestSupport.js";
afterEach(() => {
  vi.restoreAllMocks();
  cleanupLiveDeliveryFixtures();
});
import { createLiveJournalHistoryAuthority } from "../../../services/sync-relay/src/storage/liveJournalHistory.js";
import { liveDeliveryBookkeepingBytes } from "./liveDeliveryQuotaTestSupport.js";

function registered(...args: Parameters<typeof registeredFixture>) {
  const f = registeredFixture(...args);
  const history = createLiveJournalHistoryAuthority({
    namespace: "history-one",
    reconciled: true,
  });
  return {
    ...f,
    delivery: {
      history,
      store: f.storage.createLiveCommittedDeliveryStore(history),
    },
  };
}
function delivery(f: ReturnType<typeof registered>) {
  return f.delivery;
}
function ackBaseline(
  store: ReturnType<typeof delivery>["store"],
  drain: ReturnType<ReturnType<typeof delivery>["store"]["open"]>,
) {
  const next = store.next(drain);
  expect(next.kind).toBe("bootstrap");
  if (next.kind !== "bootstrap") throw Error("not bootstrap");
  const b = next.baseline;
  store.acknowledgeBootstrap(drain, {
    bootstrapId: b.bootstrapId,
    bootstrapMomentId: b.bootstrapMomentId,
    baselineDigest: b.baselineDigest,
    baselineMomentRelaySequence: b.baselineMomentRelaySequence,
    localYDocSequence: 0,
    bootstrapReplayed: false,
  });
}
it("reserves delivery before admission and completes acknowledgements at quota", () => {
  const quota = 1_000_000;
  const f = registered({ workspaceQuotaBytes: quota });
  try {
    const event = f.capture(f.update(), "reserved-event");
    expect(f.storage.commitLiveUpdateJournal(event).result.kind).toBe("accepted");
    const usage = () =>
      Number(
        f.raw
          .prepare(
            "SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id='workspace'",
          )
          .get()!.usage_bytes,
      );
    const reserved = () =>
      Number(
        f.raw
          .prepare(
            "SELECT COALESCE(SUM(reserved_bytes),0) AS total FROM sync_relay_live_delivery_reservations",
          )
          .get()!.total,
      );
    const charged = usage();
    expect(reserved()).toBeGreaterThan(0);
    expect(f.storage.commitLiveUpdateJournal(event).result).toMatchObject({
      kind: "accepted",
      replayed: true,
    });
    expect(usage()).toBe(charged);
    f.raw
      .prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=? WHERE workspace_id='workspace'")
      .run(quota);
    const { store } = delivery(f);
    const drain = store.open({ host, document: f.input.evidence.document });
    expect(usage()).toBe(quota);
    ackBaseline(store, drain);
    const next = store.next(drain);
    if (next.kind !== "next") throw Error("expected event");
    const ack = {
      ...next.admitted.metadata.accepted.receipt,
      localYDocSequence: 1,
      applicationReplayed: false,
    };
    store.acknowledge(drain, next.predecessor, ack);
    expect(store.next(drain).kind).toBe("done");
    expect(reserved()).toBe(0);
    expect(usage()).toBeLessThan(quota);
    const completedUsage = usage();
    store.acknowledge(drain, next.predecessor, ack);
    expect(usage()).toBe(completedUsage);
  } finally {
    f.close();
  }
});

it("refuses an event atomically when its delivery reservation does not fit", () => {
  const quota = 1_000_000;
  const f = registered({ workspaceQuotaBytes: quota });
  try {
    const event = f.capture(f.update(), "no-reservation-space");
    const path = `${f.path}.quota-probe`;
    f.raw.prepare("VACUUM INTO ?").run(path);
    const probe = openSyncRelayStorage(path),
      raw = new DatabaseSync(path);
    probe.createLiveCommittedDeliveryStore(
      createLiveJournalHistoryAuthority({ namespace: "history-one", reconciled: true }),
    );
    let journalCharge: number;
    try {
      const usage = () =>
        Number(
          raw
            .prepare(
              "SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id='workspace'",
            )
            .get()!.usage_bytes,
        );
      const beforeUsage = usage();
      const beforeDelivery = liveDeliveryBookkeepingBytes(raw);
      expect(probe.commitLiveUpdateJournal(event).result.kind).toBe("accepted");
      const deliveryCharge = liveDeliveryBookkeepingBytes(raw) - beforeDelivery;
      expect(deliveryCharge).toBeGreaterThan(0);
      journalCharge = usage() - beforeUsage - deliveryCharge;
    } finally {
      raw.close();
      probe.close();
    }
    f.raw
      .prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=? WHERE workspace_id='workspace'")
      .run(quota - journalCharge);
    const before = f.journalRows();
    expect(() => f.storage.commitLiveUpdateJournal(event)).toThrow(/quota/i);
    expect(f.journalRows()).toEqual(before);
    expect(
      f.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM sync_relay_live_delivery_reservations WHERE journal_cursor>0",
        )
        .get()!.count,
    ).toBe(0);
  } finally {
    f.close();
  }
});

it("refuses a missing reservation instead of repairing it during delivery or reconnect", () => {
  const f = registered();
  try {
    const event = f.capture(f.update());
    expect(f.storage.commitLiveUpdateJournal(event).result.kind).toBe("accepted");
    const { store } = delivery(f);
    const drain = store.open({ host, document: f.input.evidence.document });
    ackBaseline(store, drain);
    const next = store.next(drain);
    if (next.kind !== "next") throw Error("expected event");
    f.raw.exec("DELETE FROM sync_relay_live_delivery_reservations WHERE journal_cursor>0");
    expect(() =>
      store.acknowledge(drain, next.predecessor, {
        ...next.admitted.metadata.accepted.receipt,
        localYDocSequence: 1,
        applicationReplayed: false,
      }),
    ).toThrow(/reservation/i);
    expect(() => f.storage.registerLiveHost({ ...host, updatedAtMs: 40, guard() {} })).toThrow(
      /reservation/i,
    );
    expect(
      f.raw.prepare("SELECT COUNT(*) AS count FROM sync_relay_live_delivery_edges").get()!.count,
    ).toBe(0);
  } finally {
    f.close();
  }
});

it("refuses a changed history namespace after reopening", () => {
  const f = registered();
  let reopened: ReturnType<typeof openSyncRelayStorage> | undefined;
  let originalClosed = false;
  try {
    const { store } = delivery(f);
    const drain = store.open({ host, document: f.input.evidence.document });
    ackBaseline(store, drain);
    f.storage.close();
    originalClosed = true;
    reopened = openSyncRelayStorage(f.path);
    const foreign = reopened.createLiveCommittedDeliveryStore(
      createLiveJournalHistoryAuthority({ namespace: "foreign-history", reconciled: true }),
    );
    expect(() => foreign.open({ host, document: f.input.evidence.document })).toThrow(
      /reservation/i,
    );
    expect(
      f.raw.prepare("SELECT COUNT(*) AS count FROM sync_relay_live_delivery_bootstraps").get()!
        .count,
    ).toBe(1);
  } finally {
    reopened?.close();
    if (originalClosed) {
      f.doc.destroy();
      f.raw.close();
    } else f.close();
  }
});

it("shares persisted bootstrap identity and serializes acknowledgement edges across issued drains", () => {
  const f = registered();
  try {
    const empty = new Y.Doc(),
      noop = Y.encodeStateAsUpdate(empty);
    empty.destroy();
    const first = f.capture(noop, "first"),
      a = f.storage.commitLiveUpdateJournal(first);
    expect(a.result.kind).toBe("accepted");
    const second = f.capture(noop, "second"),
      b = f.storage.commitLiveUpdateJournal(second);
    expect(b.result.kind).toBe("accepted");
    const { store } = delivery(f),
      d = store.open({ host, document: f.input.evidence.document }),
      id = d.baseline.bootstrapId;
    const duplicate = store.open({ host, document: f.input.evidence.document });
    expect(duplicate.baseline.bootstrapId).toBe(id);
    ackBaseline(store, d);
    const one = store.next(d);
    expect(one.kind).toBe("next");
    if (one.kind !== "next") throw Error("next");
    const r = one.admitted.metadata.accepted.receipt;
    store.acknowledge(d, one.predecessor, {
      ...r,
      localYDocSequence: 1,
      applicationReplayed: false,
    });
    const two = store.next(duplicate);
    expect(two.kind).toBe("next");
    if (two.kind !== "next") throw Error("next");
    expect(two.admitted.metadata.accepted.receipt.deliveryId).toBe("second");
    store.acknowledge(duplicate, two.predecessor, {
      ...two.admitted.metadata.accepted.receipt,
      localYDocSequence: 2,
      applicationReplayed: false,
    });
    expect(store.next(d).kind).toBe("done");
    expect(
      f.raw.prepare("SELECT COUNT(*) n FROM sync_relay_live_delivery_bootstraps").get()!.n,
    ).toBe(1);
    expect(
      f.raw
        .prepare(
          "SELECT predecessor_cursor,journal_cursor FROM sync_relay_live_delivery_edges ORDER BY journal_cursor",
        )
        .all(),
    ).toEqual([
      { predecessor_cursor: 0, journal_cursor: 1 },
      { predecessor_cursor: 1, journal_cursor: 2 },
    ]);
  } finally {
    f.close();
  }
});
it("unreconciled trusted history refuses both preissued drains and captured admission", () => {
  const f = registered();
  try {
    const empty = new Y.Doc(),
      candidate = f.capture(Y.encodeStateAsUpdate(empty), "later");
    empty.destroy();
    const { store, history } = delivery(f),
      d = store.open({ host, document: f.input.evidence.document });
    const before = f.journalRows();
    history.markUnreconciled();
    expect(() => store.next(d)).toThrow("reconciliation");
    expect(() => f.storage.commitLiveUpdateJournal(candidate)).toThrow("reconciliation");
    expect(f.journalRows()).toEqual(before);
  } finally {
    f.close();
  }
});
it("refuses a skipped or conflicting ACK without advancing the durable prefix", () => {
  const f = registered();
  try {
    const empty = new Y.Doc(),
      noop = Y.encodeStateAsUpdate(empty);
    empty.destroy();
    for (const id of ["first", "second"])
      expect(f.storage.commitLiveUpdateJournal(f.capture(noop, id)).result.kind).toBe("accepted");
    const { store } = delivery(f),
      d = store.open({ host, document: f.input.evidence.document });
    ackBaseline(store, d);
    const second = f.storage.readCommittedLiveUpdate({
      host,
      document: f.input.evidence.document,
      journalCursor: 2,
    });
    if (second.kind !== "committed") throw Error("committed");
    expect(() =>
      store.acknowledge(d, null, {
        ...second.admitted.metadata.accepted.receipt,
        localYDocSequence: 2,
        applicationReplayed: false,
      }),
    ).toThrow();
    expect(f.raw.prepare("SELECT COUNT(*) n FROM sync_relay_live_delivery_edges").get()!.n).toBe(0);
    const first = store.next(d);
    if (first.kind !== "next") throw Error("next");
    const ack = {
      ...first.admitted.metadata.accepted.receipt,
      localYDocSequence: 1,
      applicationReplayed: false,
    };
    store.acknowledge(d, null, ack);
    store.acknowledge(d, null, { ...ack, applicationReplayed: true });
    expect(() => store.acknowledge(d, null, { ...ack, localYDocSequence: 9 })).toThrow();
    expect(f.raw.prepare("SELECT COUNT(*) n FROM sync_relay_live_delivery_edges").get()!.n).toBe(1);
  } finally {
    f.close();
  }
});
it.each(["before", "after"] as const)(
  "reopens standalone storage when relay edge COMMIT throws %s committing",
  (phase) => {
    const f = registered();
    let reopened: ReturnType<typeof openSyncRelayStorage> | undefined;
    let originalClosed = false;
    try {
      expect(f.storage.commitLiveUpdateJournal(f.capture(f.update(), "event")).result.kind).toBe(
        "accepted",
      );
      const { store } = delivery(f),
        d = store.open({ host, document: f.input.evidence.document });
      ackBaseline(store, d);
      const step = store.next(d);
      if (step.kind !== "next") throw Error("next");
      const ack = {
          ...step.admitted.metadata.accepted.receipt,
          localYDocSequence: 1,
          applicationReplayed: false,
        },
        usage = f.journalRows().usage;
      const original = DatabaseSync.prototype.exec;
      let armed = true;
      const spy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
        this: InstanceType<typeof DatabaseSync>,
        sql: string,
      ) {
        if (armed && sql === "COMMIT") {
          armed = false;
          if (phase === "after") original.call(this, sql);
          throw Error("injected uncertain edge commit");
        }
        return original.call(this, sql);
      });
      expect(() => store.acknowledge(d, step.predecessor, ack)).toThrow("uncertain edge commit");
      spy.mockRestore();
      expect(armed).toBe(false);
      expect(f.storage.unavailable.aborted).toBe(true);
      expect(() => store.next(d)).toThrow("unavailable");
      f.storage.close();
      originalClosed = true;
      // This fixture uses standalone storage and has no deployment continuity marker.
      reopened = openSyncRelayStorage(f.path);
      const restarted = reopened.createLiveCommittedDeliveryStore(
        createLiveJournalHistoryAuthority({ namespace: "history-one", reconciled: true }),
      );
      const resumed = restarted.open({ host, document: f.input.evidence.document });
      expect(resumed.baseline.bootstrapId).toBe(d.baseline.bootstrapId);
      expect(restarted.next(resumed).kind).toBe(phase === "after" ? "done" : "next");
      expect(f.raw.prepare("SELECT COUNT(*) n FROM sync_relay_live_delivery_edges").get()!.n).toBe(
        phase === "after" ? 1 : 0,
      );
      if (phase === "before") expect(f.journalRows().usage).toBe(usage);
      restarted.acknowledge(resumed, step.predecessor, {
        ...ack,
        applicationReplayed: true,
      });
      expect(restarted.next(resumed).kind).toBe("done");
    } finally {
      reopened?.close();
      if (originalClosed) {
        f.doc.destroy();
        f.raw.close();
      } else f.close();
    }
  },
);

it.each(["hostId", "hostEpoch"] as const)(
  "refuses a wrong host %s without issuing delivery authority",
  (field) => {
    const f = registered();
    try {
      const { store } = delivery(f);
      const changed = {
        ...host,
        [field]: field === "hostEpoch" ? 2 : "other",
      };
      expect(() => store.open({ host: changed, document: f.input.evidence.document })).toThrow();
      expect(
        f.raw.prepare("SELECT COUNT(*) n FROM sync_relay_live_delivery_bootstraps").get()!.n,
      ).toBe(0);
    } finally {
      f.close();
    }
  },
);

it("does not reinterpret a historical admission after the original client grant is revoked", () => {
  const f = registered();
  try {
    const actor = {
      kind: "named",
      userId: "reader",
      grantId: "grant",
    } as const;
    expect(
      f.storage.commitLiveUpdateJournal(f.capture(f.update(), "accepted-before-revocation", actor))
        .result.kind,
    ).toBe("accepted");
    f.raw.exec(
      "UPDATE sync_relay_share_grants SET status='revoked',revoked_at_ms=40 WHERE grant_id='grant'",
    );
    const { store } = delivery(f),
      d = store.open({ host, document: f.input.evidence.document });
    ackBaseline(store, d);
    const step = store.next(d);
    if (step.kind !== "next") throw Error("next");
    expect(step.admitted.metadata.accepted.receipt.deliveryId).toBe("accepted-before-revocation");
    store.acknowledge(d, null, {
      ...step.admitted.metadata.accepted.receipt,
      localYDocSequence: 1,
      applicationReplayed: false,
    });
    expect(store.next(d).kind).toBe("done");
  } finally {
    f.close();
  }
});

it("audits the complete acknowledged prefix again after reopening the relay store", () => {
  const f = registered();
  let reopened: ReturnType<typeof openSyncRelayStorage> | undefined;
  try {
    for (const id of ["first", "second"])
      expect(f.storage.commitLiveUpdateJournal(f.capture(f.update(id, id), id)).result.kind).toBe(
        "accepted",
      );
    const { store, history } = delivery(f),
      d = store.open({ host, document: f.input.evidence.document });
    ackBaseline(store, d);
    for (let sequence = 1; sequence <= 2; sequence++) {
      const step = store.next(d);
      if (step.kind !== "next") throw Error("next");
      store.acknowledge(d, step.predecessor, {
        ...step.admitted.metadata.accepted.receipt,
        localYDocSequence: sequence,
        applicationReplayed: false,
      });
    }
    f.raw.exec("DELETE FROM sync_relay_live_delivery_edges WHERE journal_cursor=1");
    reopened = openSyncRelayStorage(f.path);
    const resumed = reopened.createLiveCommittedDeliveryStore(history),
      again = resumed.open({ host, document: f.input.evidence.document });
    expect(() => resumed.next(again)).toThrow("damaged");
  } finally {
    reopened?.close();
    f.close();
  }
});

function deletedPayload(targetLength: number): Uint8Array {
  let length = targetLength - 32;
  for (let attempt = 0; attempt < 4; attempt++) {
    const doc = new Y.Doc({ gc: false });
    doc.clientID = 1001;
    try {
      doc.getMap("meta").set("schemaVersion", 1);
      const paragraph = new Y.XmlElement("paragraph"),
        text = new Y.XmlText();
      paragraph.insert(0, [text]);
      doc.getXmlFragment("body").insert(0, [paragraph]);
      text.insert(0, "b".repeat(length));
      text.delete(0, text.length);
      const bytes = Y.encodeStateAsUpdate(doc);
      if (bytes.byteLength === targetLength) return bytes;
      length += targetLength - bytes.byteLength;
    } finally {
      doc.destroy();
    }
  }
  throw Error("payload length did not converge");
}

it("resets the checkpoint segment across two genuine byte-trigger checkpoints", () => {
  const payload = deletedPayload(20_971_520);
  const f = registered({
    baselineBytes: payload,
    journalPolicy: { ...policy, maxDecodedPayloadByteVisits: 500_000_000 },
  });
  try {
    const empty = new Y.Doc(),
      noop = Y.encodeStateAsUpdate(empty);
    empty.destroy();
    for (let index = 0; index < 4; index++)
      expect(
        f.storage.commitLiveUpdateJournal(
          f.capture(index % 2 === 0 ? payload : noop, `event-${index}`),
        ).result.kind,
      ).toBe("accepted");
    expect(
      f.raw
        .prepare(
          "SELECT journal_cursor FROM sync_relay_live_update_journal WHERE validation_checkpoint_bytes IS NOT NULL",
        )
        .all(),
    ).toEqual([{ journal_cursor: 1 }, { journal_cursor: 3 }]);
    const { store } = delivery(f),
      d = store.open({ host, document: f.input.evidence.document });
    ackBaseline(store, d);
    for (let index = 0; index < 4; index++) {
      const step = store.next(d);
      if (step.kind !== "next") throw Error("next");
      expect(step.admitted.metadata.accepted.receipt.journalCursor).toBe(index + 1);
      store.acknowledge(d, step.predecessor, {
        ...step.admitted.metadata.accepted.receipt,
        localYDocSequence: index + 1,
        applicationReplayed: false,
      });
    }
    expect(store.next(d).kind).toBe("done");
  } finally {
    f.close();
  }
}, 60_000);

it.each(["bytes"])(
  "detects changed baseline %s during an open drain without trusting the stored digest",
  (mode) => {
    const f = registered();
    try {
      const { store } = delivery(f),
        d = store.open({ host, document: f.input.evidence.document });
      const step = store.next(d);
      if (step.kind !== "bootstrap") throw Error("bootstrap");
      const original = f.raw.prepare("SELECT baseline_bytes FROM sync_relay_live_documents").get()!
        .baseline_bytes as Uint8Array;
      const changed = new Uint8Array(original);
      changed[changed.length - 1] ^= 1;
      f.raw
        .prepare("UPDATE sync_relay_live_documents SET baseline_bytes=?")
        .run(mode === "bytes" ? changed : original.subarray(0, original.length - 1));
      expect(() => store.next(d)).toThrow("damaged");
      expect(() =>
        store.acknowledgeBootstrap(d, {
          bootstrapId: step.baseline.bootstrapId,
          bootstrapMomentId: step.baseline.bootstrapMomentId,
          baselineDigest: step.baseline.baselineDigest,
          baselineMomentRelaySequence: step.baseline.baselineMomentRelaySequence,
          localYDocSequence: 0,
          bootstrapReplayed: false,
        }),
      ).toThrow("damaged");
    } finally {
      f.close();
    }
  },
);
