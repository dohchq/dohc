import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppPublicationCandidate } from "@dohc/security-contract/app-publication";
import { prepareLocalAppPublication } from "../workspaces/ownerAppPublication";
import { createLocalOwnerAppPublicationHandler } from "./localOwnerAppPublication";

vi.mock("../workspaces/ownerAppPublication", () => ({ prepareLocalAppPublication: vi.fn() }));
const hash = "a".repeat(64);
const capability = { kind: "app-backend" as const, dataPath: "data.sqlite", backendPath: "backend.js", schemaPath: "schema.sql", backendSha256: hash, schemaSha256: hash,
  schemaVersion: 1, operations: [{ name: "list", access: "owner" as const, readOnly: true }], tables: [] };
const candidate: AppPublicationCandidate = { appRoot: "app", entryPath: "app/main.ts", packageMap: {}, versionId: "main", sourceRevision: hash, sourceDigest: hash,
  dependencyLockDigest: hash, bundleDigest: hash, buildDigest: hash, compilerIdentity: { recipe: "test", version: "test", binarySha256: hash },
  inputs: [{ path: "app/main.ts", sha256: hash, byteLength: 1 }], dependencies: ["app/main.ts"], files: [], capabilities: [capability] };
function harness() {
  const controller = new AbortController();
  const workspace = { workspaceId: "w" };
  const operation = { workspace, signal: controller.signal, scope: "session-1", assertCurrent: vi.fn() };
  const activate = vi.fn(async () => ({ publicationId: hash, authorityRevision: 1, capability, active: true, revision: 1 }));
  const local = { activate, list: vi.fn(() => [{ publicationId: hash, authorityRevision: 1, appRoot: "app", sourceRevision: hash, backendCapability: capability, sharedPublicationId: null, capability, active: true, revision: 1 }]) };
  const localForWorkspace = vi.fn(async () => local);
  const handler = createLocalOwnerAppPublicationHandler({ localForWorkspace,
    flushCapture: vi.fn(async () => {}), withAdapter: async (_workspace, work) => work({} as never), compile: vi.fn() });
  vi.mocked(prepareLocalAppPublication).mockResolvedValue({ candidate, files: [] });
  const prepare = async () => {
    const result = await handler({ action: "prepareLocal", workspaceId: "w", appRoot: "app" }, "caller", operation);
    if (result?.kind !== "prepared") throw new Error("Expected preparation.");
    return result;
  };
  return { controller, operation, activate, localForWorkspace, handler, prepare };
}
afterEach(() => vi.clearAllMocks());
describe("local app publication review", () => {
  it("captures before approval and activates the captured bundle without remote credentials", async () => {
    const h = harness(); const review = await h.prepare();
    expect(review.local).toBe(true); expect(h.activate).not.toHaveBeenCalled();
    expect(await h.handler({ action: "approve", workspaceId: "w", approvalId: review.approvalId, candidateDigest: review.candidateDigest }, "caller", h.operation))
      .toEqual({ kind: "published", publicationId: hash, authorityRevision: 1, local: true });
    expect(h.activate).toHaveBeenCalledWith({ candidate, files: [] }, h.controller.signal, { initialize: true });
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
  it("lists local apps without share identities and allows cancellation", async () => {
    const h = harness();
    expect(await h.handler({ action: "listLocal", workspaceId: "w", appRoot: "app" }, "caller", h.operation)).toEqual({ kind: "localListed", publications: [{ publicationId: hash,
      authorityRevision: 1, appRoot: "app", sourceRevision: hash, backendCapability: capability, active: true }] });
    const review = await h.prepare();
    expect(await h.handler({ action: "cancel", workspaceId: "w", approvalId: review.approvalId }, "caller", h.operation)).toEqual({ kind: "cancelled" });
    expect(h.activate).not.toHaveBeenCalled();
  });
});
