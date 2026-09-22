import { expect, it, vi } from "vitest";
import { createDatasetHandler } from "./datasetIpc";
import type { LocalDatasetHost } from "../workspaces/localDatasetHost";

const datasetId = "00000000-0000-4000-8000-000000000001";
function fixture() {
  const abort = new AbortController();
  const workspace = { workspaceId: "workspace", shareView: undefined as unknown };
  let current = true;
  const host = { list: vi.fn(() => ({ datasets: [], nextCursor: null })), invoke: vi.fn(async () => ({ result: [], revision: 1, replayed: false })) };
  const handler = createDatasetHandler({
    async withWorkspaceOperation(_caller: string, workspaceId, work) {
      if (workspaceId !== workspace.workspaceId) throw Error("wrong workspace");
      return work({ workspace, signal: abort.signal, assertCurrent() { if (!current) throw Error("stale workspace"); } });
    },
    hostForWorkspace: vi.fn(async () => host as unknown as LocalDatasetHost),
    withAdapter: vi.fn(), createSources: vi.fn(),
  });
  return { handler, host, workspace, abort, stale() { current = false; } };
}

it("uses owner authority before disclosing standalone Collections", async () => {
  const f = fixture();
  await expect(f.handler("window", { action: "list", workspaceId: "elsewhere" })).rejects.toThrow("wrong workspace");
  expect(f.host.list).not.toHaveBeenCalled();
  expect(await f.handler("window", { action: "list", workspaceId: "workspace" })).toEqual({ kind: "list", datasets: [], nextCursor: null });
});
it("refuses stale workspace results after an asynchronous invocation", async () => {
  const f = fixture();
  f.host.invoke.mockImplementation(async () => { f.stale(); return { result: [], revision: 1, replayed: false }; });
  await expect(f.handler("window", { action: "invoke", workspaceId: "workspace", datasetId,
    operationId: datasetId, revision: 1, revisionSha256: "a".repeat(64), input: {}, idempotencyKey: "retry" })).rejects.toThrow("stale workspace");
});
it("does not accept authority or raw SQL in an invocation", async () => {
  const f = fixture();
  await expect(f.handler("window", { action: "invoke", workspaceId: "workspace", datasetId,
    operationId: datasetId, revision: 1, revisionSha256: "a".repeat(64), input: {}, idempotencyKey: "retry", caller: { kind: "owner" } })).rejects.toThrow();
  expect(f.host.invoke).not.toHaveBeenCalled();
});
