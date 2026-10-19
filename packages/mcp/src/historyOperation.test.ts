import { expect, it, vi } from "vitest";
import { readOperation, undoOperation, type ToolContext } from "./tools";
import { advertisedCapabilityTools } from "./capabilityExposure.fixture";
const operationId = "dohc-operation:11111111-1111-4111-8111-111111111111";
it("passes a successful move Undo and pending-copy result through as data", async () => {
  const pending = { ok: true, tracked: { state: "restoring", momentCount: 1 }, restored: [], remaining: [{ path: "a.txt", reason: "a.txt now occupies the old path.", retry: true }] };
  const request = vi.fn(async () => pending);
  const ctx: ToolContext = { root: process.cwd(), home: process.cwd(), request };
  expect(await undoOperation(ctx, { operationId }, "Agent A")).toEqual(pending);
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ verb: "historyUndo", args: expect.objectContaining({ actor: "agent", operationId, agent: "Agent A" }) }));
  const restored = { ok: true, tracked: { state: "restored", momentCount: 1 }, restored: [], remaining: [] };
  request.mockResolvedValueOnce(restored as never);
  expect(await undoOperation(ctx, { operationId })).toEqual(restored);
});
it("keeps both operation tools owner-only and rejects invalid ids before transport", async () => {
  const request = vi.fn(); const ctx: ToolContext = { root: process.cwd(), home: process.cwd(), request };
  for (const shareAccess of ["view", "comment", "edit"] as const) {
    const names = (await advertisedCapabilityTools(shareAccess)).map(tool => tool.name);
    for (const tool of ["dohc_read_operation", "dohc_undo_operation"]) expect(names).not.toContain(tool);
    expect(await readOperation({ ...ctx, shareAccess }, { operationId })).toMatchObject({ ok: false });
    expect(await undoOperation({ ...ctx, shareAccess }, { operationId })).toMatchObject({ ok: false });
  }
  expect(await readOperation(ctx, { operationId: operationId.slice(15) })).toMatchObject({ ok: false });
  expect(await undoOperation(ctx, { operationId: operationId.slice(15) })).toMatchObject({ ok: false });
  expect(request).not.toHaveBeenCalled();
});
