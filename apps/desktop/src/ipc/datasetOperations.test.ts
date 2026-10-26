import type { DatasetResult } from "@dohc/cli/dataset";
import { expect, it, vi } from "vitest";
import { createDatasetHandler } from "./datasetIpc";
import { datasetOperations } from "./datasetOperations";
import { operationBridge, registerOperations, type OperationBoundary } from "./operationTable";

function fixture() {
  const listeners = new Map<string, (event: { sender: string }, payload: unknown) => Promise<unknown>>();
  const handler = vi.fn(async (): Promise<Extract<DatasetResult, { kind: "list" }>> => ({ kind: "list", datasets: [], nextCursor: null }));
  const boundary = {
    handle(channel, listener) { listeners.set(channel, listener); },
    assertTrustedSender(event) { if (event.sender === "untrusted") throw new Error("Untrusted IPC sender."); },
    withActiveWorkspace: vi.fn(async () => { throw new Error("Unexpected outer workspace operation."); }),
  } satisfies OperationBoundary<{ sender: string }, never>;
  const keep = vi.fn(async () => ({ kept: true }));
  registerOperations(boundary, datasetOperations, { dataset: handler, keepCollectionsHere: keep });
  const invoke = (event: { sender: string }, payload: unknown) => listeners.get(datasetOperations.dataset.channel)!(event, payload);
  const keepHere = (event: { sender: string }, payload: unknown) => listeners.get(datasetOperations.keepCollectionsHere.channel)!(event, payload);
  return { handler, keep, boundary, invoke, keepHere };
}

it("refuses an untrusted sender before parsing or calling the dataset handler", async () => {
  const f = fixture();
  for (const payload of [null, { action: "list", workspaceId: "workspace" }]) {
    await expect(f.invoke({ sender: "untrusted" }, payload)).rejects.toThrow("Untrusted IPC sender.");
  }
  expect(f.handler).not.toHaveBeenCalled();
  expect(f.boundary.withActiveWorkspace).not.toHaveBeenCalled();
});

it("forwards the parsed request and original sender without an outer workspace operation", async () => {
  const f = fixture();
  const event = { sender: "window" };
  const request = { action: "list", workspaceId: "workspace" };
  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    expect(channel).toBe("desktop:dataset");
    return f.invoke(event, payload);
  });
  const bridge = operationBridge(datasetOperations, invoke);
  await expect(bridge.dataset({ action: "list", workspaceId: "workspace" }))
    .resolves.toEqual({ kind: "list", datasets: [], nextCursor: null });
  expect(invoke).toHaveBeenCalledWith("desktop:dataset", request);
  expect(f.handler).toHaveBeenCalledWith(request, { event });
  expect(f.boundary.withActiveWorkspace).not.toHaveBeenCalled();
});

it("validates dataset payloads before the handler and results before replying", async () => {
  const f = fixture();
  await expect(f.invoke({ sender: "window" }, { action: "missing", workspaceId: "workspace" })).rejects.toThrow();
  expect(f.handler).not.toHaveBeenCalled();
  f.handler.mockResolvedValue({ kind: "list", datasets: [], nextCursor: "" });
  await expect(f.invoke({ sender: "window" }, { action: "list", workspaceId: "workspace" })).rejects.toThrow();
});

it("keeps workspace refusal inside the existing dataset handler", async () => {
  const f = fixture();
  const refusal = "Collection changes stopped because this window changed workspaces.";
  const withWorkspaceOperation = vi.fn(async (_caller: string, _workspaceId: string, _work: unknown): Promise<never> => { throw new Error(refusal); });
  const hostForWorkspace = vi.fn(async () => { throw new Error("Unexpected dataset host."); });
  const handler = createDatasetHandler({
    withWorkspaceOperation, hostForWorkspace,
    flushSourceCapture: async () => ({ heldFiles: [], deferredWrites: [] }),
    withAdapter: async () => { throw new Error("Unexpected source adapter."); },
    createSources: async () => {},
  });
  registerOperations(f.boundary, datasetOperations, {
    dataset: (request, { event }) => handler(event.sender, request),
    keepCollectionsHere: f.keep,
  });
  await expect(f.invoke({ sender: "window" }, { action: "list", workspaceId: "elsewhere" }))
    .rejects.toThrow(refusal);
  expect(withWorkspaceOperation).toHaveBeenCalledOnce();
  const [caller, workspaceId, work] = withWorkspaceOperation.mock.calls[0]!;
  expect([caller, workspaceId]).toEqual(["window", "elsewhere"]);
  expect(work).toBeTypeOf("function");
  expect(hostForWorkspace).not.toHaveBeenCalled();
  expect(f.boundary.withActiveWorkspace).not.toHaveBeenCalled();
});

it("keeps a workspace's Collections here only inside the sender's open workspace", async () => {
  const f = fixture();
  await expect(f.keepHere({ sender: "untrusted" }, { workspaceId: "workspace" })).rejects.toThrow("Untrusted IPC sender.");
  await expect(f.keepHere({ sender: "window" }, { workspaceId: "workspace" })).rejects.toThrow("Unexpected outer workspace operation.");
  expect(f.boundary.withActiveWorkspace).toHaveBeenCalledWith({ sender: "window" }, "workspace",
    "Open this workspace to keep its Collections on this computer.", expect.any(Function));
  expect(f.keep).not.toHaveBeenCalled();
});
