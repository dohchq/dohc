import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import * as Y from "yjs";
import { Duplex, PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { parseHostEpoch, parseRelayAcceptedLiveUpdate } from "@dohc/live-session-contract";
import type { Envelope, Request, JsonValue } from "../protocol";

import { encodeNativeRestoreInput } from "./nativeRestore";
import { encodeReplicaJournalPage, type ReplicaRestoreCancellation } from "./replicaJournal";
import {
  EngineClient,
  EngineClientError,
  DuplexEngineClientConnection,
  EngineFrameError,
  EngineRequestDeadlineError,
  EngineRequestError,
  FrameDecoder,
  FrameType,
  encodeFrame,
  type EngineClientConnectOptions,
  type EngineClientConnection,
} from "./engineClient";
import { inEngineRun, insideEngineRun } from "./engineRunScope";

const LIMITS = {
  maxFrameBytes: 1024 * 1024,
  maxBlobChunkBytes: 64 * 1024,
  maxStringBytes: 64 * 1024,
  maxCollectionLen: 1024,
  maxBatchLen: 64,
  maxJsonDepth: 32,
};

it("streams a replica page's exact admitted metadata and binary spans beyond control collection bounds", async () => {
  const peer = new FakePeerConnection(),
    transport = client(peer, {
      privateLiveApplication: { aggregateBytes: 128 * 1024 * 1024, maxUploads: 1 },
    });
  peer.acknowledge();
  await transport.ready();
  const update = Uint8Array.from([0, 255, 128, 1]),
    checkpoint = Uint8Array.from([8, 9, 10]);
  const metadata = {
    accepted: {
      receipt: {
        deliveryId: "replica",
        updateDigest: createHash("sha256").update(update).digest("hex"),
        journalCursor: 9,
        acceptingHostEpoch: parseHostEpoch(1),
      },
      binding: {
        workspaceId: "ws",
        mainVersionId: "main",
        objectId: "object",
        lineageClaimId: "a".repeat(64),
        currentPath: "a.md",
        selectorPaths: ["a.md"],
        restoreFenceGeneration: 1,
      },
      authority: {
        principalKind: "owner" as const,
        principalId: "owner",
        grantId: null,
        grantGeneration: null,
      },
      receivedAtMs: 10,
    },
    firstSeen: Array.from({ length: 2000 }, (_, i) => ({
      clientId: i + 1,
      startClock: 0,
      endClock: 1,
    })),
  };
  let wireId = 0;
  const chunks: Buffer[] = [];
  peer.onEnvelope = (e) => {
    if (e.type === "request") {
      expect(e.method).toBe("replica.applyJournalPage");
      expect(e.params).not.toHaveProperty("registrationId");
      wireId = e.id;
    }
  };
  peer.onBlobChunk = (f) => {
    chunks.push(f.payload);
    if (f.fin)
      peer.send({
        type: "response",
        id: wireId,
        result: {
          revision: 2,
          logCursor: 3,
          journalCursor: 9,
          applied: 1,
          skipped: 0,
          blockedCursor: null,
        },
      });
  };
  try {
    const result = await transport.applyReplicaJournalPage(
      { id: 71, workspace: "private", deadlineMs: 30_000 },
      0,
      0,
      [
        {
          admitted: { metadata, updateBytes: update },
          relayDatabaseNamespace: "relay",
          evidenceDigest: "b".repeat(64),
          journalCursor: 9,
          authority: null,
          restore: {
            operationId: "restore",
            checkpointDigest: "c".repeat(64),
            checkpointBytes: checkpoint,
            proof: {
              proposalDigest: "d".repeat(64),
              candidateDigest: metadata.accepted.receipt.updateDigest,
              preparation: {
                fence: {
                  operation: {
                    point: { journalCursor: 0, receiptDigest: "e".repeat(64) },
                    operationId: "restore",
                    relayDatabaseNamespace: "relay",
                    oldBinding: { ...metadata.accepted.binding, restoreFenceGeneration: 0 },
                    hostId: "host",
                    newFence: 1,
                    origin: { kind: "bootstrap", id: "bootstrap" },
                    terminal: null,
                    appliedSequence: 0,
                  },
                  localHeadSequence: 1,
                  recordedAtMs: 10,
                },
                point: {
                  journalCursor: 0,
                  receiptDigest: "e".repeat(64),
                  markdownDigest: "f".repeat(64),
                  projectionDigest: "a".repeat(64),
                },
              },
              nativeSourceManifestDigest: "b".repeat(64),
              admitted: metadata,
              checkpointDigest: "c".repeat(64),
              sourceRanges: [],
              recordedAtMs: 10,
            },
          },
        },
      ],
    );
    expect(result.journalCursor).toBe(9);
    const bytes = Buffer.concat(chunks);
    let offset = 0;
    const field = () => {
      const size = bytes.readUInt32LE(offset);
      offset += 4;
      const value = bytes.subarray(offset, offset + size);
      offset += size;
      return value;
    };
    const rows = JSON.parse(field().toString());
    expect(rows[0].admitted).toEqual({ metadata, updateBytes: [] });
    expect(field()).toEqual(Buffer.from(update));
    expect(field()).toEqual(Buffer.from(checkpoint));
    expect(offset).toBe(bytes.length);
    expect(chunks.length).toBeGreaterThan(1);
  } finally {
    transport.close();
  }
});

it("encodes a replica cancellation entry in order and without byte spans", () => {
  const update = Uint8Array.from([1, 2, 3]),
    binding = {
      workspaceId: "ws",
      mainVersionId: "main",
      objectId: "object",
      lineageClaimId: "a".repeat(64),
      currentPath: "a.md",
      selectorPaths: ["a.md"],
      restoreFenceGeneration: 1,
    };
  const metadata = {
    accepted: {
      receipt: {
        deliveryId: "replica",
        updateDigest: createHash("sha256").update(update).digest("hex"),
        journalCursor: 9,
        acceptingHostEpoch: parseHostEpoch(1),
      },
      binding,
      authority: {
        principalKind: "owner" as const,
        principalId: "owner",
        grantId: null,
        grantGeneration: null,
      },
      receivedAtMs: 10,
    },
    firstSeen: [],
  };
  const cancellation: ReplicaRestoreCancellation = {
    relayDatabaseNamespace: "relay",
    journalCursor: 8,
    cancellation: {
      fence: {
        operation: {
          point: { journalCursor: 0, receiptDigest: binding.lineageClaimId },
          operationId: "restore",
          relayDatabaseNamespace: "relay",
          oldBinding: { ...binding, restoreFenceGeneration: 0 },
          hostId: "host",
          newFence: 1,
          origin: { kind: "bootstrap", id: "bootstrap" },
          terminal: null,
          appliedSequence: 0,
        },
        localHeadSequence: 1,
        recordedAtMs: 10,
      },
      binding,
      endpoint: { terminalReceipt: null, eventCount: 0, historyEvidenceDigest: "b".repeat(64) },
      recordedAtMs: 11,
    },
    authority: {
      lineageClaimId: binding.lineageClaimId,
      baselineSequence: 1,
      restoreFenceGeneration: 1,
    },
  };
  const bytes = encodeReplicaJournalPage([
    cancellation,
    {
      admitted: { metadata, updateBytes: update },
      relayDatabaseNamespace: "relay",
      evidenceDigest: "c".repeat(64),
      journalCursor: 9,
      authority: null,
      restore: null,
    },
  ]);
  let offset = 0;
  const field = () => {
    const size = bytes.readUInt32LE(offset);
    offset += 4;
    const value = bytes.subarray(offset, offset + size);
    offset += size;
    return value;
  };
  const entries = JSON.parse(field().toString());
  expect(entries[0]).toEqual(cancellation);
  expect(entries[1].admitted).toEqual({ metadata, updateBytes: [] });
  expect(field()).toEqual(Buffer.from(update));
  expect(offset).toBe(bytes.length);
});

describe("private owner delivery transport", () => {
  const request = { id: 970, workspace: "workspace", deadlineMs: 30_000 };
  const target = {
    binding: {
      workspaceId: "workspace",
      mainVersionId: "main",
      objectId: "object",
      lineageClaimId: "cd".repeat(32),
      currentPath: "a.md",
      selectorPaths: ["a.md"],
      restoreFenceGeneration: 0,
    },
    relayDatabaseNamespace: "relay",
  };
  const stopTarget = {
    ...target,
    document: { mainVersionId: "main", objectId: "object", currentPath: "a.md" },
    retirementOwed: true,
  };
  it("sends Stop request, release, list and cancellation with exact coordinates", async () => {
    const peer = new FakePeerConnection(),
      transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    // The first cancellation clears a finished Stop, which no list shows; the second finds none.
    const finished = { ...stopTarget, state: "released", retirementOwed: false };
    let cleared = 0;
    peer.onEnvelope = (e) => {
      if (e.type !== "request") return;
      const action = e.method.split(".").at(-1);
      expect(e.method).toBe(`ydoc.ownerStop.${action}`);
      expect(e.params).toEqual(
        action === "release"
          ? { binding: target.binding, acceptedCursor: 0 }
          : action === "list"
            ? {}
            : action === "clear"
              ? { document: stopTarget.document }
              : { path: "a.md" },
      );
      peer.send({
        type: "response",
        id: e.id,
        result: {
          stops:
            action === "clear"
              ? cleared++ === 0
                ? [finished]
                : cleared === 2
                  ? []
                  : [finished, finished]
              : [
                  {
                    ...stopTarget,
                    ...(action === "release"
                      ? { state: "released", materialized: true }
                      : { state: "requested" }),
                  },
                ],
        },
      });
    };
    try {
      expect((await transport.ownerYDocStopRequest(request, "a.md")).state).toBe("requested");
      expect(
        await transport.ownerYDocRelease(request, target.binding, { acceptedCursor: 0 }),
      ).toMatchObject({ state: "released", materialized: true });
      expect(await transport.ownerYDocStopList(request)).toEqual([
        { ...stopTarget, state: "requested" },
      ]);
      expect(await transport.ownerYDocStopClear(request, stopTarget.document)).toEqual(finished);
      expect(await transport.ownerYDocStopClear(request, stopTarget.document)).toBeUndefined();
      await expect(transport.ownerYDocStopClear(request, stopTarget.document)).rejects.toThrow(
        "Invalid Stop cancellation response.",
      );
    } finally {
      transport.close();
    }
  });
  it.each(["binding"])("rejects an invalid Stop release response: %s", async (scenario) => {
    const peer = new FakePeerConnection(),
      transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const row = {
      ...stopTarget,
      state: "released",
      materialized: true,
      ...(scenario === "binding"
        ? { binding: { ...stopTarget.binding, restoreFenceGeneration: 1 } }
        : scenario === "state"
          ? { state: "requested" }
          : scenario === "extra"
            ? { extra: true }
            : scenario === "unmaterialized"
              ? { materialized: undefined }
              : scenario === "materialized text"
                ? { materialized: "yes" }
                : { relayDatabaseNamespace: "" }),
    };
    peer.onEnvelope = (e) => {
      if (e.type === "request") peer.send({ type: "response", id: e.id, result: { stops: [row] } });
    };
    try {
      await expect(
        transport.ownerYDocRelease(request, target.binding, { acceptedCursor: 0 }),
      ).rejects.toThrow(TypeError);
    } finally {
      transport.close();
    }
  });
  it.each(["active", "cursor mismatch"])(
    "decodes listed draft %s and retains page policy",
    async (scenario) => {
      const peer = new FakePeerConnection(),
        transport = client(peer, {
          privateLiveApplication: { aggregateBytes: 128 * 1024 * 1024, maxUploads: 1 },
        });
      peer.acknowledge();
      await transport.ready();
      const state =
        scenario === "active" || scenario === "sealed" || scenario === "quarantined"
          ? scenario
          : null;
      const descriptor = {
        ...target,
        revision: 1,
        acceptedCursor: 0,
        nativeHeadSequence: 2,
        nativeUnsettled: false,
        outboxId: state === null ? null : "outbox",
        pendingBytes: scenario === "absent bytes" ? 1 : 0,
        state,
      };
      const draft =
        scenario === "extra"
          ? { ...descriptor, extra: true }
          : scenario === "binding extra"
            ? { ...descriptor, binding: { ...descriptor.binding, extra: true } }
            : descriptor;
      const next = {
        mainVersionId: "main",
        objectId: scenario === "cursor mismatch" ? "other" : "object",
        lineageClaimId: target.binding.lineageClaimId,
      };
      peer.onEnvelope = (e) => {
        if (e.type === "request")
          peer.send({ type: "response", id: e.id, result: { drafts: [draft], next } });
      };
      try {
        const pending = transport.ownerYDocListDrafts(request, { after: null, limit: 1 });
        if ([null, "active", "sealed", "quarantined"].includes(scenario))
          await expect(pending).resolves.toEqual({ drafts: [descriptor], next });
        else
          await expect(pending).rejects.toThrow(
            scenario === "cursor mismatch" ? "Draft cursor differs from page" : TypeError,
          );
      } finally {
        transport.close();
      }
    },
  );
  it.each(["valid", "binding mismatch", "namespace mismatch"])(
    "preserves observed-enrollment target comparisons: %s",
    async (scenario) => {
      const peer = new FakePeerConnection(),
        transport = client(peer, {
          privateLiveApplication: { aggregateBytes: 128 * 1024 * 1024, maxUploads: 1 },
        });
      peer.acknowledge();
      await transport.ready();
      const draft = {
        ...target,
        binding: {
          ...target.binding,
          objectId: scenario === "binding mismatch" ? "other" : "object",
        },
        relayDatabaseNamespace: scenario === "namespace mismatch" ? "other" : "relay",
        revision: 1,
        acceptedCursor: 0,
        nativeHeadSequence: 2,
        nativeUnsettled: false,
        outboxId: null,
        pendingBytes: 0,
        state: null,
      };
      peer.onEnvelope = (e) => {
        if (e.type === "request")
          peer.send({ type: "response", id: e.id, result: { status: "observed", draft } });
      };
      try {
        const pending = transport.ownerYDocPrepareEnrollment(request, target);
        if (scenario === "valid")
          await expect(pending).resolves.toEqual({ status: "observed", draft });
        else await expect(pending).rejects.toThrow("Owner enrollment target changed");
      } finally {
        transport.close();
      }
    },
  );

  it.each(["binding", "cursor"])(
    "preserves enrollment %s comparisons after upload",
    async (scenario) => {
      const peer = new FakePeerConnection(),
        transport = client(peer, {
          privateLiveApplication: { aggregateBytes: 128 * 1024 * 1024, maxUploads: 1 },
        });
      peer.acknowledge();
      await transport.ready();
      const draft = {
        ...target,
        binding: { ...target.binding, objectId: scenario === "binding" ? "other" : "object" },
        relayDatabaseNamespace: scenario === "namespace" ? "other" : "relay",
        revision: scenario === "revision" ? 2 : 1,
        acceptedCursor: scenario === "cursor" ? 8 : 9,
        nativeHeadSequence: 3,
        nativeUnsettled: false,
        outboxId: null,
        pendingBytes: 0,
        state: null,
      };
      let wireId = 0;
      peer.onEnvelope = (e) => {
        if (e.type === "request") wireId = e.id;
      };
      peer.onBlobChunk = (frame) => {
        if (frame.fin) peer.send({ type: "response", id: wireId, result: { draft } });
      };
      try {
        await expect(
          transport.ownerYDocEnroll(request, {
            ...target,
            captured: { nativeHeadSequence: 2, localStateDigest: "ab".repeat(32) },
            journalCursor: 9,
            hostVector: Uint8Array.of(0),
            checkpoint: Uint8Array.of(0, 0),
          }),
        ).rejects.toThrow("Owner enrollment differs from request");
      } finally {
        transport.close();
      }
    },
  );
  it.each(["active", "wrong digest"])(
    "checks draft append %s replies after binary upload",
    async (scenario) => {
      const peer = new FakePeerConnection(),
        transport = client(peer, {
          privateLiveApplication: { aggregateBytes: 128 * 1024 * 1024, maxUploads: 1 },
        });
      peer.acknowledge();
      await transport.ready();
      let wireId = 0,
        digest = "";
      const chunks: Buffer[] = [];
      peer.onEnvelope = (envelope) => {
        if (envelope.type !== "request") return;
        expect(envelope.method).toBe("ydoc.ownerDelivery.appendDraft");
        wireId = envelope.id;
        digest = (envelope.params as Record<string, string>).digest;
      };
      peer.onBlobChunk = (frame) => {
        chunks.push(Buffer.from(frame.payload));
        if (!frame.fin) return;
        expect(createHash("sha256").update(Buffer.concat(chunks)).digest("hex")).toBe(digest);
        const result = {
          outboxId: "outbox",
          sequence: 1,
          deliveryId: "delivery",
          updateDigest: digest,
          pendingBytes: 2,
          oldestEntryAtMs: 0,
          state: scenario === "sealed" ? "sealed" : "active",
        };
        const reply =
          scenario === "extra"
            ? { ...result, extra: true }
            : scenario === "wrong digest"
              ? { ...result, updateDigest: "ab".repeat(32) }
              : scenario === "zero count"
                ? { ...result, pendingBytes: 0 }
                : scenario === "invalid ID"
                  ? { ...result, deliveryId: "bad\u0000" }
                  : scenario === "null"
                    ? null
                    : scenario === "array"
                      ? []
                      : result;
        peer.send({ type: "response", id: wireId, result: reply });
      };
      try {
        const pending = transport.ownerYDocAppendDraft(request, {
          binding: target.binding,
          expectedRevision: 1,
          appendKey: "edit",
          updateBytes: Uint8Array.of(0, 0),
        });
        if (scenario === "active" || scenario === "sealed")
          await expect(pending).resolves.toMatchObject({ state: scenario, updateDigest: digest });
        else await expect(pending).rejects.toThrow(TypeError);
        expect(Buffer.concat(chunks)).toEqual(Buffer.from([0, 0]));
      } finally {
        transport.close();
      }
    },
  );
  it("records who stopped or resumed live editing, and rejects a reply it does not recognize", async () => {
    const peer = new FakePeerConnection(),
      transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const author = { kind: "person", personId: "person-1" } as const;
    const begin = {
      objectId: "doc",
      path: "a.md",
      action: "stopped",
      author,
      before: "ready",
    } as const;
    const { objectId, before: _before, ...pending } = begin;
    const changes = [{ objectId, pending: { ...pending, changeId: "c1", atMs: 5 } }];
    const replies: JsonValue[] = [
      { changeId: "c1", atMs: 5 },
      null,
      { finished: true },
      { changes },
      { changeId: "c1", atMs: 5, author },
      { finished: 1 },
      { changes: [{ objectId: "doc", pending: { ...changes[0]!.pending, action: "paused" } }] },
    ];
    const sent: unknown[] = [];
    peer.onEnvelope = (e) => {
      if (e.type === "request") {
        sent.push([e.method, e.params]);
        peer.send({ type: "response", id: e.id, result: replies.shift() ?? null });
      }
    };
    try {
      expect(await transport.ownerLiveChangeBegin(request, begin)).toEqual({
        changeId: "c1",
        atMs: 5,
      });
      // A self-reported name the engine cannot store is left out.
      expect(
        await transport.ownerLiveChangeBegin(request, {
          ...begin,
          before: "retired",
          author: {
            kind: "agent",
            agentId: "a",
            agentName: "x".repeat(65),
            onBehalfOf: "person-1",
            depth: 1,
          },
        }),
      ).toBeNull();
      expect(
        await transport.ownerLiveChangeFinish(request, {
          objectId: "doc",
          changeId: "c1",
          outcome: "applied",
        }),
      ).toBe(true);
      expect(await transport.ownerLiveChangeList(request, ["doc"])).toEqual(changes);
      expect(sent).toEqual([
        ["ydoc.liveChange.begin", begin],
        [
          "ydoc.liveChange.begin",
          {
            ...begin,
            before: "retired",
            author: { kind: "agent", agentId: "a", onBehalfOf: "person-1", depth: 1 },
          },
        ],
        ["ydoc.liveChange.finish", { objectId: "doc", changeId: "c1", outcome: "applied" }],
        ["ydoc.liveChange.list", { objectIds: ["doc"] }],
      ]);
      await expect(transport.ownerLiveChangeBegin(request, begin)).rejects.toThrow(
        "Invalid live change response.",
      );
      await expect(
        transport.ownerLiveChangeFinish(request, {
          objectId: "doc",
          changeId: "c1",
          outcome: "unrecorded",
        }),
      ).rejects.toThrow("Invalid live change response.");
      await expect(transport.ownerLiveChangeList(request, [])).rejects.toThrow(
        "Invalid live change list.",
      );
    } finally {
      transport.close();
    }
  });

  it("discovers durable drafts, opens their binary state and appends without a caller base", async () => {
    const peer = new FakePeerConnection(),
      transport = client(peer, {
        privateLiveApplication: { aggregateBytes: 128 * 1024 * 1024, maxUploads: 1 },
      });
    peer.acknowledge();
    await transport.ready();
    const descriptor = {
      ...target,
      revision: 1,
      acceptedCursor: 0,
      nativeHeadSequence: 2,
      nativeUnsettled: false,
      outboxId: null,
      pendingBytes: 0,
      state: null,
    };
    let wireId = 0,
      digest = "";
    peer.onEnvelope = (e) => {
      if (e.type !== "request") return;
      if (e.method === "ydoc.ownerDelivery.listDrafts")
        peer.send({ type: "response", id: e.id, result: { drafts: [descriptor], next: null } });
      else if (e.method === "ydoc.ownerDelivery.openDraft") {
        const bytes = Buffer.from([0, 0]),
          sha = createHash("sha256").update(bytes).digest("hex");
        peer.send({
          type: "blobStart",
          requestId: e.id,
          streamId: e.id,
          totalBytes: 2,
          sha256: sha,
        });
        peer.sendRaw(blobChunkFrame(e.id, bytes, true));
        peer.send({
          type: "response",
          id: e.id,
          result: {
            status: "draft",
            draft: descriptor,
            streamId: e.id,
            byteLength: 2,
            digest: sha,
          },
        });
      } else {
        expect(e.method).toBe("ydoc.ownerDelivery.appendDraft");
        expect(e.params).not.toHaveProperty("baseUpdate");
        expect(e.params).not.toHaveProperty("registrationId");
        wireId = e.id;
        digest = (e.params as Record<string, string>).digest;
      }
    };
    peer.onBlobChunk = (frame) => {
      if (frame.fin)
        peer.send({
          type: "response",
          id: wireId,
          result: {
            outboxId: "outbox",
            sequence: 1,
            deliveryId: "delivery",
            updateDigest: digest,
            pendingBytes: 2,
            oldestEntryAtMs: 3,
            state: "active",
          },
        });
    };
    try {
      expect(await transport.ownerYDocListDrafts(request, { after: null, limit: 8 })).toEqual({
        drafts: [descriptor],
        next: null,
      });
      expect(
        await transport.ownerYDocOpenDraft(
          { ...request, id: 971 },
          { binding: target.binding, expectedRevision: 1 },
        ),
      ).toEqual({ draft: descriptor, initialUpdate: Buffer.from([0, 0]) });
      expect(
        await transport.ownerYDocAppendDraft(
          { ...request, id: 972 },
          {
            binding: target.binding,
            expectedRevision: 1,
            appendKey: "edit",
            updateBytes: Uint8Array.of(0, 0),
          },
        ),
      ).toMatchObject({ outboxId: "outbox", sequence: 1, pendingBytes: 2 });
    } finally {
      transport.close();
    }
  });
  it("captures native state and enrolls an exact binary host cut without caller limits", async () => {
    const peer = new FakePeerConnection(),
      transport = client(peer, {
        privateLiveApplication: { aggregateBytes: 128 * 1024 * 1024, maxUploads: 1 },
      });
    peer.acknowledge();
    await transport.ready();
    const captured = { nativeHeadSequence: 2, localStateDigest: "ab".repeat(32) },
      draft = {
        ...target,
        revision: 1,
        acceptedCursor: 9,
        nativeHeadSequence: 3,
        nativeUnsettled: false,
        outboxId: "pending",
        pendingBytes: 2,
        state: "active",
      };
    let wireId = 0;
    const chunks: Buffer[] = [];
    peer.onEnvelope = (e) => {
      if (e.type !== "request") return;
      if (e.method === "ydoc.ownerDelivery.prepareEnrollment") {
        expect(e.params).toEqual(target);
        peer.send({ type: "response", id: e.id, result: { status: "capture", captured } });
      } else {
        expect(e.method).toBe("ydoc.ownerDelivery.enroll");
        expect(e.params).toMatchObject({
          ...target,
          captured,
          journalCursor: 9,
          hostVectorByteLength: 1,
        });
        expect(e.params).not.toHaveProperty("limits");
        wireId = e.id;
      }
    };
    peer.onBlobChunk = (frame) => {
      chunks.push(Buffer.from(frame.payload));
      if (frame.fin) peer.send({ type: "response", id: wireId, result: { draft } });
    };
    try {
      expect(await transport.ownerYDocPrepareEnrollment(request, target)).toEqual({
        status: "capture",
        captured,
      });
      expect(
        await transport.ownerYDocEnroll(
          { ...request, id: 971 },
          {
            ...target,
            captured,
            journalCursor: 9,
            hostVector: Uint8Array.of(0),
            checkpoint: Uint8Array.of(0, 0),
          },
        ),
      ).toEqual(draft);
      expect(Buffer.concat(chunks)).toEqual(Buffer.from([0, 0, 0]));
    } finally {
      transport.close();
    }
  });
  it("reads a retired generation exactly and refuses extra keys", async () => {
    const peer = new FakePeerConnection(),
      transport = client(peer, {
        privateLiveApplication: { aggregateBytes: 128 * 1024 * 1024, maxUploads: 1 },
      });
    peer.acknowledge();
    await transport.ready();
    let answered = 0;
    peer.onEnvelope = (e) => {
      if (e.type === "request")
        peer.send({
          type: "response",
          id: e.id,
          result: answered++ === 0 ? { status: "retired" } : { status: "retired", draft: null },
        });
    };
    try {
      expect(await transport.ownerYDocPrepareEnrollment(request, target)).toEqual({
        status: "retired",
      });
      await expect(
        transport.ownerYDocPrepareEnrollment({ ...request, id: 973 }, target),
      ).rejects.toThrow("Invalid owner capture response.");
    } finally {
      transport.close();
    }
  });

  it("checks receipt containment separately and rejects a mismatched applied cursor", async () => {
    const peer = new FakePeerConnection(),
      transport = client(peer, {
        privateLiveApplication: { aggregateBytes: 128 * 1024 * 1024, maxUploads: 1 },
      });
    peer.acknowledge();
    await transport.ready();
    let wireId = 0;
    peer.onEnvelope = (e) => {
      if (e.type !== "request") return;
      wireId = e.id;
      if (e.method === "ydoc.ownerDelivery.isReceiptApplied")
        peer.send({ type: "response", id: e.id, result: { applied: false } });
    };
    peer.onBlobChunk = (frame) => {
      if (frame.fin)
        peer.send({
          type: "response",
          id: wireId,
          result: { revision: 2, acceptedCursor: 18, nativeHeadSequence: 3 },
        });
    };
    try {
      expect(
        await transport.ownerYDocIsReceiptApplied(request, {
          ...target,
          receipt: {
            deliveryId: "delivery",
            updateDigest: "ab".repeat(32),
            journalCursor: 19,
            acceptingHostEpoch: 1,
          },
        }),
      ).toBe(false);
      await expect(
        transport.ownerYDocApplyAcceptedFrame(
          { ...request, id: 971 },
          {
            ...target,
            expectedRevision: 1,
            expectedNativeHeadSequence: 2,
            previousAcceptedCursor: 0,
            journalCursor: 19,
            updateBytes: Uint8Array.of(0, 0),
          },
        ),
      ).rejects.toThrow("differs from request");
    } finally {
      transport.close();
    }
  });
});

describe("private imported owner capture", () => {
  it("captures on an attached workspace before registration and preserves a shared client on cancellation", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer, {
      privateLiveApplication: { aggregateBytes: 128 * 1024 * 1024, maxUploads: 1 },
    });
    peer.acknowledge();
    await transport.ready();
    const closed = vi.spyOn(peer, "close");
    const arrived = Promise.withResolvers<void>();
    let respond = false,
      retained = false;
    const baseline = Buffer.from([0, 0]),
      full = Buffer.from([1, 1, 1]),
      bytes = Buffer.concat([baseline, full]);
    const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
    peer.onEnvelope = (envelope) => {
      if (envelope.type !== "request") return;
      expect(envelope.method).toBe("liveApplication.captureOwnerActivation");
      expect(envelope.params).toEqual({
        path: "owner.md",
        maxBytes: 1000,
        ...(retained ? { activationId: `ordinary-activation-${"a".repeat(64)}` } : {}),
      });
      arrived.resolve();
      if (!respond) return;
      const id = envelope.id;
      peer.send({
        type: "blobStart",
        requestId: id,
        streamId: id,
        totalBytes: bytes.length,
        sha256: digest(bytes),
      });
      peer.sendRaw(blobChunkFrame(id, bytes, true));
      peer.send({
        type: "response",
        id,
        result: {
          status: "captured",
          activationId: `ordinary-activation-${"a".repeat(64)}`,
          sessionId: "native-session",
          baselineByteLength: baseline.length,
          streamId: id,
          byteLength: bytes.length,
          digest: digest(bytes),
          source: {
            version: 1,
            relayDatabaseNamespace: "relay",
            workspaceId: "workspace",
            mainVersionId: "main",
            objectId: "object",
            lineageClaimId: digest(baseline),
            currentPath: "owner.md",
            replicationEpoch: "epoch",
            streamIdentity: "stream",
            committedCursor: 10,
            baseOriginId: "peer",
            baseOriginSeq: 2,
            baseRelaySeq: 8,
            sourceMomentId: "source",
            sourceDigest: digest(Buffer.from("source")),
            sourceByteLength: 6,
            nativeHeadSequence: 1,
            fullStateDigest: digest(full),
            fullStateByteLength: full.length,
          },
        },
      });
    };
    try {
      const request = { id: 975, workspace: "workspace", deadlineMs: 30_000 };
      const abort = new AbortController();
      const pending = transport.captureOwnerActivation(request, "owner.md", 1000, abort.signal);
      const rejected = expect(pending).rejects.toThrow();
      await arrived.promise;
      abort.abort();
      await rejected;
      expect(closed).not.toHaveBeenCalled();
      respond = true;
      const captured = await transport.captureOwnerActivation(
        { ...request, id: 976 },
        "owner.md",
        1000,
      );
      expect(captured.sessionId).toBe("native-session");
      expect(captured.fullState).toEqual(full);
      retained = true;
      const resumed = await transport.captureOwnerActivation(
        { ...request, id: 977 },
        "owner.md",
        1000,
        undefined,
        captured.activationId,
      );
      expect(resumed.activationId).toBe(captured.activationId);
      expect(resumed.source).toEqual(captured.source);
    } finally {
      transport.close();
    }
  });
});

describe("private applied sync transport", () => {
  const request = { id: 970, workspace: "workspace", registrationId: 7, deadlineMs: 30_000 };
  const position = { eventCount: 0, journalCursor: 0, evidenceDigest: "ab".repeat(32) };
  const binding = {
    workspaceId: "workspace",
    mainVersionId: "main",
    objectId: "object",
    lineageClaimId: "cd".repeat(32),
    currentPath: "a.md",
    selectorPaths: ["a.md"],
    restoreFenceGeneration: 0,
  };
  const outputBytes = Buffer.from([0, 0, 0]);
  function output(
    peer: FakePeerConnection,
    id: number,
    result: Record<string, JsonValue>,
    bytes = outputBytes,
  ) {
    const digest = createHash("sha256").update(bytes).digest("hex");
    peer.send({
      type: "blobStart",
      requestId: id,
      streamId: id,
      totalBytes: bytes.length,
      sha256: digest,
    });
    peer.sendRaw(blobChunkFrame(id, bytes, true));
    peer.send({
      type: "response",
      id,
      result: { ...result, streamId: id, byteLength: bytes.length, digest },
    });
  }
  it.each(["chunk", "final"] as ReadonlyArray<"queued" | "header" | "chunk" | "final">)(
    "finishes reserved sync input after cancellation at %s without closing another reader",
    async (mode) => {
      const peer = new FakePeerConnection(),
        transport = client(peer, {
          privateLiveApplication: { aggregateBytes: 128 * 1024 * 1024, maxUploads: 1 },
        });
      peer.acknowledge();
      await transport.ready();
      const closed = vi.spyOn(peer, "close"),
        reached = Promise.withResolvers<void>();
      const vector = Buffer.alloc(2 * LIMITS.maxBlobChunkBytes + 1, 7),
        expectedVector = vector.slice();
      const chunks: Buffer[] = [];
      let blockerId = 0,
        wireId = 0,
        held = false;
      const hold = () => {
        if (!held) {
          held = true;
          peer.backpressured = true;
          reached.resolve();
        }
      };
      peer.onEnvelope = (envelope) => {
        if (envelope.type !== "request") return;
        if (envelope.method === "blocker") {
          blockerId = envelope.id;
          hold();
        } else if (envelope.method === "liveApplication.syncOpen") {
          wireId = envelope.id;
          if (mode === "header") hold();
        } else if (envelope.method === "liveApplication.appliedRead")
          peer.send({
            type: "response",
            id: envelope.id,
            result: { status: "empty", after: position },
          });
        else if (envelope.method === "liveApplication.ack")
          peer.send({ type: "response", id: envelope.id, result: { status: "missing" } });
      };
      peer.onBlobChunk = (frame) => {
        chunks.push(Buffer.from(frame.payload));
        if ((mode === "chunk" && !frame.fin) || (mode === "final" && frame.fin)) hold();
      };
      const signal = new AbortController();
      let blocker: Promise<unknown> | undefined;
      try {
        if (mode === "queued") {
          blocker = transport.sendRequest({
            id: 969,
            method: "blocker",
            params: {},
            deadlineMs: 30_000,
          });
          void blocker.catch(() => {});
          await reached.promise;
        }
        const sync = transport.openLiveAppliedSync(
          request,
          vector,
          { maxInputBytes: vector.length, maxOutputBytes: 32 },
          signal.signal,
        );
        const cancelled = sync.catch((error) => error);
        if (mode !== "queued") await reached.promise;
        signal.abort(new Error("browser closed"));
        expect(closed).not.toHaveBeenCalled();
        await expect(
          transport.readNextLiveApplied({ ...request, id: 971 }, position, 32),
        ).rejects.toThrow("capacity is full");
        if (blockerId) peer.send({ type: "response", id: blockerId, result: { done: true } });
        peer.drain();
        await blocker;
        expect(await cancelled).toBeInstanceOf(EngineClientError);
        expect(Buffer.concat(chunks)).toEqual(expectedVector);
        expect(
          await transport.readNextLiveApplied({ ...request, id: 972 }, position, 32),
        ).toBeNull();
        expect(
          await transport.readLiveApplicationAck(
            { ...request, id: 973 },
            { deliveryId: "delivery", updateDigest: "ab".repeat(32) },
          ),
        ).toBeNull();
        expect(peer.received).toContainEqual({ type: "cancel", id: wireId });
        expect(closed).not.toHaveBeenCalled();
      } finally {
        peer.drain();
        transport.close();
      }
    },
  );
  it.each(["valid", "position"])("checks %s sync output", async (mode) => {
    const peer = new FakePeerConnection(),
      transport = client(peer, {
        privateLiveApplication: { aggregateBytes: 128 * 1024 * 1024, maxUploads: 1 },
      });
    peer.acknowledge();
    await transport.ready();
    let id = 0;
    peer.onEnvelope = (e) => {
      if (e.type !== "request") return;
      id = e.id;
      expect(e.method).toBe("liveApplication.syncOpen");
      expect(e.params).toHaveProperty("registrationId", 7);
    };
    peer.onBlobChunk = (frame) => {
      if (frame.fin)
        output(peer, id, {
          status: "sync",
          binding,
          position: mode === "position" ? { ...position, eventCount: 2 } : position,
          observedLocalYDocHeadSequence: 5,
          hostVectorByteLength: mode === "vector-length" ? 2 : 1,
          ...(mode === "extra" ? { extra: true } : {}),
        });
    };
    try {
      const call = transport.openLiveAppliedSync(request, Uint8Array.of(0), {
        maxInputBytes: 8,
        maxOutputBytes: 32,
      });
      if (mode === "valid") {
        const cut = await call;
        expect(cut.hostVector).toEqual(Buffer.from([0]));
        expect(cut.missingStateUpdate).toEqual(Buffer.from([0, 0]));
        expect(cut.observedLocalYDocHeadSequence).toBe(5);
      } else await expect(call).rejects.toThrow();
    } finally {
      transport.close();
    }
  });
  it.each(["update", "gap", "wrong-digest"])("checks %s applied feed output", async (mode) => {
    const peer = new FakePeerConnection(),
      transport = client(peer, {
        privateLiveApplication: { aggregateBytes: 128 * 1024 * 1024, maxUploads: 1 },
      });
    peer.acknowledge();
    await transport.ready();
    peer.onEnvelope = (e) => {
      if (e.type !== "request") return;
      expect(e.method).toBe("liveApplication.appliedRead");
      if (mode === "empty") {
        peer.send({ type: "response", id: e.id, result: { status: "empty", after: position } });
        return;
      }
      if (mode === "empty-with-blob") {
        output(peer, e.id, { status: "empty", after: position });
        return;
      }
      const digest = createHash("sha256").update(outputBytes).digest("hex");
      output(peer, e.id, {
        status: "update",
        position: {
          eventCount: mode === "gap" ? 2 : 1,
          journalCursor: 11,
          evidenceDigest: "ef".repeat(32),
        },
        ack: {
          deliveryId: "delivery",
          updateDigest: mode === "wrong-digest" ? "aa".repeat(32) : digest,
          journalCursor: 11,
          acceptingHostEpoch: 1,
          localYDocSequence: 1,
          applicationReplayed: true,
        },
      });
    };
    try {
      const call = transport.readNextLiveApplied(request, position, 32);
      if (mode === "update") expect((await call)?.position.journalCursor).toBe(11);
      else if (mode === "empty") expect(await call).toBeNull();
      else await expect(call).rejects.toThrow();
    } finally {
      transport.close();
    }
  });
});

describe("private application ACK read", () => {
  const call = { id: 920, workspace: "workspace", registrationId: 7, deadlineMs: 30_000 };
  const identity = { deliveryId: "delivery", updateDigest: "ab".repeat(32) };
  it.each(["historical", "wrong-id", "not-replayed"])("handles %s evidence", async (mode) => {
    const peer = new FakePeerConnection(),
      transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const ack = {
      ...identity,
      journalCursor: 4,
      acceptingHostEpoch: 1,
      localYDocSequence: 2,
      applicationReplayed: true,
    };
    peer.onEnvelope = (envelope) => {
      if (envelope.type !== "request") return;
      expect(envelope.method).toBe("liveApplication.ack");
      expect(envelope.params).toEqual({ registrationId: 7, ...identity });
      let result: Extract<Envelope, { type: "response" }>["result"] = {
        status: "applied",
        ack: {
          ...ack,
          ...(mode === "wrong-id" ? { deliveryId: "other" } : {}),
          ...(mode === "wrong-digest" ? { updateDigest: "cd".repeat(32) } : {}),
          ...(mode === "not-replayed" ? { applicationReplayed: false } : {}),
        },
      };
      if (mode === "missing") result = { status: "missing" };
      if (mode === "relay-receipt")
        result = {
          status: "applied",
          ack: { ...identity, journalCursor: 4, acceptingHostEpoch: 1 },
        };
      if (mode === "extra") result = { status: "missing", ack };
      peer.send({ type: "response", id: envelope.id, result });
    };
    try {
      const pending = transport.readLiveApplicationAck(call, identity);
      if (mode === "historical") expect(await pending).toEqual(ack);
      else if (mode === "missing") expect(await pending).toBeNull();
      else await expect(pending).rejects.toThrow();
    } finally {
      transport.close();
    }
  });
});

describe("private native restore transport", () => {
  const input = encodeNativeRestoreInput(Buffer.from('{"fence":{}}'), 128);
  const call = { id: 903, workspace: "ws-0000000000000001", deadlineMs: 30_000 };
  async function connected() {
    const peer = new FakePeerConnection();
    const transport = client(peer, {
      privateLiveApplication: { aggregateBytes: 128 * 1024 * 1024, maxUploads: 1 },
    });
    peer.acknowledge();
    await transport.ready();
    return { peer, transport };
  }
  function reply(
    peer: FakePeerConnection,
    wireId: number,
    bytes = Buffer.from("raw receipt"),
    status = "applied",
  ) {
    const digest = createHash("sha256").update(bytes).digest("hex");
    peer.send({
      type: "blobStart",
      requestId: wireId,
      streamId: wireId,
      totalBytes: bytes.length,
      sha256: digest,
    });
    peer.sendRaw(blobChunkFrame(wireId, bytes, true));
    peer.send({
      type: "response",
      id: wireId,
      result: { status, streamId: wireId, byteLength: bytes.length, digest },
    });
  }
  it("sends host-scoped binary input and retains raw output through its final descriptor", async () => {
    const { peer, transport } = await connected();
    let wireId = -1;
    peer.onEnvelope = (envelope) => {
      if (envelope.type !== "request") return;
      wireId = envelope.id;
      expect(envelope.method).toBe("liveApplication.applyRestore");
      expect(envelope.params).not.toHaveProperty("registrationId");
      expect(envelope.params).toHaveProperty("maxOutputBytes", 128);
    };
    peer.onBlobChunk = (frame) => {
      if (frame.fin) reply(peer, wireId);
    };
    try {
      const result = await transport.sendLiveRestore(call, "apply", input, 128);
      expect(result.response.id).toBe(call.id);
      expect(result.bytes.toString()).toBe("raw receipt");
    } finally {
      transport.close();
    }
  });
  it.each(["too large", "wrong digest"])("refuses %s restore output", async (mode) => {
    const { peer, transport } = await connected();
    let wireId = -1;
    peer.onEnvelope = (envelope) => {
      if (envelope.type === "request") wireId = envelope.id;
    };
    peer.onBlobChunk = (frame) => {
      if (!frame.fin) return;
      if (mode === "missing blob") {
        peer.send({ type: "response", id: wireId, result: { status: "applied" } });
      } else if (mode === "wrong status") reply(peer, wireId, Buffer.from("raw"), "settled");
      else {
        peer.send({
          type: "blobStart",
          requestId: wireId,
          streamId: wireId,
          totalBytes: mode === "unknown length" ? null : mode === "too large" ? 129 : 3,
          sha256: "a".repeat(64),
        });
        if (mode === "duplicate")
          peer.send({
            type: "blobStart",
            requestId: wireId,
            streamId: wireId + 1,
            totalBytes: 3,
            sha256: "a".repeat(64),
          });
        if (mode === "wrong digest") peer.sendRaw(blobChunkFrame(wireId, Buffer.from("raw"), true));
      }
    };
    try {
      await expect(transport.sendLiveRestore(call, "apply", input, 128)).rejects.toThrow();
    } finally {
      transport.close();
    }
  });
  it("rejects an unsatisfiable restore bound before sending the request", async () => {
    const { peer, transport } = await connected();
    const requests = vi.fn();
    peer.onEnvelope = requests;
    try {
      await expect(
        transport.sendLiveRestore(call, "prepare", input, 64 * 1024 * 1024 + 1),
      ).rejects.toThrow("Invalid native restore bounds");
      expect(requests).not.toHaveBeenCalled();
    } finally {
      transport.close();
    }
  });

  it("releases a cancelled partial response before accepting the next reserved request", async () => {
    const { peer, transport } = await connected();
    let wireId = -1;
    let uploadDone!: () => void;
    const drained = new Promise<void>((resolve) => {
      uploadDone = resolve;
    });
    peer.onEnvelope = (envelope) => {
      if (envelope.type !== "request") return;
      if (envelope.method === "barrier")
        peer.send({ type: "response", id: envelope.id, result: {} });
      else wireId = envelope.id;
    };
    peer.onBlobChunk = (frame) => {
      if (frame.fin) uploadDone();
    };
    const controller = new AbortController();
    const pending = transport.sendLiveRestore(call, "apply", input, 128, controller.signal);
    const rejected = expect(pending).rejects.toThrow();
    try {
      await drained;
      // Yield through the actual write completion before cancelling.
      await transport.sendRequest({ ...request(999, "barrier"), deadlineMs: 30_000 });
      const oldId = wireId;
      const bytes = Buffer.from("raw");
      peer.send({
        type: "blobStart",
        requestId: oldId,
        streamId: oldId,
        totalBytes: 3,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      peer.sendRaw(blobChunkFrame(oldId, bytes.subarray(0, 1), false));
      controller.abort();
      await rejected;
      peer.sendRaw(blobChunkFrame(oldId, bytes.subarray(1), true));
      peer.onBlobChunk = (frame) => {
        if (frame.fin) reply(peer, wireId);
      };
      await expect(
        transport.sendLiveRestore({ ...call, id: 904 }, "apply", input, 128),
      ).resolves.toHaveProperty("bytes");
    } finally {
      controller.abort();
      transport.close();
    }
  });
});

function helloAck(
  limits: typeof LIMITS = LIMITS,
  capabilities: string[] = ["core", "blobs"],
): Extract<Envelope, { type: "helloAck" }> {
  return {
    type: "helloAck",
    protocolVersion: 2,
    sessionGeneration: 7,
    capabilities,
    limits,
  };
}

function event(seq = 1): Extract<Envelope, { type: "event" }> {
  return {
    type: "event",
    seq,
    sessionGeneration: 7,
    name: "workspace.changed",
    payload: { paths: ["note.md"] },
  };
}

function envelopeFrame(envelope: Envelope, maxFrameBytes = LIMITS.maxFrameBytes): Buffer {
  return encodeFrame(1, 0, Buffer.from(JSON.stringify(envelope), "utf8"), maxFrameBytes);
}

function blobChunkFrame(
  streamId: number,
  bytes: Buffer,
  fin: boolean,
  maxBlobChunkBytes = LIMITS.maxBlobChunkBytes,
): Buffer {
  return encodeFrame(FrameType.BlobChunk, fin ? 1 : 0, { streamId, bytes }, maxBlobChunkBytes);
}

class FakePeerConnection implements EngineClientConnection {
  readonly received: Envelope[] = [];
  onEnvelope: ((envelope: Envelope) => void) | null = null;
  onBlobChunk:
    | ((frame: Extract<ReturnType<FrameDecoder["push"]>[number], { kind: "blobChunk" }>) => void)
    | null = null;
  private readonly decoder = new FrameDecoder(LIMITS.maxFrameBytes);
  private readonly dataHandlers = new Set<(chunk: Buffer | Uint8Array) => void>();
  private readonly closeHandlers = new Set<() => void>();
  private readonly errorHandlers = new Set<(error: unknown) => void>();
  private readonly drainHandlers = new Set<() => void>();
  backpressured = false;
  private closed = false;

  write(buffer: Buffer): boolean {
    if (this.closed) throw new Error("fake peer is closed");
    for (const frame of this.decoder.push(buffer)) {
      if (frame.kind === "blobChunk") {
        this.onBlobChunk?.(frame);
        continue;
      }
      const envelope = JSON.parse(frame.payload.toString("utf8")) as Envelope;
      this.received.push(envelope);
      this.onEnvelope?.(envelope);
    }
    return !this.backpressured;
  }

  send(envelope: Envelope, chunkSize = Number.POSITIVE_INFINITY): void {
    const frame = envelopeFrame(envelope);
    for (let offset = 0; offset < frame.byteLength; offset += chunkSize) {
      const chunk = frame.subarray(offset, Math.min(frame.byteLength, offset + chunkSize));
      for (const handler of [...this.dataHandlers]) handler(chunk);
    }
  }

  sendRaw(chunk: Buffer): void {
    for (const handler of [...this.dataHandlers]) handler(chunk);
  }

  acknowledge(): void {
    this.send(helloAck());
  }

  closeFromPeer(): void {
    if (this.closed) return;
    this.closed = true;
    for (const handler of [...this.closeHandlers]) handler();
  }

  failFromPeer(error: unknown): void {
    for (const handler of [...this.errorHandlers]) handler(error);
  }

  onData(handler: (chunk: Buffer | Uint8Array) => void): void {
    this.dataHandlers.add(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.add(handler);
  }

  onError(handler: (error: unknown) => void): void {
    this.errorHandlers.add(handler);
  }

  onDrain(handler: () => void): void {
    this.drainHandlers.add(handler);
  }

  drain(): void {
    this.backpressured = false;
    for (const handler of [...this.drainHandlers]) handler();
  }

  offData(handler: (chunk: Buffer | Uint8Array) => void): void {
    this.dataHandlers.delete(handler);
  }

  offClose(handler: () => void): void {
    this.closeHandlers.delete(handler);
  }

  offError(handler: (error: unknown) => void): void {
    this.errorHandlers.delete(handler);
  }

  offDrain(handler: () => void): void {
    this.drainHandlers.delete(handler);
  }

  close(): void {
    this.closed = true;
  }
}

function client(
  peer: FakePeerConnection,
  options: Partial<EngineClientConnectOptions> = {},
): EngineClient {
  return new EngineClient(peer, {
    authToken: "parent-secret",
    protocolVersion: 2,
    capabilities: ["core", "ydoc", "blobs"],
    connectTimeoutMs: 5_000,
    maxFrameBytes: LIMITS.maxFrameBytes,
    ...options,
  });
}

function request(id: number, method: string): Request {
  return { id, method, params: { method } };
}

function realStreamClient(connectTimeoutMs = 5_000): {
  transport: EngineClient;
  readable: PassThrough;
} {
  const readable = new PassThrough();
  const writable = new PassThrough();
  writable.resume();
  const duplex = Duplex.from({ readable, writable });
  return {
    transport: new EngineClient(new DuplexEngineClientConnection(duplex), {
      authToken: "parent-secret",
      protocolVersion: 2,
      capabilities: ["core"],
      connectTimeoutMs,
      maxFrameBytes: LIMITS.maxFrameBytes,
    }),
    readable,
  };
}

function nextImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("outbound backpressure", () => {
  it("subtracts queue time from the wire deadline and refuses an overdue unsent request before its timer runs", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(100);
    const peer = new FakePeerConnection(),
      transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    peer.backpressured = true;
    const first = transport.sendRequest(request(1, "first")).catch((error) => error);
    const second = transport
      .sendRequest({ ...request(2, "second"), deadlineMs: 1000 })
      .catch((error) => error);
    const expired = transport
      .sendRequest({ ...request(3, "expired"), deadlineMs: 100 })
      .catch((error) => error);
    try {
      clock.mockReturnValue(400);
      peer.drain();
      await nextImmediate();
      expect(await expired).toBeInstanceOf(EngineRequestDeadlineError);
      expect(
        peer.received.find(
          (envelope) => envelope.type === "request" && envelope.method === "second",
        ),
      ).toMatchObject({ deadlineMs: 700 });
      expect(
        peer.received.some(
          (envelope) => envelope.type === "request" && envelope.method === "expired",
        ),
      ).toBe(false);
    } finally {
      transport.close();
      await Promise.all([first, second]);
      clock.mockRestore();
    }
  });

  it("bounds outstanding ordinary requests even when their frames are small", async () => {
    const peer = new FakePeerConnection(),
      transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    peer.backpressured = true;
    const requests: Promise<unknown>[] = [];
    let overflow: Promise<unknown> | undefined;
    try {
      for (let id = 1; id <= 1024; id++)
        requests.push(transport.sendRequest(request(id, "small")).catch((error) => error));
      let refusal: unknown;
      overflow = transport.sendRequest(request(1025, "overflow")).catch((error) => {
        refusal = error;
      });
      await nextImmediate();
      expect(refusal).toMatchObject({ wireError: { code: "OVERLOADED", retry: "afterBackoff" } });
      expect(peer.received.filter((envelope) => envelope.type === "request")).toHaveLength(1);
    } finally {
      transport.close();
      await overflow;
      await Promise.all(requests);
    }
  });

  it("holds later frames until drain and releases the writer on close", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const firstWritten = Promise.withResolvers<void>();
    const secondWritten = Promise.withResolvers<void>();
    peer.onEnvelope = (envelope) => {
      if (envelope.type !== "request") return;
      if (envelope.method === "first") {
        peer.backpressured = true;
        firstWritten.resolve();
      } else {
        secondWritten.resolve();
      }
    };
    const first = transport.sendRequest(request(1, "first")).catch((error: unknown) => error);
    await firstWritten.promise;
    const secondRequest = request(2, "second");
    const second = transport.sendRequest(secondRequest).catch((error: unknown) => error);
    await nextImmediate();
    secondRequest.params = { method: "caller-mutated" };
    await nextImmediate();
    expect(peer.received.filter((envelope) => envelope.type === "request")).toHaveLength(1);
    peer.drain();
    await secondWritten.promise;
    expect(
      peer.received.find((envelope) => envelope.type === "request" && envelope.method === "second"),
    ).toMatchObject({ params: { method: "second" } });
    peer.closeFromPeer();
    expect(await first).toBeInstanceOf(EngineClientError);
    expect(await second).toBeInstanceOf(EngineClientError);
  });
});

describe.each(["application", "bootstrap"] as const)("private %s upload lifetime", (kind) => {
  const streamCount = kind === "application" ? 2 : 1;
  const upload = (
    transport: EngineClient,
    ...args: Parameters<EngineClient["sendLiveApplication"]>
  ) =>
    kind === "application"
      ? transport.sendLiveApplication(...args)
      : transport.sendLiveBootstrap(
          args[0],
          {
            bootstrapId: "bootstrap",
            bootstrapMomentId: "moment",
            baselineMomentRelaySequence: 1,
            baselineRegisteredAtMs: 0,
            baselineDigest: args[1].metadata.accepted.receipt.updateDigest,
            projectedMarkdownDigest: "a".repeat(64),
            projectedMarkdownByteLength: 0,
            baselineBytes: args[1].updateBytes,
          },
          args[2],
        );

  it("preserves the connection when a terminal refusal arrives before final input drains", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer, {
      privateLiveApplication: { aggregateBytes: 128 * 1024 * 1024, maxUploads: 1 },
    });
    peer.acknowledge();
    await transport.ready();
    const bytes = new Uint8Array([0, 0]);
    const accepted = parseRelayAcceptedLiveUpdate({
      receipt: {
        deliveryId: "delivery",
        updateDigest: createHash("sha256").update(bytes).digest("hex"),
        journalCursor: 1,
        acceptingHostEpoch: 1,
      },
      binding: {
        workspaceId: "workspace",
        mainVersionId: "main",
        objectId: "one",
        lineageClaimId: "a".repeat(64),
        currentPath: "one.md",
        selectorPaths: ["one.md"],
        restoreFenceGeneration: 0,
      },
      authority: {
        principalKind: "owner",
        principalId: "owner",
        grantId: null,
        grantGeneration: null,
      },
      receivedAtMs: 0,
    });
    const reached = Promise.withResolvers<void>();
    let chunks = 0;
    peer.onBlobChunk = () => {
      if (++chunks !== streamCount) return;
      peer.backpressured = true;
      peer.send({
        type: "error",
        id: 1,
        error: { code: "OVERLOADED", message: "live-application-capacity", retry: "afterBackoff" },
      });
      reached.resolve();
    };
    try {
      const pending = upload(
        transport,
        { id: 1, workspace: "ws-0000000000000001", registrationId: 1, deadlineMs: 30_000 },
        { metadata: { accepted, firstSeen: [] }, updateBytes: bytes },
      ).catch((error) => error);
      await reached.promise;
      peer.drain();
      expect(await pending).toBeInstanceOf(EngineRequestError);
      peer.onEnvelope = (envelope) => {
        if (envelope.type === "request")
          peer.send({ type: "response", id: envelope.id, result: {} });
      };
      await expect(transport.sendRequest(request(99, "after.refusal"))).resolves.toMatchObject({
        result: {},
      });
    } finally {
      transport.close();
    }
  });

  it.each(["busy", "abort"])(
    "keeps the connection after a fully drained upload reaches %s",
    async (mode) => {
      const peer = new FakePeerConnection();
      const transport = client(peer, {
        privateLiveApplication: {
          aggregateBytes: 128 * 1024 * 1024,
          maxUploads: 1,
        },
      });
      peer.acknowledge();
      await transport.ready();
      const bytes = new Uint8Array([0, 0]);
      const accepted = parseRelayAcceptedLiveUpdate({
        receipt: {
          deliveryId: "delivery",
          updateDigest: createHash("sha256").update(bytes).digest("hex"),
          journalCursor: 1,
          acceptingHostEpoch: 1,
        },
        binding: {
          workspaceId: "workspace",
          mainVersionId: "main",
          objectId: "one",
          lineageClaimId: "a".repeat(64),
          currentPath: "one.md",
          selectorPaths: ["one.md"],
          restoreFenceGeneration: 0,
        },
        authority: {
          principalKind: "owner",
          principalId: "owner",
          grantId: null,
          grantGeneration: null,
        },
        receivedAtMs: 0,
      });
      const uploaded = Promise.withResolvers<void>();
      let chunks = 0;
      peer.onBlobChunk = () => {
        if (++chunks === streamCount) setImmediate(uploaded.resolve);
      };
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const signal = new AbortController();
        const pending = upload(
          transport,
          {
            id: 77,
            workspace: "ws-0000000000000001",
            registrationId: 1,
            deadlineMs: 30_000,
          },
          { metadata: { accepted, firstSeen: [] }, updateBytes: bytes },
          signal.signal,
        ).catch((error: unknown) => error);
        await uploaded.promise;
        if (mode === "busy")
          peer.send({
            type: "error",
            id: 1,
            error: {
              code: "OVERLOADED",
              message: "store-busy",
              retry: "afterBackoff",
            },
          });
        else if (mode === "deadline") await vi.advanceTimersByTimeAsync(30_000);
        else {
          peer.onEnvelope = (envelope) => {
            if (mode === "abort" && envelope.type === "cancel")
              peer.send({
                type: "error",
                id: envelope.id,
                error: {
                  code: "CANCELLED",
                  message: "cancelled",
                  retry: "no",
                },
              });
          };
          signal.abort();
        }
        expect(await pending).toBeInstanceOf(EngineClientError);
        peer.onEnvelope = (envelope) => {
          if (envelope.type === "request")
            peer.send({ type: "response", id: envelope.id, result: {} });
        };
        await expect(transport.sendRequest(request(2, "after.upload"))).resolves.toMatchObject({
          result: {},
        });
        if (mode.startsWith("abort")) {
          expect(peer.received).toContainEqual({ type: "cancel", id: 1 });
          expect(vi.getTimerCount()).toBe(0);
        }
      } finally {
        transport.close();
        vi.useRealTimers();
      }
    },
  );
  it.each(["abort", "abort-no-drain"])(
    "bounds concurrent uploads and preserves framing after %s",
    async (mode) => {
      const peer = new FakePeerConnection();
      const transport = client(peer, {
        privateLiveApplication: {
          aggregateBytes: 128 * 1024 * 1024,
          maxUploads: 1,
        },
      });
      peer.acknowledge();
      await transport.ready();
      vi.useFakeTimers();
      try {
        const bytes = new Uint8Array([0, 0]);
        const accepted = parseRelayAcceptedLiveUpdate({
          receipt: {
            deliveryId: "delivery",
            updateDigest: createHash("sha256").update(bytes).digest("hex"),
            journalCursor: 1,
            acceptingHostEpoch: 1,
          },
          binding: {
            workspaceId: "workspace",
            mainVersionId: "main",
            objectId: "one",
            lineageClaimId: "a".repeat(64),
            currentPath: "one.md",
            selectorPaths: ["one.md"],
            restoreFenceGeneration: 0,
          },
          authority: {
            principalKind: "owner",
            principalId: "owner",
            grantId: null,
            grantGeneration: null,
          },
          receivedAtMs: 0,
        });
        const reached = Promise.withResolvers<void>();
        let chunks = 0;
        peer.onEnvelope = (envelope) => {
          if (
            mode !== "final-response-no-drain" &&
            mode !== "abort-final-response" &&
            envelope.type === "blobStart"
          ) {
            peer.backpressured = true;
            reached.resolve();
          }
        };
        peer.onBlobChunk = () => {
          chunks++;
          if (
            (mode === "final-response-no-drain" || mode === "abort-final-response") &&
            chunks === streamCount
          ) {
            peer.backpressured = true;
            reached.resolve();
            peer.send({
              type: "response",
              id: 1,
              result: { status: "applied" },
            });
          }
        };
        const signal = new AbortController();
        const event = {
          metadata: { accepted, firstSeen: [] },
          updateBytes: bytes,
        };
        const pending = upload(
          transport,
          {
            id: 1,
            workspace: "ws-0000000000000001",
            registrationId: 1,
            deadlineMs: 30_000,
          },
          event,
          signal.signal,
        ).catch((error: unknown) => error);
        await reached.promise;
        await expect(
          upload(
            transport,
            {
              id: 2,
              workspace: "ws-0000000000000001",
              registrationId: 1,
              deadlineMs: 30_000,
            },
            event,
          ),
        ).rejects.toThrow("capacity is full");
        if (mode.startsWith("abort")) {
          signal.abort();
          if (mode !== "abort-no-drain") {
            peer.onEnvelope = null;
            peer.drain();
          } else await vi.advanceTimersByTimeAsync(30_000);
        } else {
          if (mode !== "final-response-no-drain")
            peer.send({
              type: "response",
              id: 1,
              result: { status: "applied" },
            });
          if (mode === "early-response") peer.drain();
          else await vi.advanceTimersByTimeAsync(30_000);
        }
        expect(await pending).toBeInstanceOf(EngineClientError);
        peer.drain();
        expect(chunks).toBe(
          mode === "final-response-no-drain" || mode === "abort" || mode === "abort-final-response"
            ? streamCount
            : 0,
        );
        if (mode === "abort" || mode === "abort-final-response") {
          expect(peer.received).toContainEqual({ type: "cancel", id: 1 });
          peer.onEnvelope = (envelope) => {
            if (envelope.type === "request")
              peer.send({ type: "response", id: envelope.id, result: {} });
          };
          await expect(transport.sendRequest(request(99, "after.cancel"))).resolves.toMatchObject({
            result: {},
          });
          expect(vi.getTimerCount()).toBe(0);
          return;
        }
        await expect(transport.sendRequest(request(99, "after.partial"))).rejects.toThrow(
          "is closed",
        );
        await expect(
          upload(
            transport,
            {
              id: 3,
              workspace: "ws-0000000000000001",
              registrationId: 1,
              deadlineMs: 30_000,
            },
            event,
          ),
        ).rejects.toThrow("is closed");
      } finally {
        transport.close();
        vi.useRealTimers();
      }
    },
  );
});

describe("private admitted-update upload", () => {
  it("captures a valid maximum-size Yjs update through the real client", async () => {
    const maximum = 20 * 1024 * 1024;
    const rangeCount = 16_385;
    const single = (clientId: number, length: number): Uint8Array => {
      const doc = new Y.Doc();
      doc.clientID = clientId;
      doc.getText("plainText").insert(0, "x".repeat(length));
      const update = Y.encodeStateAsUpdate(doc);
      doc.destroy();
      return update;
    };
    const small = Array.from({ length: rangeCount - 1 }, (_, index) => single(index + 1, 1));
    // Each merge of all 16,384 small updates took 3.6 s on a fast desktop, and the test took 37 s
    // alone on a hosted runner. Merging them in groups first gives the same bytes in under 0.3 s.
    const groups: Uint8Array[] = [];
    for (let index = 0; index < small.length; index += 256)
      groups.push(Y.mergeUpdates(small.slice(index, index + 256)));
    const ranges = Y.mergeUpdates(groups);
    const encode = (length: number): Uint8Array =>
      Y.mergeUpdates([ranges, single(rangeCount, length)]);
    const measured = encode(maximum - 100);
    const finalLength = maximum - (measured.length - (maximum - 100));
    const bytes = encode(finalLength);
    expect(bytes).toHaveLength(maximum);
    const binding = {
      workspaceId: "workspace",
      mainVersionId: "main",
      objectId: "one",
      lineageClaimId: createHash("sha256")
        .update(new Uint8Array([0, 0]))
        .digest("hex"),
      currentPath: "one.md",
      selectorPaths: ["one.md"],
      restoreFenceGeneration: 0,
    };
    const accepted = parseRelayAcceptedLiveUpdate({
      receipt: {
        deliveryId: "delivery",
        updateDigest: createHash("sha256").update(bytes).digest("hex"),
        journalCursor: 1,
        acceptingHostEpoch: 1,
      },
      binding,
      authority: {
        principalKind: "owner",
        principalId: "owner",
        grantId: null,
        grantGeneration: null,
      },
      receivedAtMs: 0,
    });
    // An explicit path retains the exact client transcript for the Rust host test.
    const fixturePath = process.env.DOHC_LIVE_APPLICATION_CLIENT_FIXTURE;
    if (fixturePath) writeFileSync(fixturePath, new Uint8Array());
    class RecordingPeer extends FakePeerConnection {
      override write(buffer: Buffer): boolean {
        if (fixturePath) appendFileSync(fixturePath, buffer);
        return super.write(buffer);
      }
    }
    const peer = new RecordingPeer();
    const transport = client(peer, {
      privateLiveApplication: {
        aggregateBytes: 128 * 1024 * 1024,
        maxUploads: 1,
      },
    });
    peer.acknowledge();
    await transport.ready();
    let completed = 0;
    peer.onBlobChunk = (frame) => {
      if (frame.fin && ++completed === 2)
        peer.send({ type: "response", id: 1, result: { status: "applied" } });
    };
    const firstSeen = Array.from({ length: rangeCount }, (_, index) => ({
      clientId: index + 1,
      startClock: 0,
      endClock: index + 1 === rangeCount ? finalLength : 1,
    }));
    await transport.sendLiveApplication(
      {
        id: 1,
        workspace: "ws-0000000000000001",
        registrationId: 1,
        deadlineMs: 30_000,
      },
      { metadata: { accepted, firstSeen }, updateBytes: bytes },
    );
    expect(completed).toBe(2);
    transport.close();
  }, 30_000);
});

describe("request progress", () => {
  async function session(clientCapabilities: string[], ackCapabilities: string[]) {
    const peer = new FakePeerConnection();
    const transport = client(peer, { capabilities: clientCapabilities });
    peer.send(helloAck(LIMITS, ackCapabilities));
    await transport.ready();
    const requests: Extract<Envelope, { type: "request" }>[] = [];
    peer.onEnvelope = (envelope) => {
      if (envelope.type === "request") requests.push(envelope);
    };
    return { peer, transport, requests };
  }

  it("deducts serialization time from the wire deadline and response timer", async () => {
    const { peer, transport, requests } = await session(["core", "progress"], ["core", "progress"]);
    const clock = vi.spyOn(performance, "now").mockReturnValue(100);
    const stringify = JSON.stringify;
    const serializer = vi.spyOn(JSON, "stringify").mockImplementation((value, ...args) => {
      const result = stringify(value, ...args);
      if (value?.method === "serialization.partial") clock.mockReturnValue(400);
      return result;
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onProgress = vi.fn();
    try {
      const pending = transport
        .sendRequest(
          { ...request(1, "serialization.partial"), deadlineMs: 1000 },
          undefined,
          onProgress,
        )
        .catch((error) => error);
      const settled = vi.fn();
      void pending.then(settled);
      await nextImmediate();
      expect(requests[0]).toMatchObject({ deadlineMs: 700, progress: true });
      peer.send({ type: "progress", id: requests[0]!.id });
      expect(onProgress).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(699);
      await nextImmediate();
      expect(settled).not.toHaveBeenCalled();
      clock.mockReturnValue(1100);
      await vi.advanceTimersByTimeAsync(1);
      await nextImmediate();
      expect(settled).toHaveBeenCalledWith(expect.any(EngineRequestDeadlineError));
      expect(vi.getTimerCount()).toBe(0);
      peer.send({ type: "progress", id: requests[0]!.id });
      expect(onProgress).toHaveBeenCalledTimes(1);
    } finally {
      transport.close();
      serializer.mockRestore();
      clock.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each([
    { clientAsks: true, engineAgrees: true, callerAsks: true, flagged: true },
    { clientAsks: true, engineAgrees: false, callerAsks: true, flagged: false },
  ])("flags a request only when the caller asks on a negotiated session: %o", async (row) => {
    const { peer, transport, requests } = await session(
      row.clientAsks ? ["core", "progress"] : ["core"],
      row.engineAgrees ? ["core", "progress"] : ["core"],
    );
    try {
      const sent = transport.sendRequest(
        request(1, "workspace.open"),
        undefined,
        row.callerAsks ? () => undefined : undefined,
      );
      await nextImmediate();
      expect(transport.reportsProgress()).toBe(row.clientAsks && row.engineAgrees);
      const [wire] = requests;
      // Absent, not false: a request that does not ask is unchanged on the wire.
      expect("progress" in wire!).toBe(row.flagged);
      if (row.flagged) expect(wire!.progress).toBe(true);
      peer.send({ type: "response", id: wire!.id, result: null });
      await expect(sent).resolves.toMatchObject({ id: 1 });
    } finally {
      transport.close();
    }
  });
});

describe("private application range ordering", () => {
  it.each([
    [
      "separated ranges from one client",
      [
        { clientId: 7, startClock: 0, endClock: 3 },
        { clientId: 7, startClock: 5, endClock: 10 },
      ],
      true,
    ],
    [
      "overlapping ranges",
      [
        { clientId: 7, startClock: 0, endClock: 6 },
        { clientId: 7, startClock: 5, endClock: 10 },
      ],
      false,
    ],
  ] as const)(
    "handles %s according to the admitted range contract",
    async (_name, firstSeen, allowed) => {
      const doc = new Y.Doc();
      doc.clientID = 7;
      doc.getText("body").insert(0, "abcdefghij");
      const bytes = Y.encodeStateAsUpdate(doc);
      doc.destroy();
      const accepted = parseRelayAcceptedLiveUpdate({
        receipt: {
          deliveryId: "ranges",
          updateDigest: createHash("sha256").update(bytes).digest("hex"),
          journalCursor: 1,
          acceptingHostEpoch: 1,
        },
        binding: {
          workspaceId: "workspace",
          mainVersionId: "main",
          objectId: "one",
          lineageClaimId: "a".repeat(64),
          currentPath: "one.md",
          selectorPaths: ["one.md"],
          restoreFenceGeneration: 0,
        },
        authority: {
          principalKind: "owner",
          principalId: "owner",
          grantId: null,
          grantGeneration: null,
        },
        receivedAtMs: 0,
      });
      const peer = new FakePeerConnection();
      const transport = client(peer, {
        privateLiveApplication: { aggregateBytes: 128 * 1024 * 1024, maxUploads: 1 },
      });
      peer.acknowledge();
      await transport.ready();
      const packed: Buffer[] = [];
      let finished = 0;
      let uploadId = 0;
      peer.onEnvelope = (envelope) => {
        if (envelope.type === "blobStart") uploadId = envelope.requestId;
      };
      peer.onBlobChunk = (frame) => {
        if (frame.streamId === 2) packed.push(Buffer.from(frame.payload));
        if (frame.fin && ++finished === 2)
          peer.send({ type: "response", id: uploadId, result: { status: "applied" } });
      };
      try {
        const upload = transport.sendLiveApplication(
          { id: 73, workspace: "ws-0000000000000001", registrationId: 1, deadlineMs: 30_000 },
          { metadata: { accepted, firstSeen }, updateBytes: bytes },
        );
        if (allowed) {
          await expect(upload).resolves.toMatchObject({ result: { status: "applied" } });
          const wire = Buffer.concat(packed);
          expect(
            Array.from({ length: wire.length / 16 }, (_, index) => ({
              clientId: Number(wire.readBigUInt64LE(index * 16)),
              startClock: wire.readUInt32LE(index * 16 + 8),
              endClock: wire.readUInt32LE(index * 16 + 12),
            })),
          ).toEqual(firstSeen);
        } else {
          await expect(upload).rejects.toThrow("Invalid live application range.");
          expect(finished).toBe(0);
        }
      } finally {
        transport.close();
      }
    },
  );
});

describe("private application v2 metadata transport", () => {
  function event(withCoverage = true) {
    const updateBytes = Buffer.alloc(16, 7);
    const human = { kind: "human" as const, humanId: "owner", humanName: "Sam 🐈" };
    const firstSeen = [
      { clientId: 7, startClock: 0, endClock: 3 },
      { clientId: 7, startClock: 5, endClock: 7 },
    ];
    const firstSeenDeletes = [{ clientId: 7, startClock: 1, endClock: 2 }];
    return {
      updateBytes,
      metadata: {
        accepted: {
          receipt: {
            deliveryId: "v2-delivery",
            updateDigest: createHash("sha256").update(updateBytes).digest("hex"),
            journalCursor: 1,
            acceptingHostEpoch: parseHostEpoch(1),
          },
          binding: {
            workspaceId: "workspace",
            mainVersionId: "main",
            objectId: "one",
            lineageClaimId: "a".repeat(64),
            currentPath: "one.md",
            selectorPaths: ["one.md"],
            restoreFenceGeneration: 0,
          },
          authority: {
            principalKind: "owner" as const,
            principalId: "owner",
            grantId: null,
            grantGeneration: null,
          },
          receivedAtMs: 0,
        },
        firstSeen,
        canonicalVersion: 2 as const,
        authorSnapshot: [human],
        firstSeenDeletes,
        ...(withCoverage
          ? {
              checkpointCoverage: [
                {
                  author: { ...human },
                  structRanges: firstSeen.map((range) => ({ ...range })),
                  deletionRanges: firstSeenDeletes.map((range) => ({ ...range })),
                },
              ],
            }
          : {}),
      },
    };
  }
  async function recorder(hold = false, frameBytes = LIMITS.maxFrameBytes) {
    const peer = new FakePeerConnection();
    const transport = client(peer, {
      privateLiveApplication: { aggregateBytes: 128 * 1024 * 1024, maxUploads: 1 },
    });
    peer.send(helloAck({ ...LIMITS, maxFrameBytes: frameBytes }));
    await transport.ready();
    const entered = Promise.withResolvers<void>();
    const headers: Request[] = [];
    const starts = new Map<number, Extract<Envelope, { type: "blobStart" }>>();
    const chunks = new Map<number, Buffer[]>();
    peer.onEnvelope = (envelope) => {
      if (envelope.type === "request") {
        headers.push(envelope);
        if (hold) peer.backpressured = true;
        entered.resolve();
      } else if (envelope.type === "blobStart") {
        starts.set(envelope.streamId, envelope);
        chunks.set(envelope.streamId, []);
      }
    };
    peer.onBlobChunk = (frame) => {
      expect(frame.payload.length).toBeLessThanOrEqual(LIMITS.maxBlobChunkBytes);
      chunks.get(frame.streamId)!.push(Buffer.from(frame.payload));
      if (frame.fin && frame.streamId === 2)
        peer.send({
          type: "response",
          id: starts.get(2)!.requestId,
          result: { status: "applied" },
        });
    };
    return { peer, transport, entered, headers, starts, chunks };
  }
  const uploadRequest = {
    id: 74,
    workspace: "ws-0000000000000001",
    registrationId: 1,
    deadlineMs: 30_000,
  };

  it("streams checkpoint coverage larger than a control frame without embedding it in JSON envelopes", async () => {
    const frameBytes = 64 * 1024;
    const input = event(),
      f = await recorder(false, frameBytes);
    input.metadata.checkpointCoverage![0]!.structRanges = Array.from(
      { length: 1_700 },
      (_, index) => ({ clientId: index + 1, startClock: 0, endClock: 1 }),
    );
    const { accepted: _accepted, firstSeen: _firstSeen, ...extensions } = input.metadata;
    const expectedTail = Buffer.from(JSON.stringify(extensions));
    expect(expectedTail.length).toBeGreaterThan(frameBytes);
    try {
      await f.transport.sendLiveApplication(uploadRequest, input);
      expect(Buffer.concat(f.chunks.get(2)!).subarray(32)).toEqual(expectedTail);
      for (const envelope of f.peer.received) {
        expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThan(4096);
        expect(envelope).not.toHaveProperty("checkpointCoverage");
        if (envelope.type === "request") {
          expect(envelope.params).not.toHaveProperty("authorSnapshot");
          expect(envelope.params).not.toHaveProperty("firstSeenDeletes");
          expect(envelope.params).not.toHaveProperty("checkpointCoverage");
          expect(envelope.params).toHaveProperty("metadataByteLength", expectedTail.length);
        }
      }
    } finally {
      f.transport.close();
    }
  });

  it("captures update bytes, authors, deletions, and checkpoint coverage before backpressure", async () => {
    const input = event(),
      f = await recorder(true);
    const expected = JSON.parse(JSON.stringify(input.metadata)) as typeof input.metadata;
    const expectedUpdate = Buffer.from(input.updateBytes);
    const { accepted: _accepted, firstSeen: _firstSeen, ...extensions } = expected;
    const expectedTail = Buffer.from(JSON.stringify(extensions));
    const pending = f.transport.sendLiveApplication(uploadRequest, input);
    try {
      await f.entered.promise;
      input.updateBytes.fill(9);
      input.metadata.accepted.receipt.deliveryId = "changed";
      input.metadata.accepted.binding.selectorPaths[0] = "changed.md";
      input.metadata.firstSeen[0]!.endClock = 1;
      input.metadata.authorSnapshot[0]!.humanName = "Changed";
      input.metadata.firstSeenDeletes[0]!.endClock = 3;
      input.metadata.checkpointCoverage![0]!.author.humanName = "Changed checkpoint";
      input.metadata.checkpointCoverage![0]!.structRanges[0]!.endClock = 1;
      input.metadata.checkpointCoverage![0]!.deletionRanges.length = 0;
      f.peer.drain();
      await expect(pending).resolves.toMatchObject({ result: { status: "applied" } });
      expect(Buffer.concat(f.chunks.get(1)!)).toEqual(expectedUpdate);
      const wire = Buffer.concat(f.chunks.get(2)!);
      expect(wire.readUInt32LE(12)).toBe(3);
      expect(wire.subarray(32)).toEqual(expectedTail);
      expect(f.headers[0]!.params).toHaveProperty("accepted", expected.accepted);
      expect(f.headers[0]!.params).toHaveProperty("metadataByteLength", expectedTail.length);
      expect(f.starts.get(2)).toHaveProperty(
        "sha256",
        createHash("sha256").update(wire).digest("hex"),
      );
    } finally {
      f.peer.drain();
      f.transport.close();
      await pending.catch(() => undefined);
    }
  });

  it("fails a private read the writer reaches after its deadline as unsent", async () => {
    const f = await recorder();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    f.peer.backpressured = true;
    const earlier = f.transport.sendRequest({
      id: 1,
      method: "earlier",
      params: {},
      deadlineMs: 60_000,
    });
    const position = { eventCount: 0, journalCursor: 0, evidenceDigest: "ab".repeat(32) };
    const read = f.transport.readNextLiveApplied(
      { ...uploadRequest, deadlineMs: 50 },
      position,
      32,
    );
    try {
      // The deadline timer fires, and the earlier write drains before its deferred expiry runs.
      vi.advanceTimersByTime(50);
      f.peer.drain();
      await expect(read).rejects.toMatchObject({
        name: "EngineRequestDeadlineError",
        unsent: true,
      });
      expect(f.headers.map((header) => header.method)).toEqual(["earlier"]);
    } finally {
      vi.useRealTimers();
      f.transport.close();
      await earlier.catch(() => undefined);
    }
  });
});

describe("private baseline upload", () => {
  function baseline(bytes: Uint8Array = new Uint8Array([0, 0])) {
    return {
      bootstrapId: "bootstrap",
      bootstrapMomentId: "moment",
      baselineMomentRelaySequence: 3,
      baselineRegisteredAtMs: 0,
      baselineDigest: createHash("sha256").update(bytes).digest("hex"),
      projectedMarkdownDigest: createHash("sha256").update("").digest("hex"),
      projectedMarkdownByteLength: 0,
      baselineBytes: bytes,
    };
  }
  const uploadRequest = {
    id: 42,
    workspace: "ws-0000000000000001",
    registrationId: 9,
    deadlineMs: 30_000,
  };

  it("captures a genuine multi-chunk baseline and immutable metadata before backpressure", async () => {
    const maximum = LIMITS.maxBlobChunkBytes + 1;
    const encode = (length: number) => {
      const doc = new Y.Doc({ gc: false });
      doc.clientID = 1;
      doc.getMap("meta").set("schemaVersion", 1);
      const paragraph = new Y.XmlElement("paragraph"),
        text = new Y.XmlText();
      paragraph.insert(0, [text]);
      doc.getXmlFragment("body").insert(0, [paragraph]);
      text.insert(0, "x".repeat(length));
      text.delete(0, text.length);
      const update = Y.encodeStateAsUpdate(doc);
      doc.destroy();
      return update;
    };
    const measured = encode(maximum - 100),
      bytes = encode(maximum - 100 + maximum - measured.byteLength);
    expect(bytes.byteLength).toBe(maximum);
    const input = baseline(bytes),
      expected = { ...input };
    const peer = new FakePeerConnection(),
      transport = client(peer, {
        privateLiveApplication: {
          aggregateBytes: 128 * 1024 * 1024,
          maxUploads: 1,
        },
      });
    peer.acknowledge();
    await transport.ready();
    const entered = Promise.withResolvers<void>();
    let requestId = 0,
      streamId = 0,
      length = 0;
    const hash = createHash("sha256");
    peer.onEnvelope = (envelope) => {
      if (envelope.type === "request") {
        requestId = envelope.id;
        expect(envelope.method).toBe("liveApplication.bootstrap");
        expect(envelope.params).toEqual({
          registrationId: 9,
          baselineStreamId: expect.any(Number),
          baseline: {
            bootstrapId: expected.bootstrapId,
            bootstrapMomentId: expected.bootstrapMomentId,
            baselineMomentRelaySequence: 3,
            baselineRegisteredAtMs: 0,
            baselineDigest: expected.baselineDigest,
            baselineByteLength: maximum,
            projectedMarkdownDigest: expected.projectedMarkdownDigest,
            projectedMarkdownByteLength: 0,
          },
        });
        peer.backpressured = true;
        entered.resolve();
      } else if (envelope.type === "blobStart") {
        expect(envelope).toMatchObject({
          requestId,
          totalBytes: maximum,
          sha256: expected.baselineDigest,
        });
        streamId = envelope.streamId;
      }
    };
    peer.onBlobChunk = (frame) => {
      expect(frame.streamId).toBe(streamId);
      expect(frame.payload.byteLength).toBeLessThanOrEqual(LIMITS.maxBlobChunkBytes);
      hash.update(frame.payload);
      length += frame.payload.byteLength;
      if (frame.fin)
        peer.send({
          type: "response",
          id: requestId,
          result: { status: "bootstrapped", ack: { localYDocSequence: 0 } },
        });
    };
    try {
      const pending = transport.sendLiveBootstrap(uploadRequest, input);
      await entered.promise;
      bytes.fill(0);
      input.bootstrapId = "mutated";
      input.baselineMomentRelaySequence = 99;
      peer.drain();
      await expect(pending).resolves.toMatchObject({
        id: 42,
        result: { status: "bootstrapped", ack: { localYDocSequence: 0 } },
      });
      expect(length).toBe(maximum);
      expect(hash.digest("hex")).toBe(expected.baselineDigest);
      expect(peer.received.filter((envelope) => envelope.type === "blobStart")).toHaveLength(1);
    } finally {
      transport.close();
    }
  }, 30_000);

  it("shares its capacity reservation with admitted-event uploads", async () => {
    const peer = new FakePeerConnection(),
      transport = client(peer, {
        privateLiveApplication: {
          aggregateBytes: 128 * 1024 * 1024,
          maxUploads: 1,
        },
      });
    peer.acknowledge();
    await transport.ready();
    const input = baseline(),
      entered = Promise.withResolvers<void>(),
      abort = new AbortController();
    peer.onEnvelope = (envelope) => {
      if (envelope.type === "blobStart") {
        peer.backpressured = true;
        entered.resolve();
      }
    };
    const pending = transport
      .sendLiveBootstrap(uploadRequest, input, abort.signal)
      .catch((error) => error);
    try {
      await entered.promise;
      const accepted = parseRelayAcceptedLiveUpdate({
        receipt: {
          deliveryId: "delivery",
          updateDigest: input.baselineDigest,
          journalCursor: 1,
          acceptingHostEpoch: 1,
        },
        binding: {
          workspaceId: "workspace",
          mainVersionId: "main",
          objectId: "one",
          lineageClaimId: input.baselineDigest,
          currentPath: "one.md",
          selectorPaths: ["one.md"],
          restoreFenceGeneration: 0,
        },
        authority: {
          principalKind: "owner",
          principalId: "owner",
          grantId: null,
          grantGeneration: null,
        },
        receivedAtMs: 0,
      });
      await expect(
        transport.sendLiveApplication(uploadRequest, {
          metadata: { accepted, firstSeen: [] },
          updateBytes: input.baselineBytes,
        }),
      ).rejects.toThrow("capacity is full");
      abort.abort();
      peer.drain();
      expect(await pending).toBeInstanceOf(EngineClientError);
    } finally {
      abort.abort();
      transport.close();
      await pending;
    }
  });
});

describe("R03 frame codec", () => {
  it("round-trips control payloads from zero bytes through the configured boundary", () => {
    const max = 1024;
    for (const payload of [
      Buffer.alloc(0),
      Buffer.from("hello", "utf8"),
      Buffer.alloc(max, 0xa5),
    ]) {
      const decoder = new FrameDecoder(max);
      expect(decoder.push(encodeFrame(1, 0, payload, max))).toEqual([{ kind: "control", payload }]);
      decoder.finish();
    }

    expect(() => encodeFrame(1, 0, Buffer.alloc(max + 1), max)).toThrowError(
      expect.objectContaining<Partial<EngineFrameError>>({ code: "frame-too-large" }),
    );
    const oversized = encodeFrame(1, 0, Buffer.alloc(max + 1), max + 1);
    expect(() => new FrameDecoder(max).push(oversized)).toThrowError(
      expect.objectContaining<Partial<EngineFrameError>>({ code: "frame-too-large" }),
    );
  });

  it("reports malformed/truncated input with typed errors and stays poisoned", () => {
    const decoder = new FrameDecoder(128);
    const bad = encodeFrame(1, 0, Buffer.from("bad"), 128);
    bad[0] = 0;
    expect(() => decoder.push(bad)).toThrowError(
      expect.objectContaining<Partial<EngineFrameError>>({ code: "bad-magic" }),
    );
    expect(() => decoder.push(encodeFrame(1, 0, Buffer.from("good"), 128))).toThrowError(
      expect.objectContaining<Partial<EngineFrameError>>({ code: "bad-magic" }),
    );

    const truncated = new FrameDecoder(128);
    truncated.push(Buffer.from("DOP1"));
    expect(() => truncated.finish()).toThrowError(
      expect.objectContaining<Partial<EngineFrameError>>({ code: "truncated-frame" }),
    );
    expect(() => truncated.push(encodeFrame(1, 0, Buffer.alloc(0), 128))).toThrowError(
      expect.objectContaining<Partial<EngineFrameError>>({ code: "truncated-frame" }),
    );
  });

  it("round-trips ordered multi-chunk BlobChunk frames and preserves FIN", () => {
    const decoder = new FrameDecoder(128, 8);
    const streamId = 0x0001_0203_0405_0607;
    const first = Buffer.from("blob-");
    const second = Buffer.from("bytes");
    const firstFrame = blobChunkFrame(streamId, first, false, 8);
    const finalFrame = blobChunkFrame(streamId, second, true, 8);

    expect(firstFrame[4]).toBe(FrameType.BlobChunk);
    expect(firstFrame[5]).toBe(0);
    expect(finalFrame[5]).toBe(1);
    expect(firstFrame.subarray(12, 20)).toEqual(
      Buffer.from([0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01, 0x00]),
    );

    expect(decoder.push(Buffer.concat([firstFrame, finalFrame]))).toEqual([
      { kind: "blobChunk", streamId, fin: false, payload: first },
      { kind: "blobChunk", streamId, fin: true, payload: second },
    ]);
    decoder.finish();
  });

  it("rejects over-limit BlobChunk bytes while encoding and decoding", () => {
    expect(() => blobChunkFrame(9, Buffer.alloc(9), true, 8)).toThrowError(
      expect.objectContaining<Partial<EngineFrameError>>({
        code: "blob-chunk-too-large",
      }),
    );

    const oversized = blobChunkFrame(9, Buffer.alloc(9), true, 9);
    expect(() => new FrameDecoder(128, 8).push(oversized)).toThrowError(
      expect.objectContaining<Partial<EngineFrameError>>({
        code: "blob-chunk-too-large",
      }),
    );
  });
});

describe("EngineClient", () => {
  it("keeps real Duplex.from teardown errors from reaching uncaughtException", async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown): void => {
      uncaught.push(error);
    };
    process.on("uncaughtException", onUncaught);

    try {
      const explicit = realStreamClient();
      explicit.readable.write(envelopeFrame(helloAck()));
      await explicit.transport.ready();
      explicit.transport.dispose();
      await nextImmediate();

      const timeout = realStreamClient(1);
      await expect(timeout.transport.ready()).rejects.toMatchObject({
        code: "connect-timeout",
      });
      await nextImmediate();

      const exited = realStreamClient();
      exited.readable.write(envelopeFrame(helloAck()));
      await exited.transport.ready();
      exited.transport.notifyProcessExit(17, null);
      await nextImmediate();

      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  it("cancels only the rewrite when two pending requests share a caller id", async () => {
    const peer = new FakePeerConnection(),
      transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const envelopes: Envelope[] = [];
    peer.onEnvelope = (envelope) => envelopes.push(envelope);
    const open = transport.sendRequest(request(1, "workspace.open"));
    const cancel = new AbortController();
    const rewrite = transport.sendRequest(
      request(1, "history.rewriteLinks"),
      undefined,
      undefined,
      cancel.signal,
    );
    cancel.abort();
    await nextImmediate();
    expect(envelopes).toMatchObject([
      { type: "request", id: 1, method: "workspace.open" },
      { type: "request", id: 2, method: "history.rewriteLinks" },
      { type: "cancel", id: 2 },
    ]);
    peer.send({
      type: "error",
      id: 2,
      error: { code: "CANCELLED", message: "cancelled", retry: "no" },
    });
    await expect(rewrite).rejects.toMatchObject({ wireError: { code: "CANCELLED" } });
    peer.send({ type: "response", id: 1, result: { workspace: "other-workspace" } });
    await expect(open).resolves.toMatchObject({ id: 1, result: { workspace: "other-workspace" } });
    transport.close();
  });

  it("settles a cancelled request with the result of work that landed first", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const envelopes: Envelope[] = [];
    peer.onEnvelope = (envelope) => envelopes.push(envelope);

    const cancel = new AbortController();
    const operation = transport.sendRequest(
      request(4_243, "sync.commitCursor"),
      undefined,
      undefined,
      cancel.signal,
    );
    cancel.abort();
    await nextImmediate();

    expect(envelopes).toMatchObject([
      { type: "request", id: 1, method: "sync.commitCursor" },
      { type: "cancel", id: 1 },
    ]);
    peer.send({ type: "response", id: 1, result: { committed: true } });
    await expect(operation).resolves.toEqual({
      id: 4_243,
      result: { committed: true },
    });
    transport.close();
  });

  it("times out only the expired request and ignores its late reply", async () => {
    vi.useFakeTimers();
    try {
      const peer = new FakePeerConnection();
      const transport = client(peer);
      peer.acknowledge();
      await transport.ready();
      const requests: Array<Extract<Envelope, { type: "request" }>> = [];
      peer.onEnvelope = (envelope) => {
        if (envelope.type === "request") requests.push(envelope);
      };

      const expired = transport.sendRequest({
        ...request(55, "silent.method"),
        deadlineMs: 25,
      });
      const unrelated = transport.sendRequest(request(56, "unrelated.method"));
      // Its own class, and still `transport-error`: the request left and
      // nothing came back, so every caller that rebinds on a dropped socket
      // must keep rebinding here. The class is what lets the one caller that
      // set the deadline — `ydoc.open` — tell its own limit firing apart
      // from a socket that died, which a message match cannot do safely.
      const rejection = expect(expired).rejects.toMatchObject({
        name: "EngineRequestDeadlineError",
        code: "transport-error",
        method: "silent.method",
        deadlineMs: 25,
        message:
          "engine-request-deadline-exceeded: request 1 (silent.method) carries " +
          "a deadline of 25 ms and the daemon did not answer inside it.",
      });

      await vi.advanceTimersByTimeAsync(25);
      await vi.advanceTimersToNextTimerAsync();
      await rejection;
      await expect(expired).rejects.toBeInstanceOf(EngineRequestDeadlineError);
      peer.send({ type: "response", id: requests[0]!.id, result: "late" });
      peer.send({ type: "response", id: requests[1]!.id, result: "unrelated" });
      await expect(unrelated).resolves.toEqual({
        id: 56,
        result: "unrelated",
      });

      const afterTimeout = transport.sendRequest(request(57, "after.timeout"));
      peer.send({ type: "response", id: requests[2]!.id, result: "alive" });
      await expect(afterTimeout).resolves.toEqual({ id: 57, result: "alive" });
      transport.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs a handler registered inside an engine run inside that run", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const inside: boolean[] = [];
    inEngineRun(() => transport.onEvent(() => inside.push(insideEngineRun())));
    transport.onEvent(() => inside.push(insideEngineRun()));
    peer.send({
      type: "event",
      seq: 1,
      sessionGeneration: 7,
      name: "workspace.changed",
      payload: { paths: ["note.md"] },
    });
    expect(inside).toEqual([true, false]);
    transport.close();
  });

  it("preserves the caller id when the response resolves before the final chunk", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const onBlob = vi.fn();
    transport.onBlob(onBlob);
    let wireId = 0;
    peer.onEnvelope = (envelope) => {
      if (envelope.type === "request") wireId = envelope.id;
    };
    const operation = transport.sendRequest(request(9_002, "blob.after.response"));

    peer.send({
      type: "blobStart",
      requestId: wireId,
      streamId: 28,
      totalBytes: 1,
      sha256: null,
    });
    peer.send({ type: "response", id: wireId, result: "done" });
    await expect(operation).resolves.toEqual({ id: 9_002, result: "done" });
    peer.sendRaw(blobChunkFrame(28, Buffer.from("x"), true));

    expect(onBlob).toHaveBeenCalledWith(expect.objectContaining({ requestId: 9_002 }));
    transport.close();
  });

  it("rejects blob streams the client did not request even if the ack offers them", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer, { capabilities: ["core"] });
    peer.acknowledge();
    await transport.ready();
    const pending = transport.sendRequest(request(15, "await.unrequested"));
    peer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 62,
      totalBytes: 1,
      sha256: null,
    });

    await expect(pending).rejects.toMatchObject({ code: "protocol-error" });
  });

  it("rejects a blobStart that references an unknown request", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const pending = transport.sendRequest(request(16, "await.unknown.request"));
    peer.send({
      type: "blobStart",
      requestId: 99,
      streamId: 63,
      totalBytes: 1,
      sha256: null,
    });

    await expect(pending).rejects.toMatchObject({
      code: "protocol-error",
      cause: { code: "unknown-blob-request" },
    });
  });

  it("accepts matching blob SHA-256 and rejects a digest mismatch", async () => {
    const digest = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    const matchingPeer = new FakePeerConnection();
    const matching = client(matchingPeer);
    matchingPeer.acknowledge();
    await matching.ready();
    const onBlob = vi.fn();
    matching.onBlob(onBlob);
    void matching.sendRequest(request(13, "blob.sha.match")).catch(() => {});
    matchingPeer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 31,
      totalBytes: 5,
      sha256: digest,
    });
    matchingPeer.sendRaw(blobChunkFrame(31, Buffer.from("hello"), true));
    expect(onBlob).toHaveBeenCalledOnce();
    matching.close();

    const mismatchPeer = new FakePeerConnection();
    const mismatch = client(mismatchPeer);
    mismatchPeer.acknowledge();
    await mismatch.ready();
    const pending = mismatch.sendRequest(request(2, "await.bad.blob"));
    mismatchPeer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 32,
      totalBytes: 5,
      sha256: "0".repeat(64),
    });
    mismatchPeer.sendRaw(blobChunkFrame(32, Buffer.from("hello"), true));

    await expect(pending).rejects.toMatchObject({
      code: "protocol-error",
      cause: { code: "blob-digest-mismatch" },
    });
  });

  it("retains and concatenates chunks when blob size is unknown", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const onBlob = vi.fn();
    transport.onBlob(onBlob);
    void transport.sendRequest(request(22, "blob.unknown.length")).catch(() => {});
    peer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 64,
      totalBytes: null,
      sha256: "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    });
    const concatenate = vi.spyOn(Buffer, "concat");

    try {
      peer.sendRaw(blobChunkFrame(64, Buffer.from("hello "), false));
      peer.sendRaw(blobChunkFrame(64, Buffer.from("world"), true));

      expect(onBlob).toHaveBeenCalledWith(
        expect.objectContaining({
          streamId: 64,
          bytes: Buffer.from("hello world"),
        }),
      );
      expect(concatenate.mock.calls.some(([, size]) => size === 11)).toBe(true);
    } finally {
      concatenate.mockRestore();
      transport.close();
    }
  });

  it("enforces a global buffered blob byte budget", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer, { maxBlobBytes: 5 });
    peer.acknowledge();
    await transport.ready();
    const pending = transport.sendRequest(request(5, "await.blob.backpressure"));
    for (const streamId of [34, 35]) {
      peer.send({
        type: "blobStart",
        requestId: 1,
        streamId,
        totalBytes: null,
        sha256: null,
      });
    }
    peer.sendRaw(blobChunkFrame(34, Buffer.from("123"), false));
    peer.sendRaw(blobChunkFrame(35, Buffer.from("456"), false));

    await expect(pending).rejects.toMatchObject({
      code: "protocol-error",
      cause: { code: "blob-backpressure-exceeded" },
    });
  });

  it("reserves announced destinations against the global blob byte budget", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer, { maxBlobBytes: 5 });
    peer.acknowledge();
    await transport.ready();
    const pending = transport.sendRequest(request(25, "await.blob.reservation"));
    peer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 37,
      totalBytes: 3,
      sha256: null,
    });
    peer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 38,
      totalBytes: 3,
      sha256: null,
    });

    await expect(pending).rejects.toMatchObject({
      code: "protocol-error",
      cause: { code: "blob-backpressure-exceeded" },
    });
  });

  it("caps buffered chunk count per stream to bound tiny-chunk floods", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const pending = transport.sendRequest(request(7, "await.blob.chunkflood"));
    peer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 51,
      totalBytes: null,
      sha256: null,
    });
    // One coalesced data event carrying 4097 one-byte chunks — under the byte
    // budget (64MB default) but past the per-stream chunk cap. The inline decode
    // path must halt mid-buffer rather than materialize the whole batch first.
    const oneByte = Buffer.from("x");
    const flood: Buffer[] = [];
    for (let i = 0; i <= 4096; i++) {
      flood.push(blobChunkFrame(51, oneByte, false));
    }
    peer.sendRaw(Buffer.concat(flood));

    await expect(pending).rejects.toMatchObject({
      code: "protocol-error",
      cause: { code: "blob-backpressure-exceeded" },
    });
  });

  it("frees an abandoned request's mid-stream blob allocation and drops its late frames", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer, { maxBlobBytes: 6 });
    peer.acknowledge();
    await transport.ready();
    const onBlob = vi.fn();
    transport.onBlob(onBlob);
    const controller = new AbortController();
    const stopped = new Error("caller left");
    const abandoned = transport.sendRequest(request(26, "blob.abandoned"), controller.signal);
    const rejected = expect(abandoned).rejects.toBe(stopped);
    await nextImmediate();
    peer.send({ type: "blobStart", requestId: 1, streamId: 84, totalBytes: 6, sha256: null });
    peer.sendRaw(blobChunkFrame(84, Buffer.from("abc"), false));
    controller.abort(stopped);
    await rejected;
    expect(peer.received).toContainEqual({ type: "cancel", id: 1 });

    // The engine stops at a frame boundary: one more chunk, then its cancellation.
    peer.sendRaw(blobChunkFrame(84, Buffer.from("de"), false));
    peer.send({
      type: "error",
      id: 1,
      error: { code: "CANCELLED", message: "cancelled", retry: "no" },
    });

    const following = transport.sendRequest(request(27, "blob.after.abandon"));
    await nextImmediate();
    peer.send({ type: "blobStart", requestId: 2, streamId: 85, totalBytes: 6, sha256: null });
    peer.sendRaw(blobChunkFrame(85, Buffer.from("abcdef"), true));
    peer.send({ type: "response", id: 2, result: null });

    await expect(following).resolves.toMatchObject({ id: 27 });
    expect(onBlob).toHaveBeenCalledOnce();
    expect(onBlob).toHaveBeenCalledWith(
      expect.objectContaining({ streamId: 85, bytes: Buffer.from("abcdef") }),
    );
    transport.close();
  });

  it("rejects invalid and over-limit blobStart totalBytes", async () => {
    // 1.5 is a JSON-representable non-integer (unlike NaN, which serializes to
    // null), so it exercises the invalid-integer guard through the real wire.
    for (const [streamId, totalBytes, code] of [
      [41, 1.5, "invalid-blob-start"],
      [46, 6, "blob-too-large"],
    ] as const) {
      const peer = new FakePeerConnection();
      const transport = client(peer, { maxBlobBytes: 5 });
      peer.acknowledge();
      await transport.ready();
      const pending = transport.sendRequest(request(8, "await.invalid.start"));
      peer.send({
        type: "blobStart",
        requestId: 1,
        streamId,
        totalBytes,
        sha256: null,
      });
      await expect(pending).rejects.toMatchObject({
        code: "protocol-error",
        cause: { code },
      });
    }
  });

  it("rejects FIN before the announced blob size is reached", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const pending = transport.sendRequest(request(9, "await.short.blob"));
    peer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 49,
      totalBytes: 5,
      sha256: null,
    });
    peer.sendRaw(blobChunkFrame(49, Buffer.from("1234"), true));

    await expect(pending).rejects.toMatchObject({
      code: "protocol-error",
      cause: { code: "blob-size-mismatch" },
    });
  });

  it("does not resurrect or dispatch after a pre-ready error in the same chunk", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    const onEvent = vi.fn();
    transport.onEvent(onEvent);
    peer.sendRaw(
      Buffer.concat([
        envelopeFrame({
          type: "error",
          error: {
            code: "AUTH_FAILED",
            message: "bad token",
            retry: "no",
          },
        }),
        envelopeFrame(helloAck()),
        envelopeFrame(event()),
      ]),
    );

    await expect(transport.ready()).rejects.toMatchObject({
      code: "handshake-failed",
    });
    expect(onEvent).not.toHaveBeenCalled();
    await expect(transport.sendRequest(request(1, "after.failure"))).rejects.toMatchObject({
      code: "handshake-failed",
      message: expect.stringContaining("is closed"),
    });
  });

  it("unwraps a bounded response and event batch in order", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    let wireId = 0;
    peer.onEnvelope = (envelope) => {
      if (envelope.type === "request") wireId = envelope.id;
    };
    const onEvent = vi.fn();
    transport.onEvent(onEvent);
    const operation = transport.sendRequest(request(81, "batched"));

    peer.send({
      type: "batch",
      envelopes: [{ type: "response", id: wireId, result: "done" }, event(2)],
    });

    await expect(operation).resolves.toEqual({ id: 81, result: "done" });
    expect(onEvent).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledWith(event(2));
    transport.close();
  });

  it("terminally rejects nested batches", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const pending = transport.sendRequest(request(84, "pending"));

    peer.send({
      type: "batch",
      envelopes: [{ type: "batch", envelopes: [] }],
    });

    await expect(pending).rejects.toMatchObject({ code: "protocol-error" });
    await expect(transport.sendRequest(request(85, "after.batch"))).rejects.toMatchObject({
      code: "protocol-error",
      message: expect.stringContaining("is closed"),
    });
  });

  it("rejects an over-limit control frame co-chunked after helloAck", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    const onEvent = vi.fn();
    transport.onEvent(onEvent);
    const ack = helloAck({
      ...LIMITS,
      maxFrameBytes: 64 * 1024,
    });
    const oversizedEvent: Envelope = {
      ...event(),
      payload: { padding: "x".repeat(64 * 1024) },
    };

    peer.sendRaw(Buffer.concat([envelopeFrame(ack), envelopeFrame(oversizedEvent)]));

    await expect(transport.ready()).resolves.toBe(transport);
    expect(onEvent).not.toHaveBeenCalled();
    await expect(transport.sendRequest(request(87, "after.frame"))).rejects.toMatchObject({
      code: "protocol-error",
      message: expect.stringContaining("is closed"),
    });
  });

  it("rejects in-flight work when the peer closes or the client is disposed", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const inFlight = transport.sendRequest(request(9, "slow"));
    peer.closeFromPeer();
    await expect(inFlight).rejects.toMatchObject({
      code: "transport-error",
    });

    const secondPeer = new FakePeerConnection();
    const second = client(secondPeer);
    secondPeer.acknowledge();
    await second.ready();
    const pending = second.sendRequest(request(10, "slow"));
    second.dispose();
    await expect(pending).rejects.toMatchObject({
      code: "closed",
    });
  });

  // The supervisor's wedge kill, on the real client. A wedged daemon never
  // exits on its own, so the supervisor kills it — and once this client is
  // closed, `notifyProcessExit` returns early, so the exit that follows can no
  // longer re-cause these rejections. Whatever is recorded here is final.
  it("reports a wedge kill as a transport failure so callers retry the replacement", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const inFlight = transport.sendRequest(request(300, "wedged.work"));

    transport.closeUnresponsive();

    await expect(inFlight).rejects.toMatchObject({ code: "transport-error" });
    // And the later process exit cannot upgrade it, which is why the cause
    // above has to be right the first time.
    transport.notifyProcessExit(null, "SIGTERM");
    await expect(transport.sendRequest(request(301, "after.kill"))).rejects.toMatchObject({
      code: "transport-error",
    });
  });

  // The wedge detector's one production input. A daemon draining a large
  // backlog answers no probe — the probe cannot overtake its output queue — so
  // this counter is the only thing that tells the supervisor it is alive. If it
  // never advanced, every busy daemon would be killed as wedged.
  it("counts every frame it receives, which is what proves a busy daemon alive", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();

    const beforeWork = transport.inboundActivity();
    const pending = transport.sendRequest(request(400, "bulk.work"));
    const sent = peer.received.at(-1);
    peer.send({
      type: "response",
      id: (sent as { id: number }).id,
      result: "bulk",
    });
    await pending;

    expect(transport.inboundActivity()).toBeGreaterThan(beforeWork);
  });

  // A wedge kill cannot be left on the 2-second timer that a deliberate close
  // uses. The supervisor reports the terminal failure immediately afterwards,
  // and the desktop answers that report with a modal; the event loop stops
  // there, so a deferred kill would wait for the user to dismiss it while the
  // wedged child kept running.
});
