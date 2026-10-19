import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { createShareHandoffIpcHandlers } from "./shareHandoffIpc";
import { shareHandoffOperations } from "./shareOperations";
import { registerOperations } from "./operationTable";
import type { ShareHandoffStatus } from "./bridgeContract";

function harness() {
  const handlers = new Map<string, (event: { trusted: boolean }, payload: unknown) => Promise<unknown>>();
  const coordinator = {
    status: vi.fn<() => ShareHandoffStatus>(() => ({ status: "waiting-for-acceptance", statusId: "current", email: "member@example.test" })),
    accept: vi.fn(), retry: vi.fn(), dismiss: vi.fn(),
  };
  registerOperations({
    handle: (channel, handler) => { expect(handlers.has(channel)).toBe(false); handlers.set(channel, handler); },
    assertTrustedSender: (event: { trusted: boolean }) => { if (!event.trusted) throw new Error("untrusted"); },
    withActiveWorkspace: vi.fn(async () => { throw new Error("Unexpected workspace operation."); }),
  }, shareHandoffOperations, createShareHandoffIpcHandlers({ shareHandoffRedemption: coordinator }));
  const invoke = (channel: string, trusted: boolean, payload?: unknown) => handlers.get(channel)!({ trusted }, payload);
  return { handlers, coordinator, invoke };
}

describe("registered share handoff handlers", () => {
  it("registers the original sequence and gates every action before parsing", async () => {
    const h = harness();
    expect([...h.handlers.keys()]).toEqual([
      shareHandoffOperations.getShareHandoffStatus.channel, shareHandoffOperations.acceptShareHandoff.channel,
      shareHandoffOperations.retryShareHandoff.channel, shareHandoffOperations.dismissShareHandoff.channel,
    ]);
    for (const channel of h.handlers.keys()) await expect(h.invoke(channel, false, null)).rejects.toThrow("untrusted");
    for (const method of Object.values(h.coordinator)) expect(method).not.toHaveBeenCalled();
  });

  it("returns the coordinator status and passes only a validated status identity", async () => {
    const h = harness();
    expect(await h.invoke(shareHandoffOperations.getShareHandoffStatus.channel, true)).toEqual(h.coordinator.status());
    await h.invoke(shareHandoffOperations.acceptShareHandoff.channel, true, { statusId: "current" });
    await h.invoke(shareHandoffOperations.dismissShareHandoff.channel, true, { statusId: "current" });
    await h.invoke(shareHandoffOperations.retryShareHandoff.channel, true);
    expect(h.coordinator.accept).toHaveBeenCalledWith("current");
    expect(h.coordinator.dismiss).toHaveBeenCalledWith("current");
    expect(h.coordinator.retry).toHaveBeenCalledOnce();
  });

  it("rejects malformed or missing payloads before reaching the coordinator", async () => {
    const h = harness();
    for (const channel of [shareHandoffOperations.getShareHandoffStatus.channel, shareHandoffOperations.retryShareHandoff.channel]) {
      await expect(h.invoke(channel, true, "dohc://open?forged")).rejects.toThrow(ZodError);
    }
    for (const channel of [shareHandoffOperations.acceptShareHandoff.channel, shareHandoffOperations.dismissShareHandoff.channel]) {
      await expect(h.invoke(channel, true)).rejects.toThrow(ZodError);
      await expect(h.invoke(channel, true, { url: "dohc://open?forged" })).rejects.toThrow(ZodError);
      await expect(h.invoke(channel, true, { statusId: "" })).rejects.toThrow(ZodError);
    }
    for (const method of Object.values(h.coordinator)) expect(method).not.toHaveBeenCalled();
  });
});
