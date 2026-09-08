import { afterEach, expect, it, vi } from "vitest";
import type { EngineClient } from "../../workspace-engine-client/src/daemon/engineClient.js";
import { LiveCommittedDelivery, createLiveJournalHistoryAuthority } from "../../../services/sync-relay/src/liveCommittedDelivery.js";
import { registered, host, cleanupLiveDeliveryFixtures } from "./liveCommittedDeliveryTestSupport.js";

afterEach(cleanupLiveDeliveryFixtures);

function fixture() {
  const f = registered();
  const document = f.input.evidence.document;
  const history = createLiveJournalHistoryAuthority({ namespace: "settlement-history", reconciled: true });
  const store = f.storage.createLiveCommittedDeliveryStore(history);
  expect(f.storage.commitLiveUpdateJournal(f.capture(f.update())).result.kind).toBe("accepted");
  const drain = store.open({ host, document });
  const bootstrap = store.next(drain);
  if (bootstrap.kind !== "bootstrap") throw new Error("Expected bootstrap.");
  const b = bootstrap.baseline;
  store.acknowledgeBootstrap(drain, { bootstrapId: b.bootstrapId, bootstrapMomentId: b.bootstrapMomentId,
    baselineDigest: b.baselineDigest, baselineMomentRelaySequence: b.baselineMomentRelaySequence,
    localYDocSequence: 0, bootstrapReplayed: false });
  const next = store.next(drain);
  if (next.kind !== "next") throw new Error("Expected committed application.");
  store.acknowledge(drain, next.predecessor, { ...next.admitted.metadata.accepted.receipt, localYDocSequence: 1, applicationReplayed: false });
  expect(store.next(drain).kind).toBe("done");
  store.close(drain);
  const settlement = { settlementId: "settlement", previousCursor: 0, terminalCursor: 1, applicationCount: 1,
    localYDocSequence: 1, momentId: "settled-moment", markdownDigest: "a".repeat(64), materialized: true };
  let reply: unknown = { status: "settled", settlement };
  let beforeReply = async () => {};
  const sendRequest = vi.fn(async (request: { method: string }) => {
    if (request.method === "liveApplication.register") return { result: { registrationId: 1 } };
    expect(request.method).toBe("liveApplication.settle");
    await beforeReply();
    return { result: reply };
  });
  let requestId = 0;
  const consumer = new LiveCommittedDelivery(f.storage, history, { client: { sendRequest } as unknown as EngineClient,
    workspace: "workspace-handle", host, deadlineMs: 5000, nextRequestId: () => ++requestId });
  const progress = () => ({ documents: f.rows(),
    bootstraps: f.raw.prepare("SELECT * FROM sync_relay_live_delivery_bootstraps").all(),
    edges: f.raw.prepare("SELECT * FROM sync_relay_live_delivery_edges").all() });
  return { ...f, document, settlement, consumer, sendRequest, progress,
    reply(value: unknown) { reply = value; }, beforeReply(callback: () => Promise<void>) { beforeReply = callback; } };
}

it.each([true, false])("returns validated settlement coverage with materialized=%s", async materialized => {
  const f = fixture();
  try {
    const settlement = { ...f.settlement, materialized };
    f.reply({ status: "settled", settlement });
    expect(await f.consumer.settle(f.document)).toEqual(settlement);
    expect(f.sendRequest).toHaveBeenLastCalledWith(expect.objectContaining({ method: "liveApplication.settle",
      params: { registrationId: 1, terminalReceipt: expect.objectContaining({ journalCursor: 1 }) } }), undefined);
  } finally { f.close(); }
});

const invalidRows: [string, Record<string, unknown>][] = [
  ["extra field", { unexpected: true }], ["missing field", { momentId: undefined }],
  ["wrong terminal", { terminalCursor: 0 }], ["previous after terminal", { previousCursor: 2 }],
  ["application overrun", { applicationCount: 2 }], ["nonboolean materialized", { materialized: 1 }],
  ["negative cursor", { previousCursor: -1 }], ["fractional cursor", { terminalCursor: 1.5 }],
  ["string count", { applicationCount: "1" }], ["unsafe sequence", { localYDocSequence: Number.MAX_SAFE_INTEGER + 1 }],
  ["nonfinite sequence", { localYDocSequence: Infinity }], ["empty settlement ID", { settlementId: "" }],
  ["invalid moment ID", { momentId: {} }], ["invalid digest", { markdownDigest: "not-a-digest" }],
];
it.each(invalidRows)("refuses %s without advancing relay progress and releases document ownership", async (_name, patch) => {
  const f = fixture();
  try {
    const before = f.progress();
    const row: Record<string, unknown> = { ...f.settlement, ...patch };
    for (const key of Object.keys(row)) if (row[key] === undefined) delete row[key];
    f.reply({ status: "settled", settlement: row });
    await expect(f.consumer.settle(f.document)).rejects.toThrow();
    expect(f.progress()).toEqual(before);
    f.reply({ status: "settled", settlement: f.settlement });
    expect(await f.consumer.settle(f.document)).toEqual(f.settlement);
  } finally { f.close(); }
});

it.each([null, [], { status: "pending", settlement: {} }, { status: "settled", settlement: [] },
  { status: "settled" }, { status: "settled", settlement: {}, extra: true }])("refuses malformed response %#", async reply => {
  const f = fixture();
  try {
    const before = f.progress();
    f.reply(reply);
    await expect(f.consumer.settle(f.document)).rejects.toThrow("Invalid native settlement response.");
    expect(f.progress()).toEqual(before);
  } finally { f.close(); }
});

it("refuses a valid reply when the connection is retired during native settlement", async () => {
  const f = fixture();
  let entered!: () => void, release!: () => void;
  const called = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  f.beforeReply(async () => { entered(); await pending; });
  try {
    const before = f.progress();
    const settling = f.consumer.settle(f.document);
    const refused = expect(settling).rejects.toThrow();
    await called;
    await expect(f.consumer.drain(f.document)).rejects.toThrow("already owns");
    expect(f.storage.registerLiveHost({ ...host, connectionId: "replacement", updatedAtMs: 20, guard: f.storage.captureStanding() }).ok).toBe(true);
    release();
    await refused;
    expect(f.progress()).toEqual(before);
  } finally { release(); f.close(); }
});
