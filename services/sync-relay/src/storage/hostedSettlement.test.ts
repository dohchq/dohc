import { afterAll, afterEach, expect, it, vi } from "vitest";
import {
  registered,
  cleanupLiveDeliveryFixtures,
} from "../../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport.js";
import { prepareHostedSettlements, parseSettlementAuthors } from "./hostedSettlement.js";
import type { StorageContext } from "./context.js";
const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
afterEach(() => logged.mockClear());
afterEach(cleanupLiveDeliveryFixtures);
/** Each logged refusal as "<stage> <check>", in order. */
const refusedChecks = () => logged.mock.calls.flatMap(([line]) =>
  /^\[sync-relay\] live settlement refused at (\w+): workspace [^,]+, settlement [^,]+, check ([a-z-]+)\.$/u
    .exec(String(line))?.slice(1).join(" ") ?? []);

it("fits 1023 named authors and the window's marker in a settlement snapshot", () => {
  const authors = Array.from({length: 1023}, (_, index) => ({kind: "human", humanId: String(index), humanName: "Reader"}));
  const marker = {kind: "unattributed"};
  expect(parseSettlementAuthors([...authors, marker])).toHaveLength(1024);
  expect(() => parseSettlementAuthors([...authors, {kind: "human", humanId: "new", humanName: "Reader"}, marker])).toThrow();
});
it("records deterministic settlement refusal and advances later origin operations without publishing its moment", async () => {
  const f = registered({ deployment: true });
  try {
    const ops = [
      {
        originSeq: 100,
        opKind: "moment.append",
        payloadJson: JSON.stringify({
          momentId: "forged",
          objectId: "object",
          versionId: "main",
          settlementReference: {
            formatVersion: 1,
            recordDigest: "a".repeat(64),
            record: { settlementId: "forged" },
          },
        }),
        recordedAtMs: 1,
      },
      { originSeq: 101, opKind: "opaque", payloadJson: "{}", recordedAtMs: 1 },
    ];
    const start = f.storage.maxOriginSeq("workspace", "proof") + 1;
    ops.forEach((op, index) => (op.originSeq = start + index));
    await prepareHostedSettlements(f.storage as StorageContext, {
      workspaceId: "workspace",
      originId: "proof",
      ops,
    });
    const result = f.storage.appendLogBatch({
      workspaceId: "workspace",
      originId: "proof",
      ops,
    });
    expect(result.currentMaxOriginSeq).toBe(start + 1);
    expect(result.settlementRefusals).toMatchObject([
      { originSeq: start, momentId: "forged", reason: "authorship-mismatch" },
    ]);
    expect(logged.mock.calls).toEqual([[
      "[sync-relay] live settlement refused at prepare: workspace workspace, settlement forged, check record-digest.",
    ]]);
    expect(
      f.storage.fetchLogCoordinate({
        workspaceId: "workspace",
        originId: "proof",
        originSeq: start,
      }),
    ).toMatchObject({
      settlementAdmission: { status: "refused" },
      payloadJson: ops[0]!.payloadJson,
    });
    expect(
      f.raw
        .prepare(
          "SELECT 1 FROM sync_relay_object_moments WHERE moment_id='forged'",
        )
        .get(),
    ).toBeUndefined();
  } finally {
    f.close();
  }
});
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyUpdate, encodeStateAsUpdate } from "yjs";
import { createLiveMarkdownRegistrationValidator } from "@dohc/ydoc-projection/live-journal-validation";
import { stableJsonStringify } from "../canonicalJson.js";
import { initialAcceptedHistoryDigest } from "../liveAcceptedHistory.js";
import { RestoreHistoryBudget } from "./liveAcceptedHistory.js";
import { liveValidation } from "../liveValidation.js";
import { createShareReadQueries } from "../shareReadQueries.js";
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
  const captured = f.capture(update ?? f.update("title", id), id, automation || owner ? {kind: "owner", userId: "owner", shareId: "share"} : {
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
  const record = {
    settlementId: `settlement-${id}`,
    relayDatabaseNamespace: namespace,
    binding: captured.metadata.binding,
    previousCursor: previous,
    terminalCursor: receipt.journalCursor,
    acceptedEventCount:
      Number(row.accepted_event_count) -
      Number(prior?.accepted_event_count ?? 0),
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
    acceptedStateBlobSha256: stateSha,
  };
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
      recordDigest: hash(stableJsonStringify(record)),
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

it("refuses a client-supplied unattributed marker on settlement publication", async () => {
  const f = registered({deployment: true});
  try {
    const first = publication(f, "client-marker");
    first.op.payloadJson = stableJsonStringify({...first.payload, authors: [{kind: "unattributed"}]});
    await prepare(f, [first.op]);
    expect(append(f, [first.op]).settlementRefusals).toMatchObject([{reason: "authorship-mismatch"}]);
    expect(refusedChecks()).toEqual(["prepare client-authors"]);
    expect(f.raw.prepare("SELECT 1 FROM sync_relay_object_moments WHERE moment_id='client-marker'").get()).toBeUndefined();
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
it("starts a later proof at the Markdown its predecessor verified, not at the baseline", async () => {
  const f = registered({ deployment: true });
  try {
    const first = publication(f, "first");
    await prepare(f, [first.op]);
    append(f, [first.op]);
    const baseline = f.input.evidence.projectedMarkdownSha256;
    expect(first.markdownSha).not.toBe(baseline);
    const stale = publication(f, "stale", first.receipt.journalCursor, baseline, 1);
    await prepare(f, [stale.op]);
    expect(stale.op).toMatchObject({ settlementAdmission: { status: "refused" } });
    expect(refusedChecks()).toEqual(["prepare predecessor-markdown"]);
    const next = publication(f, "next", first.receipt.journalCursor, first.markdownSha, 1);
    await prepare(f, [next.op]);
    expect(append(f, [next.op])).toMatchObject({ inserted: 1 });
    expect(next.op).toMatchObject({ settlementAdmission: { status: "accepted" } });
    expect(refusedChecks()).toEqual(["prepare predecessor-markdown"]);
  } finally {
    f.close();
  }
});
// owner_publication exports these states and the outgoing preimage. The relay
// assigns its own journal coordinates and authorship to the same updates.
const handoverEvidence = process.env.DOHC_HANDOVER_PUBLICATION_EVIDENCE;
it.skipIf(!handoverEvidence).each(["changed", "unchanged", "changed-preserved", "unchanged-preserved",
  "changed-refused", "unchanged-refused", "changed-preserved-refused", "unchanged-preserved-refused"])("accepts the engine's %s handover preimage after a reload", async variant => {
  const evidence = JSON.parse(readFileSync(join(handoverEvidence!, `${variant}.json`), "utf8")) as {
    baselineBytes: number[]; handoverBytes: number[]; nextBytes: number[]; intermediateBytes?: number[];
    payload: {payloadBeforeBlobSha256: string; payloadAfterBlobSha256: string};
  };
  const f = registered({deployment: true, baselineBytes: Uint8Array.from(evidence.baselineBytes)});
  try {
    f.write(db => {
      db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES ('sync_relay_live_update_journal',6)").run();
    });
    f.doc.gc = false;
    const handover = Uint8Array.from(evidence.handoverBytes);
    applyUpdate(f.doc, handover);
    const first = publication(f, "handover", 0, undefined, 0, undefined, handover, "trip", true);
    await prepare(f, [first.op]);
    expect(append(f, [first.op])).toMatchObject({inserted: 1});
    expect(first.op).toMatchObject({settlementAdmission: {status: "accepted"}});
    expect(first.receipt.journalCursor).toBe(7);
    expect(first.markdownSha).toBe(evidence.payload.payloadBeforeBlobSha256);
    if (evidence.intermediateBytes) {
      const intermediate = Uint8Array.from(evidence.intermediateBytes);
      applyUpdate(f.doc, intermediate);
      const refused = publication(f, "refused", 7, first.markdownSha, 1, undefined, intermediate, "trip", true);
      expect(refused.receipt.journalCursor).toBe(8);
      refused.payload.settlementReference.recordDigest = "0".repeat(64);
      refused.op.payloadJson = stableJsonStringify(refused.payload);
      await prepare(f, [refused.op]);
      expect(append(f, [refused.op]).settlementRefusals).toHaveLength(1);
      expect(refusedChecks()).toEqual(["prepare record-digest"]);
      logged.mockClear();
    }
    const nextState = Uint8Array.from(evidence.nextBytes);
    applyUpdate(f.doc, nextState);
    const next = publication(f, "next", first.receipt.journalCursor, evidence.payload.payloadBeforeBlobSha256, evidence.intermediateBytes ? 2 : 1, undefined, nextState, "trip", true);
    expect(next.receipt.journalCursor).toBe(evidence.intermediateBytes ? 9 : 8);
    expect(next.markdownSha).toBe(evidence.payload.payloadAfterBlobSha256);
    await prepare(f, [next.op]);
    expect(append(f, [next.op])).toMatchObject({inserted: 1});
    expect(next.op).toMatchObject({settlementAdmission: {status: "accepted"}});
    expect(refusedChecks()).toEqual([]);
  } finally {
    f.close();
  }
});
it("refuses a changed retry of an accepted proof after stripping its client authors", async () => {
  const f = registered({deployment:true});
  try {
    const first = publication(f,"accepted-retry");
    await prepare(f,[first.op]);
    append(f,[first.op]);
    const changed = {...first.op,payloadJson:stableJsonStringify({...first.payload,authors:[]})};
    await prepare(f,[changed]);
    expect(()=>append(f,[changed])).toThrow(/already exists with different content/);
    expect(f.storage.fetchLogCoordinate({workspaceId:"workspace",originId:"proof",originSeq:0})?.settlementAdmission)
      .toEqual({status:"accepted",settlementId:first.record.settlementId});
  } finally {f.close();}
});
it.each([
  ["before", "first-baseline-markdown"],
  ["state", "state-digest"],
  ["scope", "record-namespace"],
  ["moment", "moment-payload"],
  ["authors", "client-authors"],
  ["automation-authors", "client-authors"],
  ["automation-presser", "client-authors"],
  ["automation-claim", "client-authors"],
  ["mixed-authors", "client-authors"],
  ["human-authors", "client-authors"],
  ["mixed-forged-human", "client-authors"],
  ["replay", "predecessor-published-past"],
  ["copied-ref", "predecessor-published-past"],
  ["fence", "accepted-event-binding"],
  ["future-cursor", "journal-endpoint"],
  ["after-path", "moment-payload"],
  ["operation", "moment-payload"],
])(
  "consumes forged %s proof without changing current content",
  async (field, check) => {
    const f = registered({ deployment: true });
    try {
      const first = publication(f, "first", 0, f.input.evidence.projectedMarkdownSha256, 0,
        field.startsWith("automation-") ? {automationId:"collection:Tasks#mark",attribution:{actorKind:"automation",onBehalfOf:"owner",depth:2,
          run:{claimId:"claim",automationName:"Mark task"}}} : undefined);
      if (field === "replay" || field === "copied-ref") {
        await prepare(f, [first.op]);
        append(f, [first.op]);
        first.op.originSeq = 1;
      }
      const payload = structuredClone(first.payload) as Record<string, unknown>,
        reference = payload.settlementReference as {
          record: Record<string, unknown>;
          recordDigest: string;
        };
      if (field === "before") payload.payloadBeforeBlobSha256 = "a".repeat(64);
      if (field === "state") {
        reference.record.acceptedStateBlobSha256 =
          f.input.evidence.checkpoint.updateDigest;
        f.storage.putBlob({
          workspaceId: "workspace",
          sha256: f.input.evidence.checkpoint.updateDigest,
          content: f.input.baselineBytes,
          createdAtMs: 1,
        });
      }
      if (field === "scope") reference.record.relayDatabaseNamespace = "other";
      if (field === "moment") payload.momentId = "other";
      if (field === "authors")
        payload.authors = [{ kind: "agent", agentId: "forged" }];
      if (field.startsWith("automation-"))
        payload.authors = [{kind: "automation", automationId: "collection:Tasks#mark", depth: 2,
          ...(field === "automation-presser" ? {onBehalfOf: "forged-presser"} : {}),
          ...(field === "automation-claim" ? {attribution: {actorKind: "automation", depth: 2, run: {claimId: "forged-claim", automationName: "Forged"}}} : {})}];
      if (field === "mixed-authors")
        payload.authors = [
          { kind: "human", humanId: "reader", humanName: "Reader" },
          { kind: "agent", agentId: "forged" },
        ];
      if (field === "human-authors")
        payload.authors = [
          { kind: "human", humanId: "forged", humanName: "Forged" },
        ];
      if (field === "mixed-forged-human")
        payload.authors = [
          {
            kind: "agent",
            agentId: "trip",
            agentName: "Trip",
            onBehalfOf: "reader",
            depth: 2,
          },
          { kind: "human", humanId: "forged", humanName: "Forged" },
        ];
      if (field === "copied-ref") {
        payload.momentId = "copied";
        reference.record.momentId = "copied";
        reference.record.settlementId = "copied";
      }
      if (field === "after-path")
        payload.payloadAfterPath = "private/forged.md";
      if (field === "operation") payload.operation = "delete";
      if (field === "future-cursor") reference.record.terminalCursor = first.record.terminalCursor + 100;
      if (field === "fence")
        reference.record.binding = {
          ...first.record.binding,
          restoreFenceGeneration: 99,
        };
      reference.recordDigest = hash(stableJsonStringify(reference.record));
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
      ).toBe(field === "replay" || field === "copied-ref" ? 1 : 0);
    } finally {
      f.close();
    }
  },
);
it("exhausts the shared per-push budget retryably without consuming a coordinate", async () => {
  const f = registered({ deployment: true });
  try {
    const first = publication(f, "first");
    await expect(
      prepare(f, [first.op, {originSeq:1,opKind:"opaque",payloadJson:"{}",recordedAtMs:1}], new RestoreHistoryBudget(1, 100)),
    ).rejects.toMatchObject({ code: "settlement_proof_budget" });
    expect(f.storage.maxOriginSeq("workspace", "proof")).toBe(-1);
  } finally {
    f.close();
  }
});
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
it("rejects altered full content with the same CRDT clocks", async () => {
  const f = registered({ deployment: true });
  try {
    const first = publication(f, "first"),
      bytes = encodeStateAsUpdate(f.doc),
      needle = new TextEncoder().encode("Hello");
    const index = bytes.findIndex((_, offset) =>
      needle.every((byte, j) => bytes[offset + j] === byte),
    );
    expect(index).toBeGreaterThanOrEqual(0);
    bytes[index] = 74;
    const sha = hash(bytes);
    f.storage.putBlob({
      workspaceId: "workspace",
      sha256: sha,
      content: bytes,
      createdAtMs: 1,
    });
    first.record.acceptedStateBlobSha256 = sha;
    first.payload.settlementReference.recordDigest = hash(
      stableJsonStringify(first.record),
    );
    first.op.payloadJson = stableJsonStringify(first.payload);
    await prepare(f, [first.op]);
    expect(append(f, [first.op]).settlementRefusals).toHaveLength(1);
    expect(refusedChecks()).toEqual(["prepare state-digest"]);
  } finally {
    f.close();
  }
});

it.each(["bytes", "events"])("acknowledges a singleton over the %s budget and publishes its unavailable fallback and later work", async limit => {
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
    first.payload.settlementReference.recordDigest = hash(stableJsonStringify(first.record));
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
    forged.settlementReference.record.settlementId = "copied-automation";
    forged.settlementReference.recordDigest = hash(stableJsonStringify(forged.settlementReference.record));
    const copied = {...first.op, originSeq: 1, payloadJson: stableJsonStringify(forged)};
    await prepare(f, [copied]);
    expect(append(f, [copied]).settlementRefusals).toHaveLength(1);
    expect(refusedChecks()).toEqual(["prepare predecessor-published-past"]);
  } finally {f.close();}
});

it("folds automation depth across authenticated contributors while preserving the first declaration", async () => {
  const f=registered({deployment:true});
  try {
    const automation={automationId:"collection:Tasks#mark",attribution:{actorKind:"automation" as const,onBehalfOf:"owner",depth:2,
      run:{claimId:"claim",automationName:"Mark task"}}};
    publication(f,"automation-first",0,f.input.evidence.projectedMarkdownSha256,0,automation);
    f.doc.clientID=987654321;
    const last=publication(f,"automation-last",0,f.input.evidence.projectedMarkdownSha256,0,
      {...automation,attribution:{...automation.attribution,depth:3}});
    await prepare(f,[last.op]);
    expect(append(f,[last.op]).settlementRefusals).toBeUndefined();
    expect(f.storage.fetchLogCoordinate({workspaceId:"workspace",originId:"proof",originSeq:0})?.admittedAuthorSnapshot)
      .toEqual([{kind:"automation",...automation,attribution:{...automation.attribution,depth:3}}]);
  } finally {f.close();}
});
it.each(["transition", "skipped-base"])("anchors a changed full selector binding to its accepted predecessor: %s", async variant => {
  const f=registered({deployment:true});
  try {
    const first=publication(f,"old-selector");await prepare(f,[first.op]);append(f,[first.op]);
    f.write(db=>db.prepare("UPDATE sync_relay_shares SET selector_json=? WHERE share_id='share'")
      .run(JSON.stringify({paths:["docs/a.md"],versionId:null})));
    const next=publication(f,"new-selector",first.receipt.journalCursor,first.markdownSha,1);
    expect(next.record.binding.selectorPaths).not.toEqual(first.record.binding.selectorPaths);
    let selected=next;
    if(variant==="skipped-base")selected=publication(f,"skipped-selector",next.receipt.journalCursor,next.markdownSha,1);
    await prepare(f,[selected.op]);
    const result=append(f,[selected.op]);
    if(variant==="transition") {
      expect(result.settlementRefusals).toBeUndefined();
      const later=publication(f,"later-selector",next.receipt.journalCursor,next.markdownSha,2);
      await prepare(f,[later.op]);expect(append(f,[later.op]).settlementRefusals).toBeUndefined();
    } else {
      expect(result.settlementRefusals).toHaveLength(1);
      expect(refusedChecks()).toEqual(["prepare base-binding-change"]);
    }
  } finally {f.close();}
});


it.each([false, true])("anchors a projection-neutral accepted gap with same-push=%s", async samePush => {
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

it.each([
  ["changed-markdown", "predecessor-unchanged-gap"], ["missing-cut", "predecessor-unchanged-gap"],
  ["wrong-document", "journal-endpoint"], ["selector", "predecessor-unchanged-gap"], ["path", "predecessor-unchanged-gap"],
  ["fence", "predecessor-unchanged-gap"], ["namespace", "predecessor-unchanged-gap"], ["restore", "predecessor-unchanged-gap"],
  ["backwards", "predecessor-published-past"],
])(
  "refuses an advanced publication anchor with %s", async (variant, check) => {
    const f = registered({deployment: true});
    try {
      const first = publication(f, "first"); await prepare(f, [first.op]); append(f, [first.op]);
      const gap = publication(f, "gap", first.receipt.journalCursor, first.markdownSha, 1,
        undefined, f.update("title", "first"));
      const selected = publication(f, "selected", gap.receipt.journalCursor, first.markdownSha, 1,
        undefined, f.update("title", variant === "changed-markdown" ? "different" : "first"));
      const next = publication(f, "next", variant === "backwards" ? 0 : selected.receipt.journalCursor, first.markdownSha, 1);
      f.write(db => {
        if (variant === "missing-cut") db.prepare("DELETE FROM sync_relay_live_settlement_cuts WHERE journal_cursor=?").run(selected.receipt.journalCursor);
        if (variant === "wrong-document") {
          db.exec("PRAGMA defer_foreign_keys=ON");
          db.prepare("UPDATE sync_relay_live_update_struct_provenance SET object_id='other' WHERE journal_cursor=?").run(selected.receipt.journalCursor);
          db.prepare("UPDATE sync_relay_live_update_journal SET object_id='other' WHERE journal_cursor=?").run(selected.receipt.journalCursor);
        }
        const change: Record<string, [string, string | number]> = {
          selector: ["selector_paths_json", '["docs/other.md"]'], path: ["current_path", "docs/other.md"],
          fence: ["restore_fence_generation", first.record.binding.restoreFenceGeneration + 1], namespace: ["relay_database_namespace", "other"],

        };
        if (variant === "restore") {
          const b = first.record.binding;
          db.prepare(`INSERT INTO sync_relay_live_restore_operations
            (operation_id,relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id,
              intent_json,basis_json,phase,old_fence,revoked_generation,invalidated_at_ms,accounted_bytes)
            VALUES ('skipped-restore',?,?,?,?,?,'{}','{}','authority-invalidated',?,2,0,1)`)
            .run(first.record.relayDatabaseNamespace,b.workspaceId,b.mainVersionId,b.objectId,b.lineageClaimId,b.restoreFenceGeneration);
          const bytes = encodeStateAsUpdate(f.doc);
          db.prepare(`UPDATE sync_relay_live_update_journal SET restore_operation_id='skipped-restore',
            validation_checkpoint_sha256=?,validation_checkpoint_bytes=? WHERE journal_cursor=?`)
            .run(hash(bytes),bytes,gap.receipt.journalCursor);
        }
        const altered = change[variant];
        if (altered) db.prepare(`UPDATE sync_relay_live_update_journal SET ${altered[0]}=? WHERE journal_cursor=?`).run(altered[1], gap.receipt.journalCursor);
      });
      await prepare(f, [next.op]);
      expect(append(f, [next.op]).settlementRefusals).toHaveLength(1);
      expect(refusedChecks()).toEqual([`prepare ${check}`]);
      expect(f.raw.prepare("SELECT COUNT(*) AS n FROM sync_relay_live_settlement_bindings").get()!.n).toBe(1);
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
