import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppPublicationCandidate } from "@dohc/security-contract/app-publication";
import { prepareLocalAppPublication, readLocalAppSource } from "../workspaces/ownerAppPublication";
import { createLocalOwnerAppPublicationHandler } from "./localOwnerAppPublication";
import { createLocalDatasetHost, type LocalDatasetHost } from "../workspaces/localDatasetHost";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestScratch } from "../workspaces/testTemp";

vi.mock("../workspaces/ownerAppPublication", () => ({ prepareLocalAppPublication: vi.fn(), readLocalAppSource: vi.fn() }));
const hash = "a".repeat(64);
const capability = { kind: "dataset" as const, name: "Orders", datasetId: "00000000-0000-4000-8000-000000000001", revision: 1, revisionSha256: hash,
  operationIds: ["00000000-0000-4000-8000-000000000002"], operations: [{ operationId: "00000000-0000-4000-8000-000000000002", name: "list", access: "owner" as const, readOnly: true }] };
const candidate: AppPublicationCandidate = { appRoot: "app", entryPath: "app/main.ts", packageMap: {}, versionId: "main", sourceRevision: hash, sourceDigest: hash,
  dependencyLockDigest: hash, bundleDigest: hash, buildDigest: hash, compilerIdentity: { recipe: "test", version: "test", binarySha256: hash },
  inputs: [{ path: "app/main.ts", sha256: hash, byteLength: 1 }], dependencies: ["app/main.ts"], files: [], capabilities: [capability] };
function harness() {
  const controller = new AbortController();
  const workspace = { workspaceId: "w" };
  const operation = { workspace, signal: controller.signal, scope: "session-1", assertCurrent: vi.fn() };
  const activate = vi.fn(async () => ({ publicationId: hash, authorityRevision: 1, capability, active: true, revision: 1 }));
  const has = vi.fn((_publicationId: string) => true);
  const withdraw = vi.fn(async (publicationId: string, expected: number): Promise<{ kind: "withdrawn" | "withdrawalUnconfirmed"; publicationId: string; authorityRevision: number; unresolvedCreates?: number }> =>
    ({ kind: "withdrawn", publicationId, authorityRevision: expected + 1 }));
  const local = { approvedArtifacts: vi.fn(), apps: { activate, has, withdraw, list: vi.fn(() => [{ publicationId: hash, authorityRevision: 1, appRoot: "app", sourceRevision: hash, datasetCapability: capability, approved: true, active: true }]) } } as unknown as Pick<LocalDatasetHost, "approvedArtifacts" | "apps">;
  const datasetForWorkspace = vi.fn(async () => local);
  const launchLocalDataset = vi.fn(async () => "http://127.0.0.1:43211/bootstrap#handoff");
  const flushCapture = vi.fn(async () => ({ deferredWrites: ["app/draft.ts"] }));
  const handler = createLocalOwnerAppPublicationHandler({ datasetForWorkspace, launchLocalDataset,
    flushCapture, withAdapter: async (_workspace, work) => work({} as never), compile: vi.fn() });
  vi.mocked(prepareLocalAppPublication).mockResolvedValue({ candidate, files: [] });
  const prepare = async () => {
    const result = await handler({ action: "prepareLocal", workspaceId: "w", appRoot: "app" }, "caller", operation);
    if (result?.kind !== "prepared") throw new Error("Expected preparation.");
    return result;
  };
  return { controller, operation, activate, has, withdraw, datasetForWorkspace, flushCapture, launchLocalDataset, handler, prepare };
}
afterEach(() => vi.clearAllMocks());
describe("local app publication review", () => {
  it("forwards parsed agent approval provenance into local activation", async () => {
    const h = harness(), review = await h.prepare();
    const agent = { kind: "agent", label: "Builder", labelSource: "agent-declared" } as const;
    await h.handler({ action: "approve", workspaceId: "w", approvalId: review.approvalId, candidateDigest: review.candidateDigest }, "caller", h.operation, agent);
    expect(h.activate).toHaveBeenCalledWith({ candidate, files: [] }, h.controller.signal, agent);
  });
  it("captures before approval and activates the captured bundle without remote credentials", async () => {
    const h = harness(); const review = await h.prepare();
    expect(review.local).toBe(true); expect(h.activate).not.toHaveBeenCalled();
    expect(await h.handler({ action: "approve", workspaceId: "w", approvalId: review.approvalId, candidateDigest: review.candidateDigest }, "caller", h.operation))
      .toEqual({ kind: "published", publicationId: hash, authorityRevision: 1, local: true });
    expect(h.activate).toHaveBeenCalledWith({ candidate, files: [] }, h.controller.signal, null);
    expect(await h.handler({ action: "approve", workspaceId: "w", approvalId: review.approvalId, candidateDigest: review.candidateDigest }, "caller", h.operation)).toBeNull();
  });
  it.each(["digest", "caller", "session", "abort"])("refuses changed %s before local activation", async kind => {
    const h = harness(); const review = await h.prepare();
    if (kind === "session") h.operation.scope = "session-2";
    if (kind === "abort") h.controller.abort();
    await expect(h.handler({ action: "approve", workspaceId: "w", approvalId: review.approvalId, candidateDigest: kind === "digest" ? "b".repeat(64) : review.candidateDigest },
      kind === "caller" ? "other" : "caller", h.operation)).rejects.toThrow();
    expect(h.activate).not.toHaveBeenCalled(); h.controller.abort();
  });
  it("refuses local preparation without a governed Collection", async () => {
    const h = harness();
    vi.mocked(prepareLocalAppPublication).mockResolvedValue({ candidate: { ...candidate, capabilities: [] }, files: [] });
    await expect(h.prepare()).rejects.toThrow(/Connect this app to a Collection/);
    expect(h.activate).not.toHaveBeenCalled();
  });
  it("lists local apps without share identities and allows cancellation", async () => {
    const h = harness();
    expect(await h.handler({ action: "listLocal", workspaceId: "w", appRoot: "app" }, "caller", h.operation)).toEqual({ kind: "localListed", publications: [{ publicationId: hash,
      authorityRevision: 1, appRoot: "app", sourceRevision: hash, datasetCapability: capability, approved: true, active: true }] });
    const review = await h.prepare();
    expect(await h.handler({ action: "cancel", workspaceId: "w", approvalId: review.approvalId }, "caller", h.operation)).toEqual({ kind: "cancelled" });
    expect(h.activate).not.toHaveBeenCalled();
  });
  it("reads an app's current source revision after flushing waiting edits, without preparing it", async () => {
    const h = harness();
    vi.mocked(readLocalAppSource).mockResolvedValue({ sourceRevision: hash, sourcePaths: ["app/main.ts"], declaresCollection: false });
    expect(await h.handler({ action: "checkLocal", workspaceId: "w", appRoot: "app" }, "caller", h.operation))
      .toEqual({ kind: "localChecked", appRoot: "app", sourceRevision: hash, sourcePaths: ["app/main.ts"], declaresCollection: false });
    expect(h.flushCapture).toHaveBeenCalledWith(h.operation.workspace);
    expect(readLocalAppSource).toHaveBeenCalledWith({ action: "checkLocal", workspaceId: "w", appRoot: "app" },
      expect.objectContaining({ signal: h.controller.signal, deferredWrites: ["app/draft.ts"] }));
    expect(prepareLocalAppPublication).not.toHaveBeenCalled();
  });
  it.each(["shared-with-me/app", "../app", ".dohc/app"])("refuses to read the source of %s, which is outside the workspace's own files", async appRoot => {
    const h = harness();
    await expect(h.handler({ action: "checkLocal", workspaceId: "w", appRoot }, "caller", h.operation)).rejects.toThrow("Choose an app in your workspace.");
    await expect(h.handler({ action: "listLocal", workspaceId: "w", appRoot }, "caller", h.operation)).rejects.toThrow("Choose an app in your workspace.");
    expect(h.flushCapture).not.toHaveBeenCalled();
    expect(readLocalAppSource).not.toHaveBeenCalled();
  });
  it("refuses a source revision read after its operation ended", async () => {
    const h = harness();
    vi.mocked(readLocalAppSource).mockImplementation(async () => { h.controller.abort(); return { sourceRevision: hash, sourcePaths: ["app/main.ts"], declaresCollection: true }; });
    await expect(h.handler({ action: "checkLocal", workspaceId: "w", appRoot: "app" }, "caller", h.operation)).rejects.toThrow();
  });
  it("launches only a loopback approved publication and refuses a late result", async () => {
    const h = harness();
    const request = { action: "launchLocal" as const, workspaceId: "w", publicationId: hash };
    expect(await h.handler(request, "caller", h.operation)).toEqual({ kind: "localLaunched", publicationId: hash, url: "http://127.0.0.1:43211/bootstrap#handoff" });
    expect(h.launchLocalDataset).toHaveBeenCalledWith(h.operation.workspace, hash, h.controller.signal);
    h.launchLocalDataset.mockResolvedValueOnce("https://outside.example/app");
    await expect(h.handler(request, "caller", h.operation)).rejects.toThrow(/invalid address/);
    h.launchLocalDataset.mockImplementationOnce(async () => { h.controller.abort(); return "http://127.0.0.1:43211/bootstrap#handoff"; });
    await expect(h.handler(request, "caller", h.operation)).rejects.toThrow();
  });
  it("prepares and approves a document Collection app on this device", async () => {
    const h = harness();
    const collection = { kind: "collection-create" as const, collectionPath: "app/responses", schemaSha256: hash, allowedFields: ["destination"], requiredFields: ["destination"], readFields: [] };
    vi.mocked(prepareLocalAppPublication).mockResolvedValue({ candidate: { ...candidate, capabilities: [collection] }, files: [] });
    const review = await h.prepare();
    expect(review).toMatchObject({ local: true, capabilities: [collection] });
    await h.handler({ action: "approve", workspaceId: "w", approvalId: review.approvalId, candidateDigest: review.candidateDigest }, "caller", h.operation);
    expect(h.activate).toHaveBeenCalledWith({ candidate: { ...candidate, capabilities: [collection] }, files: [] }, h.controller.signal, null);
  });
  it("keeps an unconfirmed local withdrawal distinct and revokes only local apps here", async () => {
    const h = harness();
    const request = { workspaceId: "w", publicationId: hash, expectedAuthorityRevision: 3 };
    expect(await h.handler({ action: "revokeCollection", ...request }, "caller", h.operation)).toEqual({ kind: "collectionRevoked", publicationId: hash, authorityRevision: 4 });
    h.withdraw.mockResolvedValue({ kind: "withdrawalUnconfirmed", publicationId: hash, authorityRevision: 4, unresolvedCreates: 2 });
    for (const action of ["withdraw", "revokeCollection"] as const)
      expect(await h.handler({ action, ...request }, "caller", h.operation)).toEqual({ kind: "withdrawalUnconfirmed", publicationId: hash, authorityRevision: 4, unresolvedCreates: 2 });
    h.has.mockReturnValue(false);
    for (const action of ["withdraw", "revokeCollection"] as const) expect(await h.handler({ action, ...request }, "caller", h.operation)).toBeNull();
    expect(h.withdraw).toHaveBeenCalledTimes(3);
  });
});

describe("local apps in a workspace whose Collections another computer keeps", () => {
  it("lists, launches, approves and withdraws nothing, says which computer keeps them, and opens no store", async () => {
    const root = await createTestScratch("dohc-local-apps-holder-");
    await mkdir(join(root, ".dohc"));
    await writeFile(join(root, ".dohc", "collections.json"),
      JSON.stringify({ version: 1, workspaceId: "w", installId: "install-laptop", label: "Laptop", storeId: null }));
    const datasetForWorkspace = () => createLocalDatasetHost({ workspaceId: "w", workspaceRoot: root, localPersonId: () => "person-local",
      holder: { here: () => ({ installId: "install-here", label: "Studio" }), required: () => true } });
    const h = harness();
    h.datasetForWorkspace.mockImplementation(datasetForWorkspace as unknown as typeof h.datasetForWorkspace);
    const review = await h.prepare();
    const words = "These Collections are on Laptop. Open this workspace there to use them, or to move them to a server.";
    for (const request of [
      { action: "listLocal", workspaceId: "w", appRoot: "app" },
      { action: "launchLocal", workspaceId: "w", publicationId: hash },
      { action: "approve", workspaceId: "w", approvalId: review.approvalId, candidateDigest: review.candidateDigest },
      { action: "withdraw", workspaceId: "w", publicationId: hash, expectedAuthorityRevision: 1 },
      { action: "revokeCollection", workspaceId: "w", publicationId: hash, expectedAuthorityRevision: 1 },
    ] as const) await expect(h.handler(request, "caller", h.operation), request.action).rejects.toThrow(words);
    expect(h.activate).not.toHaveBeenCalled();
    expect(await readdir(join(root, ".dohc"))).toEqual(["collections.json"]);
  });
});
