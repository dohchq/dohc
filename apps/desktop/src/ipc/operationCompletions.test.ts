import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { registerOperations, type OperationBoundary, type OperationCompletions } from "./operationTable";

const table = {
  change: { capabilityId: "file.move", channel: "desktop:test-change", payload: z.object({ workspaceId: z.string() }), result: z.object({ ok: z.boolean() }), guard: "active-workspace", scope: "workspace", inactiveMessage: "Inactive" },
} as const;
type Event = { trusted: boolean };
function harness() {
  let invoke!: (event: Event, input: unknown) => Promise<unknown>;
  const completion = vi.fn();
  const handler = vi.fn(async () => ({ ok: true }));
  let current = true;
  const boundary: OperationBoundary<Event, unknown> = {
    handle: (_channel, listener) => { invoke = listener; },
    assertTrustedSender: event => { if (!event.trusted) throw Error("Untrusted"); },
    withActiveWorkspace: async (_event, _id, _message, work) => {
      if (!current) throw Error("Inactive");
      const result = await work({});
      if (!current) throw Error("Inactive");
      return result;
    },
  };
  const completions: OperationCompletions<typeof table, Event> = { change: completion };
  registerOperations(boundary, table, { change: handler }, completions);
  return { invoke: (input: unknown = { workspaceId: "workspace" }, trusted = true) => invoke({ trusted }, input), handler, completion, leave: () => { current = false; } };
}
describe("operation completions", () => {
  it("observes only the admitted, parsed success after the handler completes", async () => {
    const h = harness();
    const pending = Promise.withResolvers<{ ok: boolean }>();
    h.handler.mockReturnValue(pending.promise);
    const reply = h.invoke();
    expect(h.completion).not.toHaveBeenCalled();
    pending.resolve({ ok: true });
    await expect(reply).resolves.toEqual({ ok: true });
    expect(h.completion).toHaveBeenCalledExactlyOnceWith({ workspaceId: "workspace" }, { ok: true }, { trusted: true });
  });
  it("excludes rejected senders, payloads, handlers, results and stale workspaces", async () => {
    const h = harness();
    await expect(h.invoke(undefined, false)).rejects.toThrow("Untrusted");
    await expect(h.invoke({})).rejects.toThrow();
    h.handler.mockRejectedValueOnce(Error("Failure"));
    await expect(h.invoke()).rejects.toThrow("Failure");
    h.handler.mockResolvedValueOnce({ ok: "invalid" } as unknown as { ok: boolean });
    await expect(h.invoke()).rejects.toThrow();
    h.handler.mockImplementationOnce(async () => { h.leave(); return { ok: true }; });
    await expect(h.invoke()).rejects.toThrow("Inactive");
    expect(h.completion).not.toHaveBeenCalled();
  });
  it("does not fail an operation when measurement fails", async () => {
    const h = harness();
    h.completion.mockImplementation(() => { throw Error("Measurement failed"); });
    await expect(h.invoke()).resolves.toEqual({ ok: true });
  });
});
