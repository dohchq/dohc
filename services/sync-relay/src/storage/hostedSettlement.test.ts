import { afterAll, afterEach, expect, it } from "vitest";
import {
  registered,
  cleanupLiveDeliveryFixtures,
} from "../../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport.js";
import { prepareHostedSettlements } from "./hostedSettlement.js";
import type { StorageContext } from "./context.js";
afterEach(cleanupLiveDeliveryFixtures);
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
import { encodeStateAsUpdate } from "yjs";
import { createLiveMarkdownRegistrationValidator } from "@dohc/ydoc-projection/live-journal-validation";
import { stableJsonStringify } from "../canonicalJson.js";
import { initialAcceptedHistoryDigest } from "../liveAcceptedHistory.js";
import { RestoreHistoryBudget } from "./liveAcceptedHistory.js";
import { liveValidation } from "../liveValidation.js";
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
  const captured = f.capture(f.update("title", id), id, {
    kind: "named",
    userId: "reader",
    grantId: "grant",
  });
  const accepted = f.storage.commitLiveUpdateJournal({
    ...captured,
    trustedAccount: { accountId: "reader", name: "Reader" },
    metadata: {
      ...captured.metadata,
      authorContext: {
        kind: "account",
        accountId: "reader",
        agent: {
          agentId: "trip",
          agentName: "Trip",
          onBehalfOf: "reader",
          depth: 2,
        },
      },
    },
  });
  expect(accepted.result.kind).toBe("accepted");
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
it.each([
  "before",
  "state",
  "scope",
  "moment",
  "authors",
  "mixed-authors",
  "human-authors",
  "mixed-forged-human",
  "replay",
  "copied-ref",
  "fence",
  "after-path",
  "operation",
])(
  "consumes forged %s proof without changing current content",
  async (field) => {
    const f = registered({ deployment: true });
    try {
      const first = publication(f, "first");
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
      prepare(f, [first.op], new RestoreHistoryBudget(1, 100)),
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
  } finally {
    f.close();
  }
});
