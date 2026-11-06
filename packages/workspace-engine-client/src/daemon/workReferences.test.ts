import { describe, expect, it } from "vitest";
import type { JsonValue } from "../protocol";
import { VersionedLiveAdapter } from "../versioned/versionedLiveAdapter";
import { decodeMadeWorkReference, decodeWorkReferenceResolution } from "./workReferences";

const REFERENCE = "A".repeat(42) + "_";

function adapter(result: JsonValue) {
  const requests: { method: string; params: unknown; workspace: unknown }[] = [];
  const live = new VersionedLiveAdapter(
    {
      close() {},
      async sendRequest(request) {
        requests.push({ method: request.method, params: request.params, workspace: request.workspace });
        return { id: request.id, result };
      },
    },
    "ws",
    { workspaceId: "ws" },
  );
  return { live, requests };
}

describe("work references", () => {
  it("makes a reference for a target in the adapter's workspace", async () => {
    const { live, requests } = adapter({ reference: REFERENCE, created: true });
    const target = { kind: "file", path: "notes/plan.md" } as const;
    expect(await live.makeWorkReference({ workspaceId: "ws", target })).toEqual({ reference: REFERENCE, created: true });
    expect(requests).toEqual([{ method: "workReferences.make", params: { target }, workspace: "ws" }]);
    await expect(live.makeWorkReference({ workspaceId: "foreign", target })).rejects.toThrow();
    await expect(live.makeWorkReference({ workspaceId: "ws", target, signal: AbortSignal.abort() })).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });

  it("resolves a reference to its target, state, and current path", async () => {
    const found = {
      status: "found",
      reference: REFERENCE,
      target: { kind: "message", messageId: "m", threadId: "t", channelId: null },
      state: "deleted",
      createdAtMs: 5,
      registration: "pending",
    };
    const { live, requests } = adapter(found);
    expect(await live.resolveWorkReference({ workspaceId: "ws", reference: REFERENCE })).toEqual(found);
    expect(requests.map(request => [request.method, request.params])).toEqual([["workReferences.resolve", { reference: REFERENCE }]]);
    await expect(live.resolveWorkReference({ workspaceId: "ws", reference: "B".repeat(43) })).rejects.toThrow("different reference");
    expect(await adapter({ status: "unknown" }).live.resolveWorkReference({ workspaceId: "ws", reference: "x" })).toEqual({ status: "unknown" });
  });

  it("keeps a transactional record id's type and decodes every target kind", () => {
    const resolution = (target: unknown, extra: object = {}) => ({
      status: "found",
      reference: REFERENCE,
      target,
      state: "live",
      createdAtMs: 1,
      registration: "registered",
      ...extra,
    });
    for (const target of [
      { kind: "file", versionId: "main", objectId: "o" },
      { kind: "app", versionId: "main", objectId: "o" },
      { kind: "documentCollection", versionId: "main", objectId: "schema" },
      { kind: "documentRecord", versionId: "main", recordId: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa" },
      { kind: "transactionalCollection", datasetId: "d", tableId: "t" },
      { kind: "transactionalRecord", datasetId: "d", tableId: "t", recordId: 7 },
      { kind: "transactionalRecord", datasetId: "d", tableId: "t", recordId: "7" },
    ]) {
      expect(decodeWorkReferenceResolution(resolution(target, { path: "a.md" }))).toEqual(resolution(target, { path: "a.md" }));
    }
  });

  it("rejects malformed engine results", async () => {
    for (const made of [{ reference: "short", created: true }, { reference: REFERENCE + "=", created: true }, { reference: REFERENCE }, { reference: REFERENCE, created: "yes" }]) {
      expect(() => decodeMadeWorkReference(made)).toThrow();
    }
    const valid = { status: "found", reference: REFERENCE, target: { kind: "file", versionId: "main", objectId: "o" }, state: "live", createdAtMs: 1, registration: "pending" };
    for (const broken of [
      { ...valid, status: "missing" },
      { ...valid, state: "gone" },
      { ...valid, registration: "sent" },
      { ...valid, path: "" },
      { ...valid, createdAtMs: 1.5 },
      { ...valid, target: { kind: "folder", versionId: "main", objectId: "o" } },
      { ...valid, target: { kind: "file", objectId: "o" } },
      { ...valid, target: { kind: "message", messageId: "m", channelId: null } },
      { ...valid, target: { kind: "transactionalRecord", datasetId: "d", tableId: "t", recordId: 1.5 } },
    ]) {
      expect(() => decodeWorkReferenceResolution(broken), JSON.stringify(broken)).toThrow();
    }
    await expect(adapter({ reference: "short", created: true }).live.makeWorkReference({ workspaceId: "ws", target: { kind: "message", messageId: "m" } })).rejects.toThrow();
  });
});
