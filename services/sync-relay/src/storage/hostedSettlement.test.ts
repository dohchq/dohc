import { afterAll, afterEach, expect, it, vi } from "vitest";
import {
  registered,
  cleanupLiveDeliveryFixtures } from "../../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport.js";
import { nativeSettlementId, prepareHostedSettlements, settlementRecordDigest } from "./hostedSettlement.js";
import type { StorageContext } from "./context.js";
import nativeAuthoredSettlement from "../testing/fixtures/nativeAuthoredSettlement.json";
const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
afterEach(() => logged.mockClear());
afterEach(cleanupLiveDeliveryFixtures);
/** Each logged refusal as "<stage> <check>", in order. */
const refusedChecks = () => logged.mock.calls.flatMap(([line]) =>
  /^\[sync-relay\] live settlement refused at (\w+): workspace [^,]+, settlement [^,]+, check ([a-z-]+)\.$/u
    .exec(String(line))?.slice(1).join(" ") ?? []);

// The engine's `update_native_audit_fixture` writes this settlement.
it("derives the engine's own settlement ID and record digest", () => {
  const {payload} = nativeAuthoredSettlement.find(op => op.opKind === "live.audit.settlement")!;
  const {record, recordDigest} = payload as unknown as {record: Record<string, unknown>; recordDigest: string};
  expect(nativeSettlementId(record)).toBe(record.settlementId);
  expect(settlementRecordDigest(record)).toBe(recordDigest);
});
import { createHash } from "node:crypto";

import { encodeStateAsUpdate } from "yjs";
import { createLiveMarkdownRegistrationValidator } from "@dohc/ydoc-projection/live-journal-validation";
import { stableJsonStringify } from "../canonicalJson.js";
import { initialAcceptedHistoryDigest } from "../liveAcceptedHistory.js";
import { RestoreHistoryBudget } from "./liveAcceptedHistory.js";
import { liveValidation } from "../liveValidation.js";
import { createShareReadQueries } from "../shareReadQueries.js";
import {OwnerCommittedDelivery } from "../ownerCommittedDelivery.js";
import {OwnerKnownRefusals } from "@dohc/workspace-engine-client/owner-ydoc-drainer";
import type {EngineClient } from "@dohc/workspace-engine-client/daemon";
import {attachLiveJournalHistory,createLiveJournalHistoryAuthority } from "./liveJournalHistory.js";
const hash = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");
const policy = {
  maxStructVisits: 1_000_000,
  maxValueNodeVisits: 5_000_000,
  maxDecodedPayloadByteVisits: 100_000_000,
  maxStructClientGroupVisits: 1_000_000,
  maxDeleteClientGroupVisits: 1_000_000,
  maxDeleteIntervalVisits: 1_000_000,
  maxIndexOperations: 10_000_000,
};
const normalize = createLiveMarkdownRegistrationValidator(policy);
function publication(
  f: ReturnType<typeof registered>,
  id: string,
  previous = 0,
  before = f.input.evidence.projectedMarkdownSha256,
  originSeq = 0,
  automation?: import("@dohc/live-session-contract/live-authorship").AutomationDeclaration,
  update?: Uint8Array,
  agentId = "trip",
  owner = false,
) {
  f.doc.gc = false;
  const baselineBytes = new TextEncoder().encode(
    f.input.evidence.projectedMarkdown,
  );
  f.storage.putBlob({
    workspaceId: "workspace",
    sha256: hash(baselineBytes),
    content: baselineBytes,
    createdAtMs: 1,
  });
  const accountId = owner ? "owner" : "reader";
  const captured = f.capture(update ?? f.update("title", id), id, automation || owner ? {kind: "owner", userId: "owner"} : {
    kind: "named",
    userId: "reader",
    grantId: "grant",
  });
  const accepted = f.storage.commitLiveUpdateJournal({
    ...captured,
    ...(automation ? {trustedAutomation: automation} : {trustedAccount: { accountId, name: owner ? "Owner" : "Reader" }}),
    metadata: automation ? captured.metadata : {
      ...captured.metadata,
      authorContext: {
        kind: "account",
        accountId,
        agent: {
          agentId,
          agentName: "Trip",
          onBehalfOf: "owner",
          depth: 2,
        },
      },
    },
  });
  expect(accepted.result).toMatchObject({kind: "accepted"});
  const receipt = accepted.admitted!.metadata.accepted.receipt;
  const bytes = encodeStateAsUpdate(f.doc),
    stateSha = hash(bytes);
  const projected = normalize({
    document: f.input.evidence.document,
    currentPath: captured.metadata.binding.currentPath,
    checkpoint: bytes,
  });
  if (projected.kind !== "accepted") throw new Error(JSON.stringify(projected));
  const markdown = new TextEncoder().encode(
      projected.evidence.projectedMarkdown,
    ),
    markdownSha = hash(markdown);
  for (const [sha, content] of [
    [stateSha, bytes],
    [markdownSha, markdown],
  ] as const)
    f.storage.putBlob({
      workspaceId: "workspace",
      sha256: sha,
      content,
      createdAtMs: 1,
    });
  const row = f.raw
    .prepare(
      "SELECT * FROM sync_relay_live_update_journal WHERE journal_cursor=?",
    )
    .get(receipt.journalCursor)!;
  const prior = previous
    ? f.raw
        .prepare(
          "SELECT * FROM sync_relay_live_update_journal WHERE journal_cursor=?",
        )
        .get(previous)!
    : null;
  const namespace = String(row.relay_database_namespace),
    document = f.input.evidence.document;
  const acceptedEventCount = Number(row.accepted_event_count) - Number(prior?.accepted_event_count ?? 0);
  const record = {
    settlementId: "",
    relayDatabaseNamespace: namespace,
    binding: captured.metadata.binding,
    hostCoordinate: {hostId: "host", hostEpoch: 1, instanceId: "instance", connectionId: "connection"},
    previousCursor: previous,
    terminalCursor: receipt.journalCursor,
    previousYdocSequence: 0,
    localYdocSequence: 1,
    applicationCount: acceptedEventCount,
    nativeIntervalDigest: hash(`native-interval-${id}`),
    acceptedEventCount,
    acceptedIntervalDigest: hash(
      JSON.stringify([
        "live-settlement-accepted-interval-v1",
        [
          namespace,
          document.workspaceId,
          document.mainVersionId,
          document.objectId,
          document.lineageClaimId,
        ],
        [
          Number(prior?.accepted_event_count ?? 0),
          previous,
          prior?.accepted_evidence_digest ??
            initialAcceptedHistoryDigest(namespace, document),
        ],
        [
          Number(row.accepted_event_count),
          receipt.journalCursor,
          row.accepted_evidence_digest,
        ],
      ]),
    ),
    momentId: id,
    markdownDigest: markdownSha,
    sourceStateVectorDigest: hash(`state-vector-${id}`),
    acceptedStateBlobSha256: stateSha,
    recordedAtMs: 1,
    restoreOperationId: null,
  };
  record.settlementId = nativeSettlementId(record);
  const payload = {
    momentId: id,
    objectId: document.objectId,
    versionId: "main",
    path: captured.metadata.binding.currentPath,
    operation: "write",
    payloadBeforePath: captured.metadata.binding.currentPath,
    payloadAfterPath: captured.metadata.binding.currentPath,
    payloadBeforeContentKind: "text",
    payloadBeforeBlobSha256: before,
    payloadAfterBlobSha256: markdownSha,
    payloadAfterByteLength: markdown.length,
    payloadAfterContentKind: "text",
    recordedAtMs: 1,
    settlementReference: {
      formatVersion: 1,
      recordDigest: settlementRecordDigest(record),
      record,
    },
  };
  const op = {
    originSeq,
    opKind: "moment.append",
    payloadJson: stableJsonStringify(payload),
    recordedAtMs: 1,
  };
  return { op, payload, record, receipt, markdownSha };
}
async function prepare(
  f: ReturnType<typeof registered>,
  ops: import("./types.js").SyncRelayLogInput[],
  budget?: RestoreHistoryBudget,
) {
  await prepareHostedSettlements(
    f.storage as StorageContext,
    { workspaceId: "workspace", originId: "proof", ops },
    budget,
  );
}
function append(
  f: ReturnType<typeof registered>,
  ops: import("./types.js").SyncRelayLogInput[],
) {
  return f.storage.appendLogBatch({
    workspaceId: "workspace",
    originId: "proof",
    ops,
  });
}
it("keeps one unattributed marker beside named settlement contributors", async () => {
  const f = registered({deployment: true});
  try {
    f.doc.gc = false;
    for (const id of ["actorless-first", "actorless-second"]) {
      const accepted = f.storage.commitLiveUpdateJournal(f.capture(f.update("title", id), id, {
        kind: "named", userId: "reader", grantId: "grant",
      }));
      expect(accepted.result).toMatchObject({kind: "accepted"});
      expect(accepted.admitted!.metadata.authorSnapshot).toEqual([]);
    }
    const last = publication(f, "mixed-coverage");
    await prepare(f, [last.op]);
    expect(last.op).toMatchObject({settlementAdmission: {status: "accepted"}});
    expect(append(f, [last.op]).inserted).toBe(1);
    expect(f.storage.fetchLogCoordinate({workspaceId: "workspace", originId: "proof", originSeq: 0})!.admittedAuthorSnapshot)
      .toEqual([
        {kind: "unattributed"},
        {kind: "human", humanId: "reader", humanName: "Reader"},
        {kind: "agent", agentId: "trip", agentName: "Trip", onBehalfOf: "reader", depth: 2},
      ]);
  } finally { f.close(); }
});

it("authenticates full accepted state and publishes exact journal contributors twice, preserving payload and exact retry", async () => {
  const f = registered({ deployment: true });
  try {
    const first = publication(f, "first");
    await prepare(f, [first.op]);
    expect(append(f, [first.op]).inserted).toBe(1);
    const stored = f.storage.fetchLogCoordinate({
      workspaceId: "workspace",
      originId: "proof",
      originSeq: 0,
    })!;
    expect(stored.payloadJson).toBe(first.op.payloadJson);
    expect(stored.admittedAuthorSnapshot).toEqual([
      { kind: "human", humanId: "reader", humanName: "Reader" },
      {
        kind: "agent",
        agentId: "trip",
        agentName: "Trip",
        onBehalfOf: "reader",
        depth: 2,
      },
    ]);
    const retry = { ...first.op };
    await prepare(f, [retry]);
    expect(append(f, [retry]).skipped).toBe(1);
    f.write((db) =>
      db
        .prepare(
          "UPDATE sqlite_sequence SET seq=seq+17 WHERE name='sync_relay_live_update_journal'",
        )
        .run(),
    );
    const second = publication(
      f,
      "second",
      first.receipt.journalCursor,
      first.markdownSha,
      1,
    );
    await prepare(f, [second.op]);
    expect(append(f, [second.op])).toMatchObject({ inserted: 1 });
    expect(second.op).toMatchObject({
      settlementAdmission: { status: "accepted" },
    });
    expect(
      f.raw
        .prepare(
          "SELECT COUNT(*) AS n FROM sync_relay_live_settlement_bindings",
        )
        .get()?.n,
    ).toBe(2);
  } finally {
    f.close();
  }
});

it.each([true])("settles the cut before a receipt in the adoption pass, restart=%s", async restart => {
  const f = registered();
  const history = createLiveJournalHistoryAuthority({namespace: "handover-test",reconciled: true});
  attachLiveJournalHistory(f.storage as StorageContext,history);
  try {
    f.write(db => db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES ('sync_relay_live_update_journal',6)").run());
    const first = publication(f,"handover");
    await prepare(f,[first.op]);
    expect(append(f,[first.op]).settlementRefusals).toBeUndefined();
    expect(first.receipt.journalCursor).toBe(7);
    let fileDigest = f.input.evidence.projectedMarkdownSha256, terminal = first.receipt, requestId = 0;
    let next: ReturnType<typeof publication> | undefined, failSettle = restart, cutSettled = false;
    const methods: string[] = [];
    const client = {
      async sendRequest(input: Parameters<EngineClient["sendRequest"]>[0]) {
        methods.push(input.method);
        if(input.method === "liveApplication.register")return {id: input.id,result: {registrationId: 1}};
        if(input.method === "liveApplication.ownerState")return {id: input.id,result: {
          adoptionId: "handover",expectedLocalSequence: 1,throughCursor: null,sessionId: "session"}};
        if(input.method === "liveApplication.ownerOutbox") {
          // A collaborator keeps typing while this delivery pass drains the
          // outbox. The pass reads the empty queue once before the cut, too.
          if(cutSettled) next ??= publication(f,"typed-through-handover",7,fileDigest,1);
          return {id: input.id,result: {outboxId: null,pendingBytes: 0,state: "active",retryDeliveryId: null}};
        }
        expect(input.method).toBe("liveApplication.settle");
        if(failSettle){failSettle = false;throw new Error("relay restarted before empty settle");}
        const empty = terminal.journalCursor === 7;
        fileDigest = empty ? first.markdownSha : next!.markdownSha;
        cutSettled = true;
        return {id: input.id,result: {status: "settled",settlement: {
          settlementId: empty ? null : next!.record.settlementId,previousCursor: 7,terminalCursor: terminal.journalCursor,
          applicationCount: empty ? 0 : 1,localYDocSequence: empty ? 1 : 2,momentId: empty ? "cut" : "typed-through-handover",
          markdownDigest: fileDigest,materialized: true,collectionReconcileRequired: false,
        }}};
      },
      async sendLiveOwnerAdoption(input: Parameters<EngineClient["sendLiveOwnerAdoption"]>[0]) {
        return {id: input.id,result: {status: "adopted",adoption: {
          adoptionId: "handover",localYDocSequence: 1,terminalCursor: 7,adoptionReplayed: false,
        }}};
      },
      async sendLiveApplication(input: Parameters<EngineClient["sendLiveApplication"]>[0],event: Parameters<EngineClient["sendLiveApplication"]>[1]) {
        terminal = event.metadata.accepted.receipt;
        return {id: input.id,result: {status: "applied",ack: {...terminal,localYDocSequence: 2,applicationReplayed: false}}};
      },
    } as unknown as EngineClient;
    const consumer = () => new OwnerCommittedDelivery(f.storage,history,{
      client,workspace: "handle",host: f.input.host,deadlineMs: 1000,nextRequestId: () => ++requestId,
      bounds: {maxBytes: 1_000_000,maxEvents: 100},
      ownerAdmission: {trustedAccount: () => ({accountId: "owner",name: "Owner"}),workspaceIds: new Set(["workspace"]),
        maxEntriesPerDrain: 10,maxBytesPerDrain: 1_000_000,refusals: new OwnerKnownRefusals(),validate: () => {throw new Error("Empty outbox");}},
    });
    let delivery = consumer();
    if(restart) {
      await expect(delivery.drain(f.input.evidence.document)).rejects.toThrow("relay restarted");
      // Only the seed check read the queue; the pass drained nothing.
      expect(methods.filter(method => method === "liveApplication.ownerOutbox")).toHaveLength(1);
      expect(methods.at(-1)).toBe("liveApplication.settle");
      delivery = consumer();
    }
    expect(await delivery.drain(f.input.evidence.document)).toMatchObject({kind: "done",terminalReceipt: {journalCursor: 8}});
    // A seedless adoption still settles its cut, between the seed check and the drain.
    const settledAt = methods.lastIndexOf("liveApplication.settle");
    expect(methods[settledAt - 1]).toBe("liveApplication.ownerOutbox");
    expect(methods.slice(settledAt + 1)).toContain("liveApplication.ownerOutbox");
    expect(next!.payload.payloadBeforeBlobSha256).toBe(first.markdownSha);
    await delivery.settle(f.input.evidence.document);
    await prepare(f,[next!.op]);
    expect(append(f,[next!.op]).settlementRefusals).toBeUndefined();
    expect(next!.op).toMatchObject({settlementAdmission: {status: "accepted"}});
    expect(f.doc.getMap("frontmatter").get("title")).toBe("typed-through-handover");
    expect(refusedChecks()).toEqual([]);
  } finally {f.close();}
});
it.each([
  ["scope", "record-namespace"],
  ["authors", "client-authors"],
])(
  "consumes forged %s proof without changing current content",
  async (field, check) => {
    const f = registered({ deployment: true });
    try {
      const first = publication(f, "first", 0, f.input.evidence.projectedMarkdownSha256, 0);
      const payload = structuredClone(first.payload) as Record<string, unknown>,
        reference = payload.settlementReference as {
          record: Record<string, unknown>;
          recordDigest: string;
        };
      if (field === "scope") reference.record.relayDatabaseNamespace = "other";
      if (field === "authors") payload.authors = [{ kind: "agent", agentId: "forged" }];
      // Each forgery names its own settlement, so only the proof it changes refuses it.
      reference.record.settlementId = nativeSettlementId(reference.record);
      reference.recordDigest = settlementRecordDigest(reference.record);
      first.op.payloadJson = stableJsonStringify(payload);
      await prepare(f, [first.op]);
      const result = append(f, [first.op]);
      expect(result.settlementRefusals).toHaveLength(1);
      expect(refusedChecks()).toEqual([`prepare ${check}`]);
      expect(
        f.raw
          .prepare(
            "SELECT COUNT(*) AS n FROM sync_relay_live_settlement_bindings",
          )
          .get()?.n,
      ).toBe(0);
    } finally {
      f.close();
    }
  },
);
it("rechecks fence after worker proof and consumes stale proof instead of wedging the batch", async () => {
  const f = registered({ deployment: true });
  try {
    const first = publication(f, "first");
    await prepare(f, [first.op]);
    f.write((db) =>
      db
        .prepare(
          "UPDATE sync_relay_live_documents SET restore_fence_generation=restore_fence_generation+1 WHERE workspace_id='workspace'",
        )
        .run(),
    );
    expect(append(f, [first.op]).settlementRefusals).toHaveLength(1);
    expect(refusedChecks()).toEqual(["commit restore-fence"]);
  } finally {
    f.close();
  }
});
it("keeps all proof and log changes atomic when append guard refuses", async () => {
  const f = registered({ deployment: true });
  try {
    const first = publication(f, "first");
    await prepare(f, [first.op]);
    expect(() =>
      f.storage.appendLogBatch({
        workspaceId: "workspace",
        originId: "proof",
        ops: [first.op],
        guard() {
          throw new Error("revoked");
        },
      }),
    ).toThrow("revoked");
    expect(
      f.raw
        .prepare(
          "SELECT COUNT(*) AS n FROM sync_relay_live_settlement_bindings",
        )
        .get()?.n,
    ).toBe(0);
    expect(f.storage.maxOriginSeq("workspace", "proof")).toBe(-1);
  } finally {
    f.close();
  }
});
afterAll(async () => {
  await liveValidation.close();
});

it("shares its event budget across a push and succeeds when retried as smaller batches", async () => {
  const f = registered({ deployment: true });
  try {
    const first = publication(f, "first"),
      second = publication(
        f,
        "second",
        first.receipt.journalCursor,
        first.markdownSha,
        1,
      );
    await expect(
      prepare(
        f,
        [first.op, second.op],
        new RestoreHistoryBudget(64_000_000, 1),
      ),
    ).rejects.toMatchObject({ code: "settlement_proof_budget" });
    expect(f.storage.maxOriginSeq("workspace", "proof")).toBe(-1);
    await prepare(f, [first.op], new RestoreHistoryBudget(64_000_000, 1));
    expect(append(f, [first.op]).settlementRefusals).toBeUndefined();
    await prepare(f, [second.op], new RestoreHistoryBudget(64_000_000, 1));
    expect(append(f, [second.op]).settlementRefusals).toBeUndefined();
  } finally {
    f.close();
  }
});

it.each(["bytes"])("acknowledges a singleton over the %s budget and publishes its unavailable fallback and later work", async limit => {
  const f = registered({deployment:true});
  try {
    const first = publication(f, "oversized");
    const budget = new RestoreHistoryBudget(limit === "bytes" ? 0 : 64_000_000, limit === "events" ? 0 : 65_536);
    await prepare(f, [first.op], budget);
    expect(append(f, [first.op])).toMatchObject({currentMaxOriginSeq:0,
      settlementRefusals:[{originSeq:0, momentId:"oversized", settlementId:first.record.settlementId}]});
    expect(refusedChecks()).toEqual(["prepare proof-budget"]);
    const fallback = {...first.payload, attributionUnavailable:{settlementId:first.record.settlementId,reason:"authorship-mismatch"}};
    delete (fallback as Record<string,unknown>).settlementReference;
    const ops = [{originSeq:1,opKind:"moment.append",payloadJson:stableJsonStringify(fallback),recordedAtMs:1},
      {originSeq:2,opKind:"opaque",payloadJson:"{}",recordedAtMs:1}];
    await prepare(f, ops);
    expect(append(f, ops)).toMatchObject({inserted:2,currentMaxOriginSeq:2});
    const served = f.storage.fetchLogPage({workspaceId:"workspace",sinceRelaySeq:0,limit:100}).rows
      .find(row=>row.originId === "proof" && row.originSeq === 1)!;
    expect(JSON.parse(served.payloadJson)).toMatchObject({attributionUnavailable:{settlementId:first.record.settlementId}});
    expect(JSON.parse(served.payloadJson)).not.toHaveProperty("authors");
    expect(f.raw.prepare("SELECT moment_id FROM sync_relay_object_moments WHERE moment_id='oversized'").get())
      .toEqual({moment_id:"oversized"});
    const marker = {workspaceId:"workspace",originId:"proof",originSeq:1,settlementId:first.record.settlementId,momentId:"oversized",reason:"authorship-mismatch"};
    expect(f.storage.hasRefusedSettlement(marker)).toBe(true);
    for (const changed of [{originId:"other"},{originSeq:0},{settlementId:"other"},{momentId:"other"},{workspaceId:"other"},{reason:"other"}])
      expect(f.storage.hasRefusedSettlement({...marker,...changed})).toBe(false);
    const shared = createShareReadQueries(f.storage,500).filteredLogPage("workspace", "share",
      {paths:[first.record.binding.currentPath],versionId:null,access:"view"},0,100,"authenticated");
    expect(shared.ops.find(op=>op.originId === "proof")?.payload)
      .toMatchObject({metadata:{origin:"sync",summary:"Attribution unavailable"}});
  } finally { f.close(); }
});

it("refuses a different full CRDT state even when its Markdown projection is unchanged", async () => {
  const f = registered({deployment:true});
  try {
    const first = publication(f, "hidden-state");
    f.doc.getMap("frontmatter").set("temporary", "changed");
    f.doc.getMap("frontmatter").delete("temporary");
    const bytes = encodeStateAsUpdate(f.doc);
    const state = normalize({document:f.input.evidence.document,currentPath:first.record.binding.currentPath,checkpoint:bytes});
    expect(state.kind).toBe("accepted");
    if (state.kind !== "accepted") throw new Error("Invalid fixture state.");
    expect(state.evidence.projectedMarkdownSha256).toBe(first.markdownSha);
    const sha = hash(bytes);
    f.storage.putBlob({workspaceId:"workspace",sha256:sha,content:bytes,createdAtMs:1});
    first.record.acceptedStateBlobSha256 = sha;
    first.payload.settlementReference.recordDigest = settlementRecordDigest(first.record);
    first.op.payloadJson = stableJsonStringify(first.payload);
    await prepare(f, [first.op]);
    expect(append(f, [first.op]).settlementRefusals).toHaveLength(1);
    expect(refusedChecks()).toEqual(["prepare state-digest"]);
  } finally { f.close(); }
});

it("publishes admitted automation declaration without inferring its presser as a human", async () => {
  const f = registered({deployment: true});
  try {
    const automation = {automationId: "collection:Tasks#mark", attribution: {actorKind: "automation" as const,
      onBehalfOf: "owner", depth: 2, run: {claimId: "claim", automationName: "Mark task"}}};
    const first = publication(f, "automation", 0, f.input.evidence.projectedMarkdownSha256, 0, automation);
    await prepare(f, [first.op]);
    expect(append(f, [first.op]).settlementRefusals).toBeUndefined();
    expect(f.storage.fetchLogCoordinate({workspaceId: "workspace", originId: "proof", originSeq: 0})?.admittedAuthorSnapshot)
      .toEqual([{kind: "automation", ...automation}]);
    const forged = structuredClone(first.payload);
    forged.momentId = "copied-automation";
    forged.settlementReference.record.momentId = forged.momentId;
    forged.settlementReference.record.settlementId = nativeSettlementId(forged.settlementReference.record);
    forged.settlementReference.recordDigest = settlementRecordDigest(forged.settlementReference.record);
    const copied = {...first.op, originSeq: 1, payloadJson: stableJsonStringify(forged)};
    await prepare(f, [copied]);
    expect(append(f, [copied]).settlementRefusals).toHaveLength(1);
    expect(refusedChecks()).toEqual(["prepare predecessor-published-past"]);
  } finally {f.close();}
});

it.each([true])("anchors a projection-neutral accepted gap with same-push=%s", async samePush => {
  const f = registered({deployment: true});
  try {
    const first = publication(f, "first");
    if (!samePush) { await prepare(f, [first.op]); append(f, [first.op]); }
    f.doc.clientID = 7654321;
    const neutral = publication(f, "neutral", first.receipt.journalCursor, first.markdownSha, 1,
      undefined, f.update("title", "first"), "neutral-author");
    expect(neutral.markdownSha).toBe(first.markdownSha);
    expect(neutral.record.acceptedStateBlobSha256).not.toBe(first.record.acceptedStateBlobSha256);
    f.doc.clientID = 7654322;
    const next = publication(f, "visible", neutral.receipt.journalCursor, first.markdownSha, 1);
    const ops = samePush ? [first.op, next.op] : [next.op];
    await prepare(f, ops);
    expect(append(f, ops).settlementRefusals).toBeUndefined();
    const snapshot = f.storage.fetchLogCoordinate({workspaceId: "workspace", originId: "proof", originSeq: 1})!.admittedAuthorSnapshot;
    expect(snapshot).toContainEqual(expect.objectContaining({kind: "agent", agentId: "trip"}));
    expect(snapshot).not.toContainEqual(expect.objectContaining({agentId: "neutral-author"}));
    expect(f.raw.prepare("SELECT COUNT(*) AS n FROM sync_relay_live_settlement_bindings").get()!.n).toBe(2);
  } finally { f.close(); }
});

it("rechecks an unchanged publication anchor at commit", async () => {
  const f = registered({deployment: true});
  try {
    const first = publication(f, "first"); await prepare(f, [first.op]); append(f, [first.op]);
    const neutral = publication(f, "neutral", first.receipt.journalCursor, first.markdownSha, 1,
      undefined, f.update("title", "first"));
    const next = publication(f, "next", neutral.receipt.journalCursor, first.markdownSha, 1);
    await prepare(f, [next.op]);
    f.write(db => db.prepare("UPDATE sync_relay_live_settlement_cuts SET markdown_sha256=? WHERE journal_cursor=?")
      .run("f".repeat(64), neutral.receipt.journalCursor));
    expect(append(f, [next.op]).settlementRefusals).toHaveLength(1);
    expect(refusedChecks()).toEqual(["commit predecessor-unchanged-gap"]);
    expect(f.storage.maxOriginSeq("workspace", "proof")).toBe(1);
    expect(f.raw.prepare("SELECT COUNT(*) AS n FROM sync_relay_live_settlement_bindings").get()!.n).toBe(1);
  } finally { f.close(); }
});
