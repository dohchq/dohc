import { describe, expect, it } from "vitest";
import { RelayFilePeer } from "./relayFilePeer";

interface RecordedRequest {
  url: string;
  method: string;
  body: BodyInit | null | undefined;
}

function recordingRelay(): {
  requests: RecordedRequest[];
  fetch: typeof fetch;
} {
  const requests: RecordedRequest[] = [];
  const stored = new Set<string>();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push({
      url: url.pathname,
      method: init?.method ?? "GET",
      body: init?.body,
    });
    if (url.pathname.endsWith("/blobs/have")) {
      const body = JSON.parse(String(init?.body)) as { sha256s: string[] };
      return Response.json({
        ok: true,
        missing: body.sha256s.filter((sha256) => !stored.has(sha256)),
      });
    }
    if (init?.method === "PUT") {
      stored.add(url.pathname.split("/").at(-1)!);
      return Response.json({ ok: true });
    }
    if (url.pathname.endsWith("/log")) {
      const body = JSON.parse(String(init?.body)) as {
        ops: Array<{ originSeq: number }>;
      };
      return Response.json({
        ok: true,
        currentMaxOriginSeq: body.ops.at(-1)?.originSeq ?? -1,
      });
    }
    return new Response("unexpected route", { status: 500 });
  };
  return { requests, fetch: fetchImpl };
}

function logOperations(requests: RecordedRequest[]): Array<{
  originSeq: number;
  opKind: string;
  payload: Record<string, unknown>;
}> {
  return requests
    .filter((request) => request.url.endsWith("/log"))
    .flatMap((request) => {
      const body = JSON.parse(String(request.body)) as {
        ops: Array<{
          originSeq: number;
          opKind: string;
          payload: Record<string, unknown>;
        }>;
      };
      return body.ops;
    });
}

describe("RelayFilePeer", () => {
  it("uploads blobs and preserves contiguous coordinates with exact write preimages", async () => {
    const relay = recordingRelay();
    let nextId = 0;
    const peer = new RelayFilePeer({
      baseUrl: "https://relay.test",
      token: "peer-token",
      workspaceId: "workspace-a",
      originId: "peer-a",
      fetch: relay.fetch,
      nowMs: () => 1_000,
      newId: (kind) => `${kind}-${nextId++}`,
    });

    const [first] = await Promise.all([
      peer.writeText("notes/a.md", "first"),
      peer.writeText("notes/a.md", "second"),
    ]);

    const operations = logOperations(relay.requests);
    expect(
      operations.map((operation) => operation.originSeq),
      "a helper-owned origin must never skip or reuse a coordinate",
    ).toEqual([0, 1, 2]);
    expect(operations.map((operation) => operation.opKind)).toEqual([
      "workspace.init",
      "moment.append",
      "moment.append",
    ]);

    const firstPayload = operations[1]!.payload;
    expect(firstPayload).toMatchObject({
      objectId: first.objectId,
      objectCreatedAtMs: first.objectCreatedAtMs,
      path: "notes/a.md",
      payloadBeforeBlobSha256: null,
      payloadBeforePath: null,
      beforePresent: "null",
    });
    expect(firstPayload).not.toHaveProperty("beforeLatestMomentId");

    expect(
      operations[2]!.payload,
      "a rewrite must carry the complete prior head, not only its blob hash",
    ).toMatchObject({
      objectId: first.objectId,
      objectCreatedAtMs: first.objectCreatedAtMs,
      path: first.path,
      payloadBeforeBlobSha256: first.blobSha256,
      payloadBeforePath: first.path,
      beforePresent: "present",
      beforeObjectId: first.objectId,
      beforeVersionId: "main",
      beforePath: first.path,
      beforeBlobSha256: first.blobSha256,
      beforeUpdatedAtMs: first.updatedAtMs,
      beforeLatestMomentId: first.latestMomentId,
      beforeMetadata: first.metadata,
    });

    const firstHave = relay.requests.findIndex((request) =>
      request.url.endsWith("/blobs/have"),
    );
    const firstPut = relay.requests.findIndex(
      (request) => request.method === "PUT",
    );
    const firstMomentAppend = relay.requests.findIndex((request) => {
      if (!request.url.endsWith("/log")) return false;
      return String(request.body).includes('"opKind":"moment.append"');
    });
    expect(
      [firstHave, firstPut, firstMomentAppend],
      "the peer must inventory and upload content before it appends the referencing moment",
    ).toEqual([1, 2, 3]);
    const uploaded = relay.requests[firstPut]!;
    expect(uploaded.url).toContain(first.blobSha256);
    expect(Buffer.from(uploaded.body as ArrayBuffer).toString("utf8")).toBe("first");
  });
});
