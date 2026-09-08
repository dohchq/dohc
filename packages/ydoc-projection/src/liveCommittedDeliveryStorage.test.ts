import { afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  openSyncRelayStorage,
  type LiveHostConnectionCoordinate,
} from "../../../services/sync-relay/src/storage.js";
import {
  registered,
  DatabaseSync,
  host,
  policy,
  hash,
  cleanupLiveDeliveryFixtures,
} from "./liveCommittedDeliveryTestSupport.js";
afterEach(() => {
  vi.restoreAllMocks();
  cleanupLiveDeliveryFixtures();
});
import { createLiveJournalHistoryAuthority } from "../../../services/sync-relay/src/storage/liveJournalHistory.js";
import { HOST_CONTROL_IDENTIFIER_MAX_BYTES, parseHostEpoch } from "@dohc/live-session-contract/host-control";
import { journalMetadataBytes, liveDeliveryBookkeepingBytes } from "./liveDeliveryQuotaTestSupport.js";

function delivery(f: ReturnType<typeof registered>) {
  const history = createLiveJournalHistoryAuthority({
    namespace: "history-one",
    reconciled: true,
  });
  return {
    history,
    store: f.storage.createLiveCommittedDeliveryStore(history),
  };
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
it("funds the stored document binding independently of a large share selector", () => {
  const f = registered();
  try {
    const paths = ["docs", ...Array.from({ length: 99 }, (_, index) => `other-${index}/${"x".repeat(200)}`)];
    f.raw.prepare("UPDATE sync_relay_shares SET selector_json=? WHERE share_id='share'")
      .run(JSON.stringify({ paths, versionId: null }));
    const current = f.storage.resolveCurrentLiveDocumentBinding({ document: f.input.evidence.document, actor: f.actor });
    expect(current.kind).toBe("current");
    if (current.kind !== "current") throw Error("current binding");
    expect(current.binding.selectorPaths).toHaveLength(100);
    expect(Buffer.byteLength(JSON.stringify(current.binding))).toBeGreaterThan(20_000);
    const { store } = delivery(f), drain = store.open({ host, document: f.input.evidence.document });
    expect(drain.baseline.binding.selectorPaths).toEqual([f.input.evidence.currentPath]);
    ackBaseline(store, drain);
    expect(store.next(drain)).toEqual({ kind: "done", terminalReceipt: null });
    store.close(drain);
  } finally { f.close(); }
});
it("reserves delivery before admission and completes acknowledgements at quota", () => {
  const quota = 200_000;
  const f = registered({ workspaceQuotaBytes: quota });
  try {
    const event = f.capture(f.update(), "reserved-event");
    expect(f.storage.commitLiveUpdateJournal(event).result.kind).toBe("accepted");
    const usage = () => Number(f.raw.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id='workspace'").get()!.usage_bytes);
    const reserved = () => Number(f.raw.prepare("SELECT COALESCE(SUM(reserved_bytes),0) AS total FROM sync_relay_live_delivery_reservations").get()!.total);
    const charged = usage();
    expect(reserved()).toBeGreaterThan(0);
    expect(f.storage.commitLiveUpdateJournal(event).result).toMatchObject({ kind: "accepted", replayed: true });
    expect(usage()).toBe(charged);
    f.raw.prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=? WHERE workspace_id='workspace'").run(quota);
    const { store } = delivery(f);
    const drain = store.open({ host, document: f.input.evidence.document });
    expect(usage()).toBe(quota);
    ackBaseline(store, drain);
    const next = store.next(drain);
    if (next.kind !== "next") throw Error("expected event");
    const ack = { ...next.admitted.metadata.accepted.receipt, localYDocSequence: 1, applicationReplayed: false };
    store.acknowledge(drain, next.predecessor, ack);
    expect(store.next(drain).kind).toBe("done");
    expect(reserved()).toBe(0);
    expect(usage()).toBeLessThan(quota);
    const completedUsage = usage();
    store.acknowledge(drain, next.predecessor, ack);
    expect(usage()).toBe(completedUsage);
  } finally { f.close(); }
});

it("refuses an event atomically when its delivery reservation does not fit", () => {
  const quota = 200_000;
  const f = registered({ workspaceQuotaBytes: quota });
  try {
    const event = f.capture(f.update(), "no-reservation-space");
    const path = `${f.path}.quota-probe`;
    f.raw.prepare("VACUUM INTO ?").run(path);
    const probe = openSyncRelayStorage(path), raw = new DatabaseSync(path);
    let journalCharge: number;
    try {
      const beforeDelivery = liveDeliveryBookkeepingBytes(raw);
      expect(probe.commitLiveUpdateJournal(event).result.kind).toBe("accepted");
      journalCharge = event.updateBytes.byteLength + journalMetadataBytes(raw);
      expect(liveDeliveryBookkeepingBytes(raw)).toBeGreaterThan(beforeDelivery);
    } finally { raw.close(); probe.close(); }
    f.raw.prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=? WHERE workspace_id='workspace'").run(quota - journalCharge);
    const before = f.journalRows();
    expect(() => f.storage.commitLiveUpdateJournal(event)).toThrow(/quota/i);
    expect(f.journalRows()).toEqual(before);
    expect(f.raw.prepare("SELECT COUNT(*) AS count FROM sync_relay_live_delivery_reservations WHERE journal_cursor>0").get()!.count).toBe(0);
  } finally { f.close(); }
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
    expect(() => store.acknowledge(drain, next.predecessor, { ...next.admitted.metadata.accepted.receipt, localYDocSequence: 1, applicationReplayed: false })).toThrow(/reservation/i);
    expect(() => f.storage.registerLiveHost({ ...host, updatedAtMs: 40, guard() {} })).toThrow(/reservation/i);
    expect(f.raw.prepare("SELECT COUNT(*) AS count FROM sync_relay_live_delivery_edges").get()!.count).toBe(0);
  } finally { f.close(); }
});

function transitionHost(f: ReturnType<typeof registered>, from: LiveHostConnectionCoordinate, toMode: "device" | "service", toHostId: string) {
  const transitionId = `transition-${from.hostEpoch}`;
  const begin = f.storage.beginLiveHostTransition({ from, toMode, toHostId, transitionId, startedAtMs: 40, guard() {} });
  if (!begin.ok || !begin.snapshot.transition) throw Error("transition refused");
  const transitionGeneration = begin.snapshot.transition.transitionGeneration;
  const committed = f.storage.commitLiveHostTransitionEpoch({ transitionId, transitionGeneration, updatedAtMs: 41 });
  if (!committed.ok) throw Error("transition commit refused");
  const coordinate = { mode: toMode, hostId: toHostId, hostEpoch: parseHostEpoch(from.hostEpoch + 1), instanceId: `instance-${toHostId}`, connectionId: `connection-${toHostId}` };
  const active = f.storage.activateLiveHostTransition({ ...coordinate, transitionId, transitionGeneration, transitionFromEpoch: from.hostEpoch, updatedAtMs: 42, guard() {} });
  if (!active.ok) throw Error("activation refused");
  return coordinate;
}

it("funds new documents and events when a previously used host returns", () => {
  const f = registered();
  try {
    const { store } = delivery(f);
    const first = store.open({ host, document: f.input.evidence.document });
    ackBaseline(store, first);
    store.close(first);
    const service = transitionHost(f, host, "service", "service-host");
    const secondInput = { ...f.input, host: service, evidence: { ...f.input.evidence, currentPath: "docs/b.md", document: { ...f.input.evidence.document, objectId: "second-object" } } };
    f.moment(secondInput, 2);
    expect(f.storage.registerLiveDocumentBaseline(secondInput).kind).toBe("registered");
    expect(f.storage.commitLiveUpdateJournal(f.capture(f.update(), "while-away")).result.kind).toBe("accepted");
    const returned = transitionHost(f, service, "device", host.hostId);
    const retained = store.open({ host: returned, document: f.input.evidence.document });
    const event = store.next(retained);
    if (event.kind !== "next") throw Error("new history not delivered");
    store.acknowledge(retained, event.predecessor, { ...event.admitted.metadata.accepted.receipt, localYDocSequence: 1, applicationReplayed: false });
    expect(store.next(retained).kind).toBe("done");
    const added = store.open({ host: returned, document: secondInput.evidence.document });
    ackBaseline(store, added);
    expect(store.next(added).kind).toBe("done");
  } finally { f.close(); }
});

it("keeps the previous host coordinate when destination funding exceeds quota", () => {
  const quota = 200_000;
  const f = registered({ workspaceQuotaBytes: quota });
  try {
    const begin = f.storage.beginLiveHostTransition({ from: host, toMode: "service", toHostId: "new-host", transitionId: "quota-transition", startedAtMs: 40, guard() {} });
    if (!begin.ok || !begin.snapshot.transition) throw Error("transition refused");
    f.raw.prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=? WHERE workspace_id='workspace'").run(quota);
    const before = f.storage.getLiveHostControl();
    expect(() => f.storage.commitLiveHostTransitionEpoch({ transitionId: "quota-transition", transitionGeneration: begin.snapshot.transition!.transitionGeneration, updatedAtMs: 41 })).toThrow(/quota/i);
    expect(f.storage.getLiveHostControl()).toEqual(before);
    expect(f.raw.prepare("SELECT 1 FROM sync_relay_live_delivery_hosts WHERE host_id='new-host'").get()).toBeUndefined();
    expect(f.raw.prepare("SELECT 1 FROM sync_relay_live_delivery_reservations WHERE host_id='new-host'").get()).toBeUndefined();
  } finally { f.close(); }
});

it("stores delivery acknowledgements at the configured host identifier limit", () => {
  const identifier = "x".repeat(HOST_CONTROL_IDENTIFIER_MAX_BYTES);
  const coordinate = { ...host, hostId: identifier, instanceId: identifier, connectionId: identifier };
  const f = registered({ host: coordinate });
  try {
    expect(f.storage.commitLiveUpdateJournal(f.capture(f.update())).result.kind).toBe("accepted");
    const { store } = delivery(f);
    const drain = store.open({ host: coordinate, document: f.input.evidence.document });
    ackBaseline(store, drain);
    const event = store.next(drain);
    if (event.kind !== "next") throw Error("expected event");
    store.acknowledge(drain, event.predecessor, { ...event.admitted.metadata.accepted.receipt, localYDocSequence: 1, applicationReplayed: false });
    expect(store.next(drain).kind).toBe("done");
  } finally { f.close(); }
});

it("refuses baseline registration atomically when its delivery budget does not fit", () => {
  const quota = 200_000;
  const f = registered({ workspaceQuotaBytes: quota });
  try {
    const input = { ...f.input, evidence: { ...f.input.evidence, currentPath: "docs/b.md", document: { ...f.input.evidence.document, objectId: "second-object" } } };
    f.moment(input, 2);
    f.raw.prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=? WHERE workspace_id='workspace'").run(quota - input.baselineBytes.byteLength);
    const before = f.rows();
    const funding = f.raw.prepare("SELECT * FROM sync_relay_live_delivery_hosts").all();
    expect(() => f.storage.registerLiveDocumentBaseline(input)).toThrow(/quota/i);
    expect(f.rows()).toEqual(before);
    expect(f.raw.prepare("SELECT * FROM sync_relay_live_delivery_hosts").all()).toEqual(funding);
    expect(f.raw.prepare("SELECT 1 FROM sync_relay_live_delivery_documents WHERE object_id='second-object'").get()).toBeUndefined();
  } finally { f.close(); }
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
    const foreign = reopened.createLiveCommittedDeliveryStore(createLiveJournalHistoryAuthority({ namespace: "foreign-history", reconciled: true }));
    expect(() => foreign.open({ host, document: f.input.evidence.document })).toThrow(/reservation/i);
    expect(f.raw.prepare("SELECT COUNT(*) AS count FROM sync_relay_live_delivery_bootstraps").get()!.count).toBe(1);
  } finally {
    reopened?.close();
    if (originalClosed) { f.doc.destroy(); f.raw.close(); }
    else f.close();
  }
});

it("refuses missing funded baseline metadata on reconnect and removes workspace funding on deletion", () => {
  const f = registered();
  try {
    f.raw.exec("DELETE FROM sync_relay_live_delivery_reservations WHERE journal_cursor=0");
    expect(() => f.storage.registerLiveHost({ ...host, updatedAtMs: 50, guard() {} })).toThrow(/reservation/i);
    const { store } = delivery(f);
    expect(() => store.open({ host, document: f.input.evidence.document })).toThrow(/reservation/i);
    f.raw.exec("DELETE FROM sync_relay_workspaces WHERE workspace_id='workspace'");
    for (const table of ["sync_relay_live_delivery_hosts", "sync_relay_live_delivery_documents", "sync_relay_live_delivery_reservations"]) {
      expect(f.raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count).toBe(0);
    }
  } finally { f.close(); }
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
      f.raw
        .prepare("SELECT COUNT(*) n FROM sync_relay_live_delivery_bootstraps")
        .get()!.n,
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
    expect(() => f.storage.commitLiveUpdateJournal(candidate)).toThrow(
      "reconciliation",
    );
    expect(f.journalRows()).toEqual(before);
  } finally {
    f.close();
  }
});

it("reopens a persisted pending bootstrap with its original IDs and rechecks the acknowledged prefix", () => {
  const f = registered();
  let reopened: ReturnType<typeof openSyncRelayStorage> | undefined;
  try {
    const { store, history } = delivery(f),
      d = store.open({ host, document: f.input.evidence.document }),
      before = d.baseline;
    reopened = openSyncRelayStorage(f.path);
    const resumed = reopened.createLiveCommittedDeliveryStore(history),
      again = resumed.open({ host, document: f.input.evidence.document });
    expect(again.baseline.bootstrapId).toBe(before.bootstrapId);
    expect(again.baseline.bootstrapMomentId).toBe(before.bootstrapMomentId);
    expect(resumed.next(again).kind).toBe("bootstrap");
  } finally {
    reopened?.close();
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
      expect(
        f.storage.commitLiveUpdateJournal(f.capture(noop, id)).result.kind,
      ).toBe("accepted");
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
    expect(
      f.raw
        .prepare("SELECT COUNT(*) n FROM sync_relay_live_delivery_edges")
        .get()!.n,
    ).toBe(0);
    const first = store.next(d);
    if (first.kind !== "next") throw Error("next");
    const ack = {
      ...first.admitted.metadata.accepted.receipt,
      localYDocSequence: 1,
      applicationReplayed: false,
    };
    store.acknowledge(d, null, ack);
    store.acknowledge(d, null, { ...ack, applicationReplayed: true });
    expect(() =>
      store.acknowledge(d, null, { ...ack, localYDocSequence: 9 }),
    ).toThrow();
    expect(
      f.raw
        .prepare("SELECT COUNT(*) n FROM sync_relay_live_delivery_edges")
        .get()!.n,
    ).toBe(1);
  } finally {
    f.close();
  }
});
it("does not admit later events into a captured terminal drain", () => {
  const f = registered();
  try {
    const { store } = delivery(f),
      d = store.open({ host, document: f.input.evidence.document });
    const empty = new Y.Doc(),
      noop = Y.encodeStateAsUpdate(empty);
    empty.destroy();
    expect(
      f.storage.commitLiveUpdateJournal(f.capture(noop, "later")).result.kind,
    ).toBe("accepted");
    ackBaseline(store, d);
    expect(store.next(d)).toEqual({ kind: "done", terminalReceipt: null });
    const next = store.open({ host, document: f.input.evidence.document });
    expect(store.next(next).kind).toBe("next");
  } finally {
    f.close();
  }
});
it("uses canonical document identity for concurrent consumer ownership and captures its connection", async () => {
  const { LiveCommittedDelivery } =
    await import("../../../services/sync-relay/src/liveCommittedDelivery.js");
  const f = registered();
  try {
    let reject!: (error: Error) => void, entered!: () => void;
    const observed: unknown[] = [];
    const called = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const response = new Promise<never>((_resolve, fail) => {
      reject = fail;
    });
    const client = {
      sendRequest(request: unknown) {
        observed.push(request);
        entered();
        return response;
      },
    } as unknown as import("../../workspace-engine-client/src/daemon/engineClient.js").EngineClient;
    const connection = {
      client,
      workspace: "held-workspace",
      host: { ...host } as {
        -readonly [K in keyof LiveHostConnectionCoordinate]: LiveHostConnectionCoordinate[K];
      },
      deadlineMs: 5000,
      nextRequestId: () => 1,
    };
    const consumer = new LiveCommittedDelivery(
      f.storage,
      createLiveJournalHistoryAuthority({
        namespace: "history-one",
        reconciled: true,
      }),
      connection,
    );
    connection.workspace = "replacement";
    connection.host.hostId = "replacement";
    connection.deadlineMs = 1;
    const first = consumer.drain(f.input.evidence.document);
    await called;
    const { workspaceId, mainVersionId, objectId, lineageClaimId } =
      f.input.evidence.document;
    await expect(
      consumer.drain({ lineageClaimId, objectId, mainVersionId, workspaceId }),
    ).rejects.toThrow("already owns");
    expect(observed[0]).toMatchObject({
      workspace: "held-workspace",
      deadlineMs: 5000,
    });
    const failure = expect(first).rejects.toThrow("stop before bootstrap");
    reject(Error("stop before bootstrap"));
    await failure;
  } finally {
    f.close();
  }
});

it.each([64, 128])(
  "measures a real %i-event drain and bounds acknowledged-prefix reads",
  (count) => {
    const f = registered();
    try {
      for (let index = 0; index < count; index++)
        expect(
          f.storage.commitLiveUpdateJournal(
            f.capture(
              f.update(`key-${index}`, String(index)),
              `event-${index}`,
            ),
          ).result.kind,
        ).toBe("accepted");
      const { store } = delivery(f),
        d = store.open({ host, document: f.input.evidence.document });
      ackBaseline(store, d);
      const original = DatabaseSync.prototype.prepare;
      const counts = {
        statements: 0,
        edgeQueries: 0,
        edgeRows: 0,
        checkpointQueries: 0,
        checkpointRows: 0,
      };
      const spy = vi
        .spyOn(DatabaseSync.prototype, "prepare")
        .mockImplementation(function (
          this: InstanceType<typeof DatabaseSync>,
          sql: string,
        ) {
          counts.statements++;
          const statement = original.call(this, sql),
            all = statement.all.bind(statement);
          const edge =
            sql.startsWith("SELECT * FROM sync_relay_live_delivery_edges") &&
            sql.endsWith("ORDER BY journal_cursor");
          const checkpoint = sql.includes(
            "typeof(update_bytes) AS update_type",
          );
          if (edge || checkpoint)
            vi.spyOn(statement, "all").mockImplementation((...args) => {
              const rows = all(...args);
              if (edge) {
                counts.edgeQueries++;
                counts.edgeRows += rows.length;
              }
              if (checkpoint) {
                counts.checkpointQueries++;
                counts.checkpointRows += rows.length;
              }
              return rows;
            });
          return statement;
        });
      const started = performance.now();
      for (let index = 0; index < count; index++) {
        const step = store.next(d);
        if (step.kind !== "next") throw Error("next");
        expect(step.admitted.metadata.accepted.receipt.deliveryId).toBe(
          `event-${index}`,
        );
        store.acknowledge(d, step.predecessor, {
          ...step.admitted.metadata.accepted.receipt,
          localYDocSequence: index + 1,
          applicationReplayed: false,
        });
      }
      expect(store.next(d).kind).toBe("done");
      const elapsedMs = performance.now() - started;
      spy.mockRestore();
      expect(counts.edgeQueries).toBeLessThanOrEqual(1);
      expect(counts.edgeRows).toBeLessThanOrEqual(count);
      expect(counts.checkpointQueries).toBe(1);
      expect(counts.checkpointRows).toBe(1);
      process.stdout.write(
        JSON.stringify({
          measurement: "committed-delivery-storage",
          events: count,
          elapsedMs,
          ...counts,
        }) + "\n",
      );
    } finally {
      f.close();
    }
  },
  30_000,
);

it("compares the complete predecessor identity on an exact repeated ACK", () => {
  const f = registered();
  try {
    for (const id of ["first", "second"])
      expect(
        f.storage.commitLiveUpdateJournal(f.capture(f.update(id, id), id))
          .result.kind,
      ).toBe("accepted");
    const { store } = delivery(f),
      d = store.open({ host, document: f.input.evidence.document });
    ackBaseline(store, d);
    const first = store.next(d);
    if (first.kind !== "next") throw Error("next");
    store.acknowledge(d, null, {
      ...first.admitted.metadata.accepted.receipt,
      localYDocSequence: 1,
      applicationReplayed: false,
    });
    const second = store.next(d);
    if (second.kind !== "next" || !second.predecessor) throw Error("second");
    const predecessor = second.predecessor;
    const ack = {
      ...second.admitted.metadata.accepted.receipt,
      localYDocSequence: 2,
      applicationReplayed: false,
    };
    store.acknowledge(d, second.predecessor, ack);
    expect(() =>
      store.acknowledge(d, { ...predecessor, deliveryId: "forged" }, ack),
    ).toThrow("damaged");
    store.acknowledge(d, second.predecessor, {
      ...ack,
      applicationReplayed: true,
    });
    expect(store.next(d).kind).toBe("done");
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
      expect(
        f.storage.commitLiveUpdateJournal(f.capture(f.update(), "event")).result
          .kind,
      ).toBe("accepted");
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
      const spy = vi
        .spyOn(DatabaseSync.prototype, "exec")
        .mockImplementation(function (
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
      expect(() => store.acknowledge(d, step.predecessor, ack)).toThrow(
        "uncertain edge commit",
      );
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
      expect(
        f.raw
          .prepare("SELECT COUNT(*) n FROM sync_relay_live_delivery_edges")
          .get()!.n,
      ).toBe(phase === "after" ? 1 : 0);
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
      }
      else f.close();
    }
  },
);

it.each(["mode", "hostId", "hostEpoch", "instanceId", "connectionId"] as const)(
  "refuses a wrong host %s without issuing delivery authority",
  (field) => {
    const f = registered();
    try {
      const { store } = delivery(f);
      const changed = {
        ...host,
        [field]:
          field === "hostEpoch" ? 2 : field === "mode" ? "cloud" : "other",
      };
      expect(() =>
        store.open({ host: changed, document: f.input.evidence.document }),
      ).toThrow();
      expect(
        f.raw
          .prepare("SELECT COUNT(*) n FROM sync_relay_live_delivery_bootstraps")
          .get()!.n,
      ).toBe(0);
    } finally {
      f.close();
    }
  },
);

it.each(["device", "service"] as const)("persists bootstrap and event acknowledgements for a %s host", (mode) => {
  const configuredHost = { ...host, mode }, f = registered({ host: configuredHost });
  let reopened: ReturnType<typeof openSyncRelayStorage> | undefined;
  try {
    expect(f.storage.commitLiveUpdateJournal(f.capture(f.update(), "host-mode-event")).result.kind).toBe("accepted");
    const { store } = delivery(f), d = store.open({ host: configuredHost, document: f.input.evidence.document });
    ackBaseline(store, d);
    const step = store.next(d);
    if (step.kind !== "next") throw Error("next");
    store.acknowledge(d, step.predecessor, {
      ...step.admitted.metadata.accepted.receipt,
      localYDocSequence: 1,
      applicationReplayed: false,
    });
    expect(store.next(d).kind).toBe("done");
    expect(f.raw.prepare("SELECT ack_host_mode FROM sync_relay_live_delivery_bootstraps").all()).toEqual([{ ack_host_mode: mode }]);
    expect(f.raw.prepare("SELECT ack_host_mode FROM sync_relay_live_delivery_edges").all()).toEqual([{ ack_host_mode: mode }]);
    reopened = openSyncRelayStorage(f.path);
    const resumed = reopened.createLiveCommittedDeliveryStore(createLiveJournalHistoryAuthority({ namespace: "history-one", reconciled: true }));
    const drain = resumed.open({ host: configuredHost, document: f.input.evidence.document });
    expect(drain.baseline.bootstrapId).toBe(d.baseline.bootstrapId);
    expect(resumed.next(drain).kind).toBe("done");
  } finally {
    reopened?.close();
    f.close();
  }
});

it("does not reinterpret a historical admission after the original client grant is revoked", () => {
  const f = registered();
  try {
    const actor = {
      kind: "named",
      userId: "reader",
      grantId: "grant",
    } as const;
    expect(
      f.storage.commitLiveUpdateJournal(
        f.capture(f.update(), "accepted-before-revocation", actor),
      ).result.kind,
    ).toBe("accepted");
    f.raw.exec(
      "UPDATE sync_relay_share_grants SET status='revoked',revoked_at_ms=40 WHERE grant_id='grant'",
    );
    const { store } = delivery(f),
      d = store.open({ host, document: f.input.evidence.document });
    ackBaseline(store, d);
    const step = store.next(d);
    if (step.kind !== "next") throw Error("next");
    expect(step.admitted.metadata.accepted.receipt.deliveryId).toBe(
      "accepted-before-revocation",
    );
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
      expect(
        f.storage.commitLiveUpdateJournal(f.capture(f.update(id, id), id))
          .result.kind,
      ).toBe("accepted");
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
    f.raw.exec(
      "DELETE FROM sync_relay_live_delivery_edges WHERE journal_cursor=1",
    );
    reopened = openSyncRelayStorage(f.path);
    const resumed = reopened.createLiveCommittedDeliveryStore(history),
      again = resumed.open({ host, document: f.input.evidence.document });
    expect(() => resumed.next(again)).toThrow("damaged");
  } finally {
    reopened?.close();
    f.close();
  }
});

it.each([
  "sync_relay_live_delivery_bootstraps",
  "sync_relay_live_delivery_edges",
])("rejects a missing marked %s table", (table) => {
  const f = registered();
  try {
    f.raw.exec(`DROP TABLE ${table}`);
    expect(() => openSyncRelayStorage(f.path)).toThrow("schema is damaged");
  } finally {
    f.close();
  }
});

it("rejects an orphaned bootstrap parent on reopen", () => {
  const f = registered();
  try {
    const { store } = delivery(f);
    store.open({ host, document: f.input.evidence.document });
    f.raw.exec("PRAGMA foreign_keys=OFF");
    f.raw.exec(
      "DELETE FROM sync_relay_workspaces WHERE workspace_id='workspace'",
    );
    expect(() => openSyncRelayStorage(f.path)).toThrow();
  } finally {
    f.close();
  }
});

it("keeps a history authority unreconciled across reconstruction of consumers", () => {
  const f = registered();
  try {
    const { store, history } = delivery(f),
      d = store.open({ host, document: f.input.evidence.document });
    history.markUnreconciled();
    const second = f.storage.createLiveCommittedDeliveryStore(history);
    expect(() =>
      second.open({ host, document: f.input.evidence.document }),
    ).toThrow("reconciliation");
    expect(() =>
      store.acknowledgeBootstrap(d, {
        bootstrapId: d.baseline.bootstrapId,
        bootstrapMomentId: d.baseline.bootstrapMomentId,
        baselineDigest: d.baseline.baselineDigest,
        baselineMomentRelaySequence: 1,
        localYDocSequence: 0,
        bootstrapReplayed: false,
      }),
    ).toThrow("reconciliation");
    expect(() =>
      f.storage.createLiveCommittedDeliveryStore(
        createLiveJournalHistoryAuthority({
          namespace: history.namespace,
          reconciled: true,
        }),
      ),
    ).toThrow("already attached");
  } finally {
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

it("resets the checkpoint segment across three genuine byte-trigger checkpoints", () => {
  const payload = deletedPayload(20_971_520);
  const f = registered({
    baselineBytes: payload,
    journalPolicy: { ...policy, maxDecodedPayloadByteVisits: 500_000_000 },
  });
  try {
    const empty = new Y.Doc(),
      noop = Y.encodeStateAsUpdate(empty);
    empty.destroy();
    for (let index = 0; index < 6; index++)
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
    ).toEqual([
      { journal_cursor: 1 },
      { journal_cursor: 3 },
      { journal_cursor: 5 },
    ]);
    const { store } = delivery(f),
      d = store.open({ host, document: f.input.evidence.document });
    ackBaseline(store, d);
    for (let index = 0; index < 6; index++) {
      const step = store.next(d);
      if (step.kind !== "next") throw Error("next");
      expect(step.admitted.metadata.accepted.receipt.journalCursor).toBe(
        index + 1,
      );
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

it("invalidates checkpoint position after another drain advances the durable tip", () => {
  const f = registered();
  try {
    for (let index = 0; index < 4; index++)
      expect(
        f.storage.commitLiveUpdateJournal(
          f.capture(f.update(`key-${index}`, String(index)), `event-${index}`),
        ).result.kind,
      ).toBe("accepted");
    const { store } = delivery(f),
      first = store.open({ host, document: f.input.evidence.document }),
      second = store.open({ host, document: f.input.evidence.document });
    ackBaseline(store, first);
    const captured = store.next(first);
    if (captured.kind !== "next") throw Error("next");
    for (let index = 0; index < 3; index++) {
      const step = store.next(second);
      if (step.kind !== "next") throw Error("next");
      store.acknowledge(second, step.predecessor, {
        ...step.admitted.metadata.accepted.receipt,
        localYDocSequence: index + 1,
        applicationReplayed: false,
      });
    }
    const original = DatabaseSync.prototype.prepare;
    let checked = 0;
    const spy = vi
      .spyOn(DatabaseSync.prototype, "prepare")
      .mockImplementation(function (
        this: InstanceType<typeof DatabaseSync>,
        sql: string,
      ) {
        if (sql.includes("typeof(update_bytes) AS update_type")) checked++;
        return original.call(this, sql);
      });
    const step = store.next(first);
    spy.mockRestore();
    expect(checked).toBe(1);
    expect(step.kind).toBe("next");
    if (step.kind !== "next") throw Error("next");
    expect(step.admitted.metadata.accepted.receipt.journalCursor).toBe(4);
    store.acknowledge(first, step.predecessor, {
      ...step.admitted.metadata.accepted.receipt,
      localYDocSequence: 4,
      applicationReplayed: false,
    });
    expect(store.next(first).kind).toBe("done");
  } finally {
    f.close();
  }
});

it("refuses an early checkpoint inserted after the initial cached position", () => {
  const f = registered();
  try {
    for (const id of ["first", "second"])
      expect(
        f.storage.commitLiveUpdateJournal(f.capture(f.update(id, id), id))
          .result.kind,
      ).toBe("accepted");
    const { store } = delivery(f),
      d = store.open({ host, document: f.input.evidence.document });
    ackBaseline(store, d);
    const first = store.next(d);
    if (first.kind !== "next") throw Error("next");
    store.acknowledge(d, null, {
      ...first.admitted.metadata.accepted.receipt,
      localYDocSequence: 1,
      applicationReplayed: false,
    });
    const bytes = Y.encodeStateAsUpdate(f.doc);
    f.raw
      .prepare(
        "UPDATE sync_relay_live_update_journal SET validation_checkpoint_bytes=?,validation_checkpoint_sha256=? WHERE journal_cursor=2",
      )
      .run(bytes, hash(bytes));
    expect(() => store.next(d)).toThrow("damaged");
  } finally {
    f.close();
  }
});

it("completes an older captured drain after a newer drain acknowledges past its terminal", () => {
  const f = registered();
  try {
    const { store } = delivery(f),
      empty = store.open({ host, document: f.input.evidence.document });
    expect(
      f.storage.commitLiveUpdateJournal(
        f.capture(f.update("first", "first"), "first"),
      ).result.kind,
    ).toBe("accepted");
    const older = store.open({ host, document: f.input.evidence.document });
    expect(
      f.storage.commitLiveUpdateJournal(
        f.capture(f.update("second", "second"), "second"),
      ).result.kind,
    ).toBe("accepted");
    const newer = store.open({ host, document: f.input.evidence.document });
    ackBaseline(store, newer);
    let last:
      | Extract<ReturnType<typeof store.next>, { kind: "next" }>
      | undefined;
    for (let sequence = 1; sequence <= 2; sequence++) {
      const step = store.next(newer);
      if (step.kind !== "next") throw Error("next");
      store.acknowledge(newer, step.predecessor, {
        ...step.admitted.metadata.accepted.receipt,
        localYDocSequence: sequence,
        applicationReplayed: false,
      });
      last = step;
    }
    expect(store.next(empty)).toEqual({ kind: "done", terminalReceipt: null });
    expect(store.next(older)).toEqual({
      kind: "done",
      terminalReceipt: older.terminalReceipt,
    });
    expect(() =>
      store.acknowledge(older, last!.predecessor, {
        ...last!.admitted.metadata.accepted.receipt,
        localYDocSequence: 2,
        applicationReplayed: true,
      }),
    ).toThrow("damaged");
  } finally {
    f.close();
  }
});

it.each(['bytes','length'])('detects changed baseline %s during an open drain without trusting the stored digest', mode => {
  const f=registered();
  try {
    const {store}=delivery(f),d=store.open({host,document:f.input.evidence.document});
    const step=store.next(d);
    if(step.kind!=='bootstrap')throw Error('bootstrap');
    const original=f.raw.prepare('SELECT baseline_bytes FROM sync_relay_live_documents').get()!.baseline_bytes as Uint8Array;
    const changed=new Uint8Array(original);changed[changed.length-1]^=1;
    f.raw.prepare('UPDATE sync_relay_live_documents SET baseline_bytes=?').run(mode==='bytes'?changed:original.subarray(0,original.length-1));
    expect(()=>store.next(d)).toThrow('damaged');
    expect(()=>store.acknowledgeBootstrap(d,{
      bootstrapId:step.baseline.bootstrapId,bootstrapMomentId:step.baseline.bootstrapMomentId,
      baselineDigest:step.baseline.baselineDigest,baselineMomentRelaySequence:step.baseline.baselineMomentRelaySequence,
      localYDocSequence:0,bootstrapReplayed:false,
    })).toThrow('damaged');
  } finally {f.close();}
});
