import { describe, expect, it, vi } from "vitest";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { AUTOMATION_SERVER_INSTALL_ID } from "@dohc/workspace-contracts/relay";
import { readServerDataset, serverRunsOfAnswer } from "./serverDataset";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const definition: DatasetDefinition = { formatVersion: 1, datasetId: id(1), name: "Registrations", schemaPath: "registrations/schema.sql", operationsPath: "registrations/operations.js",
  tables: [{ tableId: id(2), name: "Registrations", sqlName: "registrations", primaryKey: "id", fields: [
    { fieldId: id(3), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
  ] }], operations: [{ operationId: id(4), name: "read", label: "Read", tableId: id(2), kind: "read", access: "owner", readOnly: true, fieldIds: [id(3)] }] };
const revision = describeDatasetRevision({ definition, revision: 1, schemaSql: "SQL", operationSource: "RULES" });
const cursor = { workspaceId: "workspace", datasetId: id(1), hostEpoch: "epoch", approvedRevisionHash: revision.revisionSha256, revision: 0, digest: "0".repeat(64) };
const server = { installId: AUTOMATION_SERVER_INSTALL_ID, kind: "server", label: "dohc server", lastSeenMs: 1 };
const laptop = { installId: "install-laptop", kind: "computer", label: "Laptop", lastSeenMs: 1 };
const hostState = (installId: string | null, computers: unknown[], handoverFrom: string | null = null) => ({ status: 200, body: { ok: true,
  host: installId === null ? null : { installId, generation: 3, handoverFrom, releasedThroughMs: null }, computers } });

describe("what the server runs, from the owner's automation host read", () => {
  it("says the server runs everything only while it runs automations and Schedules run on names it", () => {
    expect(serverRunsOfAnswer(hostState(AUTOMATION_SERVER_INSTALL_ID, [server, laptop]))).toBe("all");
    expect(serverRunsOfAnswer(hostState("install-laptop", [server, laptop]))).toBe("no-schedules");
    expect(serverRunsOfAnswer(hostState(null, [server]))).toBe("no-schedules");
    // Still handing over to the server: the server has not started its schedules.
    expect(serverRunsOfAnswer(hostState(AUTOMATION_SERVER_INSTALL_ID, [server, laptop], "install-laptop"))).toBe("no-schedules");
    // The relay lists the server only while it runs automations.
    expect(serverRunsOfAnswer(hostState(AUTOMATION_SERVER_INSTALL_ID, [laptop]))).toBe("off");
    expect(serverRunsOfAnswer({ status: 404, body: { ok: false } })).toBeNull();
    expect(serverRunsOfAnswer({ status: 200, body: { ok: true, host: null, computers: [{ kind: "server" }] } })).toBeNull();
  });
});

describe("a Collection on the server, as the panel reads it", () => {
  it("reads the server's rules, every page of its current data grants, and what the server runs", async () => {
    const pages = [
      { permissions: [
        { kind: "data" as const, principal: "editor", current: true, metadata: { operationIds: [id(4)], discover: true, revision: 1, revisionSha256: revision.revisionSha256 } },
        { kind: "data" as const, principal: "former", current: false, metadata: { operationIds: [id(4)], discover: true, revision: 1, revisionSha256: revision.revisionSha256 } },
      ], nextCursor: "next" },
      { permissions: [{ kind: "data" as const, principal: "viewer", current: true, metadata: { operationIds: [], discover: false, revision: 1, revisionSha256: revision.revisionSha256 } }], nextCursor: null },
    ];
    const permissions = vi.fn(async ({ after }: { after?: string }) => pages[after === "next" ? 1 : 0]!);
    const data = { approvedArtifacts: vi.fn(async () => ({ revision, schemaSql: "SQL", operationSource: "RULES", active: true, cursor })), permissions };
    expect(await readServerDataset("workspace", id(1), data, async () => hostState(AUTOMATION_SERVER_INSTALL_ID, [server]))).toEqual({
      approved: revision, generated: false, runs: "all",
      grants: { workspaceId: "workspace", grants: [{ principalKey: "editor", operationIds: [id(4)] }, { principalKey: "viewer", operationIds: [] }] },
    });
    expect(permissions.mock.calls.map(([page]) => page)).toEqual([
      { action: "permissions", workspaceId: "workspace", datasetId: id(1), limit: 100 },
      { action: "permissions", workspaceId: "workspace", datasetId: id(1), after: "next", limit: 100 },
    ]);
    // dohc cannot tell what the server runs when it cannot ask.
    expect(await readServerDataset("workspace", id(1), data, async () => { throw new Error("offline"); })).toMatchObject({ runs: null });
    // A Collection the server no longer runs, such as an archived one, is not shown as the server's.
    data.approvedArtifacts.mockResolvedValueOnce({ revision, schemaSql: "SQL", operationSource: "RULES", active: false, cursor });
    expect(await readServerDataset("workspace", id(1), data, async () => hostState(AUTOMATION_SERVER_INSTALL_ID, [server]))).toBeNull();
  });
});
