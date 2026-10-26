import { expect, it, vi } from "vitest";
import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { flushDatasetSourceCapture } from "./datasetSourceCapture";

const held = { workspaceId: "ws", sourceVersionId: "main", objectId: "object", path: "sources/note.md",
  observedSha256: "digest", observedSize: 4, reason: "ydoc-resolution-not-representable" as const,
  observedAtMs: 1, attemptCount: 1, retryRequested: false };
function fixture() {
  const result: Awaited<ReturnType<VersionedLiveAdapter["flushCapture"]>> = { running: true, settled: true, degraded: false, heldFiles: [held], deferredWrites: [] };
  return { result, adapter: { reconcileCapture: vi.fn(async () => result), flushCapture: vi.fn(async () => result) }, signal: new AbortController().signal };
}

it("returns holds for review to check only the paths it reads", async () => {
  const f = fixture();
  await expect(flushDatasetSourceCapture(f.adapter, f.signal)).resolves.toMatchObject({ heldFiles: [held], deferredWrites: [] });
});

it("refuses a just-written source held by the final flush", async () => {
  const f = fixture();
  f.adapter.reconcileCapture.mockResolvedValueOnce({ ...f.result, settled: false, heldFiles: [] });
  await expect(flushDatasetSourceCapture(f.adapter, f.signal, [held.path])).rejects.toThrow(held.path);
  expect(f.adapter.flushCapture).toHaveBeenCalledOnce();
});

it("allows written source when only another file is held", async () => {
  const f = fixture();
  await flushDatasetSourceCapture(f.adapter, f.signal, ["sources/schema.sql"]);
});

it("keeps degraded capture and cancellation as failures", async () => {
  const f = fixture();
  f.result.degraded = true;
  await expect(flushDatasetSourceCapture(f.adapter, f.signal, [])).rejects.toThrow("could not capture");
  const abort = new AbortController(); abort.abort(Error("cancelled"));
  await expect(flushDatasetSourceCapture(f.adapter, abort.signal)).rejects.toThrow("cancelled");
});

it.each([true, false])("refuses a requested outside write waiting after reconcile or flush (%s)", async (settled) => {
  const f = fixture();
  Object.assign(f.result, { deferredWrites: ["sources/waiting.md"] });
  f.adapter.reconcileCapture.mockResolvedValueOnce({ ...f.result, settled });
  await expect(flushDatasetSourceCapture(f.adapter, f.signal, ["sources/waiting.md"]))
    .rejects.toThrow("sources/waiting.md");
});
