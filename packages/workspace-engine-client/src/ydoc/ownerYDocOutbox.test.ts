import { createHash } from "node:crypto";
import { parseHostEpoch } from "@dohc/live-session-contract/host-control";
import type { LiveUpdateReceipt } from "@dohc/live-session-contract/live-update-admission";
import { describe, expect, it } from "vitest";
import type { DaemonRequesterClient } from "../live/daemonLiveAdapter";
import type { Request, Response, WorkspaceHandle } from "../protocol";
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
      quarantineReason: null,
      observedBinding: null,
    };
  }

  function pages(result: ReturnType<typeof pendingResult>, chunkSize = 31) {
    const { entries, baseUpdateBase64, ...header } = result;
    const base = Buffer.from(baseUpdateBase64, "base64");
    const parts = [
      { part: "header", sequence: 0, bytes: Buffer.from(JSON.stringify({
        ...header, baseByteLength: base.length, pendingEntryCount: entries.length,
        nextSequence: Math.max(0, ...entries.map((entry) => entry.sequence)) + 1,
      })) },
      { part: "base", sequence: 0, bytes: base },
      ...entries.flatMap(({ updateBase64, ...entry }) => [
        { part: "entryHeader", sequence: entry.sequence, bytes: Buffer.from(JSON.stringify(entry)) },
        { part: "update", sequence: entry.sequence, bytes: Buffer.from(updateBase64, "base64") },
      ]),
    ];
    const snapshot = "a".repeat(64);
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
    return { read: () => client.readPending("outbox-1"), requests };
  }

  function read(result: ReturnType<typeof pendingResult>) {
    return reader(pages(result)).read();
  }

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

  it("discards a changed snapshot and does not automatically retry", async () => {
    const responses = pages(pendingResult());
    const last = responses.length - 1;
    const run = reader(responses, last);
    await expect(run.read()).rejects.toBeInstanceOf(OwnerYDocOutboxReadChangedError);
    expect(run.requests).toHaveLength(last + 1);
  });

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
    },
  );

  it("refuses corrupt blob bytes even when the advertised length is unchanged", async () => {
    const responses = pages(pendingResult());
    const update = responses.find((page) => page.part === "update")!;
    update.bytesBase64 = "BQYH";
    await expect(reader(responses).read()).rejects.toThrow("digest does not match");
  });
});
