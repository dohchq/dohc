import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { createRemoteDatasetData, resolveRemoteDatasetRevision } from "./remoteDataset";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const definition: DatasetDefinition = { formatVersion: 1, datasetId: id(1), name: "Responses", schemaPath: "private/schema.sql", operationsPath: "private/actions.js",
  tables: [{ tableId: id(2), name: "Responses", sqlName: "responses", primaryKey: "id", fields: [
    { fieldId: id(3), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
  ] }], operations: [{ operationId: id(4), name: "list", label: "List", tableId: id(2), kind: "read", access: "owner", readOnly: true, fieldIds: [id(3)] }] };
const revision = describeDatasetRevision({ definition, revision: 1, schemaSql: "SQL", operationSource: "RULES" });
const approved = { revision, schemaSql: "SQL", operationSource: "RULES", active: true,
  cursor: { workspaceId: "workspace", datasetId: id(1), hostEpoch: "epoch", approvedRevisionHash: revision.revisionSha256, revision: 0, digest: "0".repeat(64) } };
const description = { datasetId: id(1), name: "Responses", revision: 1, revisionSha256: revision.revisionSha256,
  tables: definition.tables.map(table => ({ tableId: table.tableId, name: table.name, fields: table.fields.map(({ sqlColumn: _, ...field }) => field) })), operations: definition.operations };
const invocation = { datasetId: id(1), revision: 1, revisionSha256: revision.revisionSha256, operationId: id(4), input: {}, idempotencyKey: "retry" };
function fixture() {
  const credentials = { serverUrl: "https://account.example", relayUrl: "https://relay.example", userId: "owner", token: "test-only", email: "owner@example.test" };
  const controller = new AbortController();
  let generation = 1, current = true;
  const relay = vi.fn(async (_auth: typeof credentials, path: string, _init: RequestInit): Promise<unknown> => {
    if (path.endsWith("/artifacts")) return structuredClone(approved);
    if (path.endsWith("/invoke")) return { result: [], revision: 3, replayed: false };
    if (path.endsWith(id(1))) return description;
    return { datasets: [description], nextCursor: null };
  });
  const data = createRemoteDatasetData({ workspaceId: "workspace", credentials, credentialGeneration: generation, signal: controller.signal,
    currentCredentialGeneration: () => generation, assertCurrent() { if (!current) throw Error("workspace changed"); }, relayJson: relay });
  return { data, relay, controller, switchCredential() { generation++; }, switchWorkspace() { current = false; } };
}

describe("remote Collection authority", () => {
  it("reads approved artifacts and invokes exactly the requested revision without local fallback", async () => {
    const f = fixture();
    expect(await f.data.list({ limit: 10 })).toEqual({ datasets: [description], nextCursor: null });
    expect(f.relay.mock.calls[0]![1]).toBe("/sync/workspace/datasets?limit=10");
    expect(await f.data.describe(id(1))).toEqual(description);
    expect(await resolveRemoteDatasetRevision(f.data, { kind: "dataset", ...invocation, operationIds: [id(4)] })).toEqual(revision);
    expect(await f.data.invoke(invocation)).toEqual({ result: [], revision: 3, replayed: false });
    expect(JSON.parse(String(f.relay.mock.calls.at(-1)![2].body))).toEqual({ revision: 1, revisionSha256: revision.revisionSha256, operationId: id(4), input: {}, idempotencyKey: "retry" });
  });
  it.each(["credential", "workspace", "abort"])('refuses a late response after %s changes', async kind => {
    const f = fixture();
    f.relay.mockImplementation(async () => {
      if (kind === "credential") f.switchCredential();
      if (kind === "workspace") f.switchWorkspace();
      if (kind === "abort") f.controller.abort();
      return { result: [], revision: 3, replayed: false };
    });
    await expect(f.data.invoke(invocation)).rejects.toThrow();
  });
  it.each(["dataset", "workspace", "hash", "source"])('refuses %s artifact mismatch', async kind => {
    const f = fixture(), forged = structuredClone(approved);
    if (kind === "dataset") forged.cursor.datasetId = id(9);
    if (kind === "workspace") forged.cursor.workspaceId = "different";
    if (kind === "hash") forged.cursor.approvedRevisionHash = "1".repeat(64);
    if (kind === "source") forged.operationSource = "NEW RULES";
    f.relay.mockResolvedValue(forged);
    await expect(f.data.approvedArtifacts(id(1))).rejects.toThrow();
  });
  it("rejects mismatched descriptions and nonadvancing catalog cursors", async () => {
    const f = fixture();
    f.relay.mockResolvedValue({ ...description, datasetId: id(9) });
    await expect(f.data.describe(id(1))).rejects.toThrow(/different/);
    f.relay.mockResolvedValue({ datasets: [description], nextCursor: id(9) });
    await expect(f.data.list({})).rejects.toThrow(/list changed/);
  });
  it("preserves offline failure and refuses an unapproved or changed remote revision", async () => {
    const f = fixture();
    f.relay.mockRejectedValueOnce(Error("offline"));
    await expect(f.data.invoke(invocation)).rejects.toThrow("offline");
    f.relay.mockResolvedValue({ ...approved, active: false });
    await expect(resolveRemoteDatasetRevision(f.data, { kind: "dataset", ...invocation, operationIds: [id(4)] })).rejects.toThrow(/rules changed/);
  });
  it("uploads and retrieves owner files through the same remote authority and verifies returned bytes", async () => {
    const f = fixture(), bytes = Buffer.from("receipt");
    const file = { fileId: "a".repeat(32), name: "receipt.png", contentType: "image/png", byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    f.relay.mockResolvedValueOnce({ file, replayed: false });
    expect(await f.data.upload({ action: "upload", workspaceId: "workspace", ...invocation, fieldId: id(3), name: file.name, contentType: file.contentType, bytesBase64: bytes.toString("base64") })).toEqual({ file, replayed: false });
    expect(f.relay.mock.calls.at(-1)![1]).toMatch(/\/upload$/);
    f.relay.mockResolvedValueOnce({ file, bytesBase64: bytes.toString("base64") });
    expect(await f.data.file({ action: "file", workspaceId: "workspace", ...invocation, fileId: file.fileId })).toEqual({ file, bytesBase64: bytes.toString("base64") });
    f.relay.mockResolvedValueOnce({ file, bytesBase64: Buffer.from("wrong").toString("base64") });
    await expect(f.data.file({ action: "file", workspaceId: "workspace", ...invocation, fileId: file.fileId })).rejects.toThrow(/different Collection file/);
  });
});
