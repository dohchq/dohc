import { createHash } from "node:crypto";
import { parseHostEpoch } from "@dohc/live-session-contract/host-control";
import type { LiveUpdateReceipt } from "@dohc/live-session-contract/live-update-admission";
import { describe, expect, it } from "vitest";
import type { DaemonRequesterClient } from "../live/daemonLiveAdapter";
import type { JsonValue, Request, Response, WorkspaceHandle } from "../protocol";
import { OwnerYDocOutbox, OwnerYDocOutboxReadChangedError } from "./ownerYDocOutbox.js";

const WORKSPACE = "owner-outbox-receipt-test" as WorkspaceHandle;
const SENTINEL = new Error("invalid receipt reached sendRequest");

class RecordingRequester implements DaemonRequesterClient {
  readonly requests: Request[] = [];

  constructor(private readonly refuseRequests = false) {}

  async sendRequest(request: Request): Promise<Response> {
    this.requests.push(request);
    if (this.refuseRequests) throw SENTINEL;
    return {
      id: request.id,
      result: {
        acknowledged: 2,
        pendingBytes: 0,
        oldestEntryAtMs: null,
      },
    };
  }
}

function receipt(
  acceptingHostEpoch: number,
  journalCursor: number,
  suffix = "1",
): LiveUpdateReceipt {
  return {
    deliveryId: `delivery-${suffix}`,
    updateDigest: suffix.repeat(64).slice(0, 64),
    acceptingHostEpoch: parseHostEpoch(acceptingHostEpoch),
    journalCursor,
  };
}

function outbox(client: DaemonRequesterClient): OwnerYDocOutbox {
  return new OwnerYDocOutbox(client, WORKSPACE);
}

describe("OwnerYDocOutbox append boundary", () => {
  const input = {
    binding: { workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64), currentPath: "a.md", selectorPaths: ["a.md"], restoreFenceGeneration: 0 },
    baseUpdate: Uint8Array.of(1), appendKey: "edit", update: Uint8Array.of(2),
    limits: { maxPendingBytes: 1000, maxPendingAgeMs: 1000 },
  };
  const result = { outboxId: "outbox", sequence: 1, deliveryId: "delivery", updateDigest: "b".repeat(64), pendingBytes: 1, oldestEntryAtMs: 0, state: "sealed" };

  it("strips daemon extras and forwards append inputs without adding digest equality policy", async () => {
    const requests: Request[] = [];
    const client: DaemonRequesterClient = { async sendRequest(request) {
      requests.push(request);
      return { id: request.id, result: { ...result, extra: true } };
    } };
    expect(await outbox(client).append(input)).toEqual(result);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ workspace: WORKSPACE, method: "ydoc.ownerOutbox.append", params: {
      binding: input.binding, baseUpdateBase64: "AQ==", appendKey: "edit", updateBase64: "Ag==", limits: input.limits,
    } });
  });

  it.each([null, [], { ...result, pendingBytes: 0 }, { ...result, state: "quarantined" }, { ...result, outboxId: "bad\u0000" }, { ...result, updateDigest: "bad" }])("rejects malformed append replies with TypeError", async (reply) => {
    const client: DaemonRequesterClient = { async sendRequest(request) { return { id: request.id, result: reply as JsonValue }; } };
    await expect(outbox(client).append(input)).rejects.toThrow(TypeError);
  });
});

describe("OwnerYDocOutbox Try again", () => {
  const binding = { workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64), currentPath: "a.md", selectorPaths: ["a.md"], restoreFenceGeneration: 3 };

  it("asks the engine for one more attempt at the binding generation the owner saw", async () => {
    const requests: Request[] = [];
    const client: DaemonRequesterClient = { async sendRequest(request) {
      requests.push(request);
      return { id: request.id, result: { retryDeliveryId: "delivery-1" } };
    } };
    expect(await outbox(client).retry({ outboxId: "outbox", binding })).toEqual({ retryDeliveryId: "delivery-1" });
    expect(requests).toMatchObject([{ workspace: WORKSPACE, method: "ydoc.ownerOutbox.retry", params: { outboxId: "outbox", binding } }]);
  });

  it("refuses a malformed binding before the engine and a reply without its delivery", async () => {
    const requests: Request[] = [];
    const client: DaemonRequesterClient = { async sendRequest(request) {
      requests.push(request);
      return { id: request.id, result: {} };
    } };
    await expect(outbox(client).retry({ outboxId: "outbox", binding: { ...binding, restoreFenceGeneration: -1 } })).rejects.toThrow();
    expect(requests).toEqual([]);
    await expect(outbox(client).retry({ outboxId: "outbox", binding })).rejects.toThrow("retryDeliveryId");
  });

  it("records a refusal with the head it refused and its key, and other quarantines without one", async () => {
    const requests: Request[] = [];
    const client: DaemonRequesterClient = { async sendRequest(request) {
      requests.push(request);
      return { id: request.id, result: { quarantined: true } };
    } };
    await outbox(client).quarantine({ outboxId: "outbox", reason: "invalid-update", refusal: { deliveryId: "delivery-1", key: "refusal-1" } });
    await outbox(client).quarantine({ outboxId: "outbox", reason: "binding-changed", observedBinding: binding });
    expect(requests.map(request => request.params)).toEqual([
      { outboxId: "outbox", reason: "invalid-update", refusal: { deliveryId: "delivery-1", key: "refusal-1" } },
      { outboxId: "outbox", reason: "binding-changed", observedBinding: binding },
    ]);
  });
});

describe("OwnerYDocOutbox restore-fenced discovery", () => {
  const binding = { workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64), currentPath: "a.md", selectorPaths: ["a.md"], restoreFenceGeneration: 3 };
  const row = { outboxId: "old-queue", binding, pendingBytes: 12, oldestEntryAtMs: 5 };
  function requester(reply: JsonValue, requests: Request[] = []): DaemonRequesterClient {
    return { async sendRequest(request) {
      requests.push(request);
      return { id: request.id, result: reply };
    } };
  }

  it("lists retained queues with their earlier binding and a continuation", async () => {
    const requests: Request[] = [];
    const client = outbox(requester({ queues: [row], next: row.outboxId }, requests));
    expect(await client.listRestoreFenced({ after: "earlier", limit: 1 })).toEqual({ queues: [row], next: row.outboxId });
    expect(requests).toMatchObject([{ workspace: WORKSPACE, method: "ydoc.ownerOutbox.listRestoreFenced", params: { after: "earlier", limit: 1 } }]);
  });

  it("accepts the final empty page", async () => {
    expect(await outbox(requester({ queues: [], next: null })).listRestoreFenced()).toEqual({ queues: [], next: null });
  });

  it.each([0, 65, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid page size %s before sending", async limit => {
    const requests: Request[] = [];
    await expect(outbox(requester({}, requests)).listRestoreFenced({ limit })).rejects.toThrow(TypeError);
    expect(requests).toEqual([]);
  });

  it.each([
    { queues: [{ ...row, pendingBytes: 0 }], next: null },
    { queues: [{ ...row, oldestEntryAtMs: null }], next: null },
    { queues: [{ ...row, binding: { ...binding, restoreFenceGeneration: -1 } }], next: null },
    { queues: [row, row], next: null },
    { queues: [row], next: "another-queue" },
    { queues: [], next: "old-queue" },
    { queues: [row], next: null, extra: true },
  ])("rejects malformed or unbounded discovery responses", async reply => {
    await expect(outbox(requester(reply)).listRestoreFenced({ limit: 1 })).rejects.toThrow(TypeError);
  });
});

describe("OwnerYDocOutbox receipt boundary", () => {
  it("forwards minimum and maximum safe receipt coordinates unchanged", async () => {
    const client = new RecordingRequester();
    const receipts = [
      receipt(1, 1),
      receipt(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, "2"),
    ];

    await expect(outbox(client).acknowledge("outbox-1", receipts)).resolves.toEqual({
      acknowledged: 2,
      pendingBytes: 0,
      oldestEntryAtMs: null,
    });
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]).toMatchObject({
      method: "ydoc.ownerOutbox.acknowledge",
      params: { outboxId: "outbox-1", receipts },
      workspace: WORKSPACE,
    });
  });

  it.each([
    ["string", "1"],
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["overflowing", Number.MAX_SAFE_INTEGER + 1],
  ])("refuses a %s host epoch before sendRequest", async (_name, value) => {
    const client = new RecordingRequester(true);
    const invalid = {
      ...receipt(1, 1),
      acceptingHostEpoch: value as never,
    };

    await expect(outbox(client).acknowledge("outbox-1", [invalid])).rejects.toThrow(
      TypeError,
    );
    expect(client.requests).toEqual([]);
  });

  it.each([
    ["string", "1"],
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["overflowing", Number.MAX_SAFE_INTEGER + 1],
  ])("refuses a %s journal cursor before sendRequest", async (_name, value) => {
    const client = new RecordingRequester(true);
    const invalid = {
      ...receipt(1, 1),
      journalCursor: value as never,
    };

    await expect(outbox(client).acknowledge("outbox-1", [invalid])).rejects.toThrow(
      TypeError,
    );
    expect(client.requests).toEqual([]);
  });

  it("refuses the complete receipt array when one receipt is invalid", async () => {
    const client = new RecordingRequester(true);
    const invalid = {
      ...receipt(2, 2, "2"),
      acceptingHostEpoch: 0 as never,
    };

    await expect(
      outbox(client).acknowledge("outbox-1", [receipt(1, 1), invalid]),
    ).rejects.toThrow(TypeError);
    expect(client.requests).toEqual([]);
  });

  it("uses the canonical receipt parser before sendRequest", async () => {
    const client = new RecordingRequester(true);
    const invalid = {
      ...receipt(1, 1),
      updateDigest: "A".repeat(64),
    };

    await expect(outbox(client).acknowledge("outbox-1", [invalid])).rejects.toThrow(
      TypeError,
    );
    expect(client.requests).toEqual([]);
  });

  it("refuses a sparse receipt array before sendRequest", async () => {
    const client = new RecordingRequester(true);
    const receipts = new Array<LiveUpdateReceipt>(1);

    await expect(outbox(client).acknowledge("outbox-1", receipts)).rejects.toThrow(
      TypeError,
    );
    expect(client.requests).toEqual([]);
  });

  it("refuses a receipt array whose index exists only on its prototype", async () => {
    const client = new RecordingRequester(true);
    const receipts = new Array<LiveUpdateReceipt>(1);
    const prototype = Object.create(Array.prototype) as Record<string, unknown>;
    prototype[0] = receipt(1, 1);
    Object.setPrototypeOf(receipts, prototype);

    await expect(outbox(client).acknowledge("outbox-1", receipts)).rejects.toThrow(
      TypeError,
    );
    expect(client.requests).toEqual([]);
  });
});

describe("OwnerYDocOutbox pending byte boundary", () => {
  const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  function pendingResult() {
    return {
      outboxId: "outbox-1",
      binding: {
        workspaceId: "workspace-1",
        mainVersionId: "main",
        objectId: "object-1",
        lineageClaimId: "lineage-1",
        currentPath: "notes/owner.md",
        selectorPaths: ["notes/owner.md"],
        restoreFenceGeneration: 1,
      },
      baseUpdateDigest: sha(new Uint8Array([0, 1])),
      baseUpdateBase64: "AAE=",
      state: "active",
      pendingBytes: 3,
      oldestEntryAtMs: 1,
      entries: [{
        sequence: 1,
        appendKey: "append-1",
        deliveryId: "delivery-1",
        updateDigest: sha(new Uint8Array([2, 3, 4])),
        updateBase64: "AgME",
        byteLength: 3,
        createdAtMs: 1,
      }],
      quarantineReason: null as string | null,
      observedBinding: null,
      retryDeliveryId: null as string | null,
    };
  }

  function pages(result: ReturnType<typeof pendingResult>, chunkSize = 31) {
    const { entries, baseUpdateBase64, ...header } = result;
    const base = Buffer.from(baseUpdateBase64, "base64");
    const snapshot = "a".repeat(64);
    const parts = [
      { part: "header", sequence: 0, bytes: Buffer.from(JSON.stringify({
        frozenAtRefusedSeed: false, checkpointDigest: null, recoveryCheckpointDigest: null,
        ...header, baseByteLength: base.length, pendingEntryCount: entries.length,
        nextSequence: Math.max(0, ...entries.map((entry) => entry.sequence)) + 1,
        firstEntryCursor: entries[0] ? {snapshot,part: "entryHeader",sequence: entries[0].sequence,offset: 0} : null,
      })) },
      { part: "base", sequence: 0, bytes: base },
      ...entries.flatMap(({ updateBase64, ...entry }) => [
        { part: "entryHeader", sequence: entry.sequence, bytes: Buffer.from(JSON.stringify(entry)) },
        { part: "update", sequence: entry.sequence, bytes: Buffer.from(updateBase64, "base64") },
      ]),
    ];
    const resultPages = parts.flatMap(({ part, sequence, bytes }) => {
      const offsets = Array.from({ length: Math.max(1, Math.ceil(bytes.length / chunkSize)) }, (_, i) => i * chunkSize);
      return offsets.map((offset) => ({
        kind: "page", snapshot, part, sequence, offset, totalBytes: bytes.length,
        digest: sha(bytes), bytesBase64: bytes.subarray(offset, offset + chunkSize).toString("base64"),
        nextCursor: null as null | { snapshot: string; part: string; sequence: number; offset: number },
      }));
    });
    resultPages.forEach((page, index) => {
      const next = resultPages[index + 1];
      if (next !== undefined) page.nextCursor = { snapshot, part: next.part, sequence: next.sequence, offset: next.offset };
    });
    return resultPages;
  }

  function reader(responses: ReturnType<typeof pages>, changedAt?: number) {
    const requests: Request[] = [];
    const client = outbox({
      async sendRequest(request) {
        const index = requests.push(request) - 1;
        const expected = index === 0 ? { outboxId: "outbox-1" } : {
          outboxId: "outbox-1", cursor: responses[index - 1]?.nextCursor,
        };
        expect(request.params).toEqual(expected);
        if (index === changedAt) return { id: request.id, result: { kind: "readChanged" } };
        const result = responses[index];
        if (result === undefined) throw new Error("Read exceeded the finite fixture.");
        return { id: request.id, result };
      },
    });
    return {
      read: () => client.readPending("outbox-1"),
      readHead: () => client.readHead("outbox-1"),
      requests,
    };
  }

  function read(result: ReturnType<typeof pendingResult>) {
    return reader(pages(result)).read();
  }

  function deliveryReader(responses: ReturnType<typeof pages>, binding: ReturnType<typeof pendingResult>["binding"], changedAt?: number) {
    const requests: Request[] = [];
    const client = outbox({async sendRequest(request) {
      requests.push(request);
      if (requests.length === changedAt) return {id: request.id,result: {kind: "readChanged"}};
      const cursor = (request.params as {cursor?: {part: string; sequence: number; offset: number}}).cursor;
      const page = cursor === undefined ? responses[0] : responses.find(page => page.part === cursor.part && page.sequence === cursor.sequence && page.offset === cursor.offset);
      if (!page) throw new Error("Cursor is outside the fixture.");
      return {id: request.id,result: page};
    }});
    return {requests,read: () => client.readDeliveryHead("outbox-1",binding)};
  }

  it("reads the head its owner asked to try again, and refuses a header without that field", async () => {
    const granted = { ...pendingResult(), state: "quarantined", quarantineReason: "invalid-update", retryDeliveryId: "delivery-1" };
    expect(await read(granted)).toMatchObject({ state: "quarantined", quarantineReason: "invalid-update", retryDeliveryId: "delivery-1" });
    const { retryDeliveryId: _absent, ...missing } = pendingResult();
    await expect(read(missing as ReturnType<typeof pendingResult>)).rejects.toThrow("retryDeliveryId");
  });

  it("preserves non-empty base and update bytes with matching accounting", async () => {
    const pending = await read(pendingResult());
    expect(pending.baseUpdate).toEqual(new Uint8Array([0, 1]));
    expect(pending.entries[0]?.update).toEqual(new Uint8Array([2, 3, 4]));
    expect(pending.entries[0]?.byteLength).toBe(3);
  });

  it("refuses an empty base instead of returning a delivery envelope", async () => {
    const result = pendingResult();
    result.baseUpdateBase64 = "";
    await expect(read(result)).rejects.toThrow("baseByteLength");
  });

  it("refuses an empty update with a positive advertised byte length", async () => {
    const result = pendingResult();
    result.entries[0]!.updateBase64 = "";
    await expect(read(result)).rejects.toThrow("totalBytes");
  });

  it.each([2, 4])("refuses an advertised update length of %s for three decoded bytes", async (byteLength) => {
    const result = pendingResult();
    result.entries[0]!.byteLength = byteLength;
    result.pendingBytes = byteLength;
    await expect(read(result)).rejects.toThrow("part length or digest changed");
  });

  it("assembles individually split blobs and multiple entries without returning partial bytes", async () => {
    const result = pendingResult();
    const base = Buffer.alloc(257, 17);
    const update = Buffer.alloc(263, 23);
    result.baseUpdateBase64 = base.toString("base64");
    result.baseUpdateDigest = sha(base);
    result.entries[0]!.updateBase64 = update.toString("base64");
    result.entries[0]!.updateDigest = sha(update);
    result.entries[0]!.byteLength = update.length;
    result.entries.push({ ...result.entries[0]!, sequence: 3, deliveryId: "delivery-3", appendKey: "append-3" });
    result.pendingBytes = update.length * 2;
    const responses = pages(result, 11);
    const run = reader(responses);
    const pending = await run.read();
    expect(pending.baseUpdate).toEqual(new Uint8Array(base));
    expect(pending.entries.map((entry) => entry.sequence)).toEqual([1, 3]);
    expect(pending.entries.map((entry) => entry.update)).toEqual([new Uint8Array(update), new Uint8Array(update)]);
    expect(run.requests).toHaveLength(responses.length);
  });

  it("reads a recorded person's marker and leaves unmarked entries absent", async () => {
    const result = pendingResult();
    result.entries.push({...result.entries[0]!, sequence: 3, deliveryId: "delivery-3", appendKey: "append-3"});
    result.pendingBytes = 6;
    Object.assign(result.entries[0]!, {personEdit: true});
    const pending = await read(result);
    expect(pending.entries[0]?.personEdit).toBe(true);
    expect(pending.entries[1]).not.toHaveProperty("personEdit");
  });
  it.each([false, null, "human", 1])("rejects a malformed person marker %j", async personEdit => {
    const result = pendingResult(); Object.assign(result.entries[0]!, {personEdit});
    await expect(read(result)).rejects.toThrow(TypeError);
  });

  it("reads the agent an entry declared and adds none to an entry that declared none", async () => {
    const result = pendingResult();
    result.entries.push({ ...result.entries[0]!, sequence: 3, deliveryId: "delivery-3", appendKey: "append-3" });
    result.pendingBytes = 6;
    const agentDeclaration = { agentId: "trip-agent", onBehalfOf: "local-person", depth: 2 };
    Object.assign(result.entries[0]!, { agentDeclaration });
    const pending = await read(result);
    expect(pending.entries[0]?.agentDeclaration).toEqual(agentDeclaration);
    expect(pending.entries[1]).not.toHaveProperty("agentDeclaration");
  });

  it.each([
    null,
    { agentId: "", onBehalfOf: null, depth: 0 },
    { agentId: "agent\u0085", onBehalfOf: null, depth: 0 },
    { agentId: "agent", onBehalfOf: null, depth: 65 },
    { agentId: "agent", depth: 0 },
    { agentId: "agent", onBehalfOf: null, depth: 0, principalId: "owner" },
  ])("refuses a malformed agent declaration %j", async (agentDeclaration) => {
    const result = pendingResult();
    Object.assign(result.entries[0]!, { agentDeclaration });
    await expect(read(result)).rejects.toThrow(TypeError);
  });

  function nativeSourceOf(result: ReturnType<typeof pendingResult>, origin: Record<string, unknown>) {
    return {binding: result.binding, adoptionId: "adoption-1", nativeSequence: 4, updateDigest: result.entries[0]!.updateDigest, origin};
  }

  it.each([["human", "local-person"], ["agent", "trip-agent"], ["automation", "automation-1"]])(
    "reads the %s a native entry's journal recorded", async (actorKind, actorOriginId) => {
      const result = pendingResult();
      const nativeSource = nativeSourceOf(result, {kind: "nativeUpdate", actorOriginId, actorKind,
        onBehalfOf: actorKind === "human" ? null : "local-person", chainDepth: actorKind === "human" ? 0 : 1, recordedAtMs: 7});
      Object.assign(result.entries[0]!, {nativeSource});
      expect((await read(result)).entries[0]?.nativeSource).toEqual(nativeSource);
    });

  it("reads an adoption seed's source and leaves an entry without one absent", async () => {
    const result = pendingResult();
    result.entries.push({...result.entries[0]!, sequence: 3, deliveryId: "delivery-3", appendKey: "append-3"});
    result.pendingBytes = 6;
    const nativeSource = nativeSourceOf(result, {kind: "adoptionSeed"});
    Object.assign(result.entries[0]!, {nativeSource});
    const pending = await read(result);
    expect(pending.entries[0]?.nativeSource).toEqual(nativeSource);
    expect(pending.entries[1]).not.toHaveProperty("nativeSource");
  });

  it.each([
    {kind: "nativeUpdate"},
    {kind: "foreign"},
    {kind: "adoptionSeed", note: 1},
    {kind: "nativeUpdate", actorOriginId: "", actorKind: null, onBehalfOf: null, chainDepth: null, recordedAtMs: 1},
  ])("refuses a malformed native origin %j", async origin => {
    const result = pendingResult();
    Object.assign(result.entries[0]!, {nativeSource: nativeSourceOf(result, origin)});
    await expect(read(result)).rejects.toThrow(TypeError);
  });

  it("refuses a native source recorded for other bytes", async () => {
    const result = pendingResult();
    Object.assign(result.entries[0]!, {nativeSource: {...nativeSourceOf(result, {kind: "adoptionSeed"}), updateDigest: "f".repeat(64)}});
    await expect(read(result)).rejects.toThrow("Invalid native source.");
  });

  function checkpointPages(checkpoint: Buffer) {
    const snapshot = "a".repeat(64);
    const offsets = [0, 4].filter(offset => offset < checkpoint.length);
    return offsets.map((offset, index) => ({kind: "page", snapshot, part: "checkpoint", sequence: 0, offset, totalBytes: checkpoint.length,
      digest: sha(checkpoint), bytesBase64: checkpoint.subarray(offset, offset + 4).toString("base64"),
      nextCursor: offsets[index + 1] === undefined ? null : {snapshot, part: "checkpoint", sequence: 0, offset: offsets[index + 1]!}}));
  }

  function cursorReader(responses: ReturnType<typeof pages>) {
    const parts: string[] = [];
    const client = outbox({async sendRequest(request) {
      const cursor = (request.params as {cursor?: {part: string; sequence: number; offset: number}}).cursor;
      const page = cursor === undefined ? responses[0] : responses.find(page => page.part === cursor.part && page.sequence === cursor.sequence && page.offset === cursor.offset);
      if (!page) throw new Error("Cursor is outside the fixture.");
      parts.push(page.part);
      return {id: request.id, result: page};
    }});
    return {client, parts};
  }

  it("reads a recovery's checkpoint after the whole queue, and none for a queue without a binding", async () => {
    const checkpoint = Buffer.from([9, 8, 7, 6, 5, 4]);
    const bound = {...pendingResult(), state: "quarantined", quarantineReason: "invalid-update", checkpointDigest: sha(checkpoint)};
    const recovering = cursorReader([...pages(bound, 5), ...checkpointPages(checkpoint)]);
    const recovery = await recovering.client.readRecovery("outbox-1");
    expect(recovery.checkpoint).toEqual(new Uint8Array(checkpoint));
    // A confirmation of this copy names what it read.
    expect(recovery.checkpointDigest).toBe(sha(checkpoint));
    expect(recovery.entries[0]?.update).toEqual(new Uint8Array([2, 3, 4]));
    expect(recovering.parts.slice(-2)).toEqual(["checkpoint", "checkpoint"]);
    expect(recovering.parts.indexOf("checkpoint")).toBeGreaterThan(recovering.parts.lastIndexOf("update"));
    const withoutBinding = {...pendingResult(), checkpointDigest: null};
    const unbound = cursorReader(pages(withoutBinding, 5));
    expect(await unbound.client.readRecovery("outbox-1")).toMatchObject({checkpoint: null, checkpointDigest: null});
    expect(unbound.parts).not.toContain("checkpoint");
    // Delivery never reads it.
    const delivering = cursorReader([...pages(bound, 5), ...checkpointPages(checkpoint)]);
    expect(await delivering.client.readPending("outbox-1")).not.toHaveProperty("checkpoint");
    expect(delivering.parts).not.toContain("checkpoint");
  });

  it("reads a checkpoint that changed since the header, or between its pages, as a changed read", async () => {
    const checkpoint = Buffer.from([9, 8, 7, 6, 5, 4]), successor = Buffer.from([1, 2, 3, 4, 5, 6, 7]);
    const bound = {...pendingResult(), state: "quarantined", quarantineReason: "invalid-update", checkpointDigest: sha(checkpoint)};
    const [first] = checkpointPages(checkpoint), [, second] = checkpointPages(successor);
    const betweenPages = cursorReader([...pages(bound, 5), first!, second!]);
    await expect(betweenPages.client.readRecovery("outbox-1")).rejects.toBeInstanceOf(OwnerYDocOutboxReadChangedError);
    const sinceHeader = cursorReader([...pages(bound, 5), ...checkpointPages(successor)]);
    await expect(sinceHeader.client.readRecovery("outbox-1")).rejects.toBeInstanceOf(OwnerYDocOutboxReadChangedError);
    // A header read over several pages names the checkpoint's digest, so an acceptance changes it too.
    const [header] = pages(bound, 5), advanced = {...bound, checkpointDigest: sha(successor)};
    const duringHeader = cursorReader([header!, ...pages(advanced, 5).slice(1), ...checkpointPages(successor)]);
    await expect(duringHeader.client.readRecovery("outbox-1")).rejects.toBeInstanceOf(OwnerYDocOutboxReadChangedError);
    const presenceOnly = {...bound, checkpointDigest: "present"};
    const malformed = cursorReader([...pages(presenceOnly, 5), ...checkpointPages(checkpoint)]);
    await expect(malformed.client.readRecovery("outbox-1")).rejects.toThrow("checkpointDigest must be a SHA-256 digest.");
  });

  it("discards a changed snapshot and does not automatically retry", async () => {
    const responses = pages(pendingResult());
    const last = responses.length - 1;
    const run = reader(responses, last);
    await expect(run.read()).rejects.toBeInstanceOf(OwnerYDocOutboxReadChangedError);
    expect(run.requests).toHaveLength(last + 1);
  });

  it("reads a complete delivery head without downloading the queued suffix", async () => {
    const result = pendingResult();
    result.entries.push({ ...result.entries[0]!, sequence: 3, deliveryId: "delivery-3", appendKey: "append-3" });
    result.pendingBytes = 6;
    const responses = pages(result, 1);
    const headPages = responses.findIndex((page) => page.part === "entryHeader" && page.sequence === 3);
    const run = reader(responses);
    const head = await run.readHead();
    expect(head.baseUpdate).toEqual(new Uint8Array([0, 1]));
    expect(head.entry).toMatchObject({ sequence: 1, update: new Uint8Array([2, 3, 4]) });
    expect(head.pendingBytes).toBe(6);
    expect(head).not.toHaveProperty("entries");
    expect(run.requests).toHaveLength(headPages);
  });

  it.each(["changed", "corrupt", "truncated", "bad-suffix"] as const)(
    "refuses a %s delivery head before exposing bytes",
    async (damage) => {
      const result = pendingResult();
      result.entries.push({ ...result.entries[0]!, sequence: 3, deliveryId: "delivery-3", appendKey: "append-3" });
      result.pendingBytes = 6;
      const responses = pages(result, 1);
      const lastHeadPage = responses.findIndex((page) => page.part === "entryHeader" && page.sequence === 3) - 1;
      const page = responses[lastHeadPage]!;
      if (damage === "corrupt") page.bytesBase64 = "BQ==";
      if (damage === "truncated") responses[lastHeadPage - 1]!.nextCursor = null;
      if (damage === "bad-suffix") page.nextCursor!.sequence = 1;
      const run = reader(responses, damage === "changed" ? lastHeadPage : undefined);
      await expect(run.readHead()).rejects.toThrow();
      expect(run.requests.length).toBeLessThanOrEqual(lastHeadPage + 1);
    },
  );

  it("requires exact accounting when the delivery head is the final entry", async () => {
    const result = pendingResult();
    result.pendingBytes += 1;
    await expect(reader(pages(result)).readHead()).rejects.toThrow("snapshot is incomplete");
  });

  it("reads the native first entry with gaps without returning or requesting base bytes", async () => {
    const result = pendingResult(); result.binding.lineageClaimId = result.baseUpdateDigest;
    result.entries[0]!.sequence = 3;
    result.entries.push({...result.entries[0]!,sequence: 7,appendKey: "append-7",deliveryId: "delivery-7"});
    result.pendingBytes = 6;
    const run = deliveryReader(pages(result,4096),result.binding);
    const head = await run.read();
    expect(head.entry).toMatchObject({sequence: 3,update: new Uint8Array([2,3,4])});
    expect(head).not.toHaveProperty("baseUpdate");
    expect(run.requests.map(request => (request.params as {cursor?: {part: string}}).cursor?.part ?? "header")).toEqual(["header","entryHeader","update"]);
  });

  it("reports whether a delivery head is a seed frozen at its generation, with the checkpoint a copy reads, and refuses a header without them", async () => {
    const frozen = {...pendingResult(), state: "quarantined", quarantineReason: "invalid-update", frozenAtRefusedSeed: true, checkpointDigest: "c".repeat(64),
      recoveryCheckpointDigest: "c".repeat(64) as string | null};
    frozen.binding.lineageClaimId = frozen.baseUpdateDigest;
    expect(await deliveryReader(pages(frozen, 4096), frozen.binding).read())
      .toMatchObject({frozenAtRefusedSeed: true, checkpointDigest: "c".repeat(64), recoveryCheckpointDigest: "c".repeat(64)});
    // An earlier generation's refused seed freezes nothing, and a copy must still hold its checkpoint.
    const earlier = {...frozen, frozenAtRefusedSeed: false};
    expect(await deliveryReader(pages(earlier, 4096), earlier.binding).read())
      .toMatchObject({frozenAtRefusedSeed: false, recoveryCheckpointDigest: "c".repeat(64)});
    // A plain read of the queue carries none of them.
    const plain = await read(frozen);
    expect(plain).not.toHaveProperty("frozenAtRefusedSeed");
    expect(plain).not.toHaveProperty("checkpointDigest");
    expect(plain).not.toHaveProperty("recoveryCheckpointDigest");
    for (const damage of [{frozenAtRefusedSeed: "yes"}, {checkpointDigest: "c"}, {recoveryCheckpointDigest: "d".repeat(64)}, {recoveryCheckpointDigest: undefined}]) {
      const damaged = {...frozen, ...damage};
      await expect(deliveryReader(pages(damaged, 4096), damaged.binding).read()).rejects.toThrow();
    }
  });

  it.each(["binding","base-digest","base-length","cursor-snapshot","cursor-sequence","missing-cursor","update-hash","changed"])(
    "refuses a delivery head with %s damage before returning an entry",
    async damage => {
      const result = pendingResult(); result.binding.lineageClaimId = result.baseUpdateDigest;
      const expected = {...result.binding};
      if (damage === "binding") result.binding.objectId = "other";
      if (damage === "base-digest") result.baseUpdateDigest = "f".repeat(64);
      const responses = pages(result,4096), header = responses[0]!;
      const raw = JSON.parse(Buffer.from(header.bytesBase64,"base64").toString());
      if (damage === "base-length") raw.baseByteLength = 0;
      if (damage === "cursor-snapshot") raw.firstEntryCursor.snapshot = "f".repeat(64);
      if (damage === "cursor-sequence") raw.firstEntryCursor.sequence = raw.nextSequence;
      if (damage === "missing-cursor") delete raw.firstEntryCursor;
      const bytes = Buffer.from(JSON.stringify(raw));
      header.bytesBase64 = bytes.toString("base64"); header.digest = sha(bytes); header.totalBytes = bytes.length;
      if (damage === "update-hash") responses.find(page => page.part === "update")!.bytesBase64 = "BQYH";
      const run = deliveryReader(responses,expected,damage === "changed" ? 3 : undefined);
      await expect(run.read()).rejects.toThrow();
      expect(run.requests.length).toBeLessThanOrEqual(3);
    },
  );

  it.each(["empty", "rewind", "offset", "snapshot", "digest", "truncated", "extra"] as const)(
    "refuses a %s page before returning a snapshot",
    async (damage) => {
      const responses = pages(pendingResult());
      const page = responses[0]!;
      if (damage === "empty") page.bytesBase64 = "";
      if (damage === "rewind") page.nextCursor!.offset = 0;
      if (damage === "offset") page.offset = 1;
      if (damage === "snapshot") responses[1]!.snapshot = "b".repeat(64);
      if (damage === "digest") page.digest = "b".repeat(64);
      if (damage === "truncated") page.nextCursor = null;
      if (damage === "extra") responses.at(-1)!.nextCursor = { snapshot: page.snapshot, part: "entryHeader", sequence: 2, offset: 0 };
      await expect(reader(responses).read()).rejects.toThrow();
      await expect(reader(responses).readHead()).rejects.toThrow();
    },
  );

  it("refuses corrupt blob bytes even when the advertised length is unchanged", async () => {
    const responses = pages(pendingResult());
    const update = responses.find((page) => page.part === "update")!;
    update.bytesBase64 = "BQYH";
    await expect(reader(responses).read()).rejects.toThrow("digest does not match");
    await expect(reader(responses).readHead()).rejects.toThrow("digest does not match");
  });
});
