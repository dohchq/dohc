import { parseHostEpoch } from "@dohc/live-session-contract/host-control";
import type { LiveUpdateReceipt } from "@dohc/live-session-contract/live-update-admission";
import { describe, expect, it } from "vitest";
import type { DaemonRequesterClient } from "../live/daemonLiveAdapter";
import type { Request } from "./generated/Request";
import type { Response } from "./generated/Response";
import type { WorkspaceHandle } from "./generated/WorkspaceHandle";
import { OwnerYDocOutbox } from "./ownerYDocOutbox.js";

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
