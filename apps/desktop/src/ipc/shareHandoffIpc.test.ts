import { describe, expect, it, vi } from "vitest";
import { registerShareHandoffIpcHandlers } from "./shareHandoffIpc";
import { CHANNELS } from "./channels";
import type { ShareHandoffStatus } from "./bridgeContract";

function harness() {
  const handlers = new Map<string, (event: { trusted: boolean }, ...args: unknown[]) => unknown>();
  const coordinator = {
    status: vi.fn<() => ShareHandoffStatus>(() => ({ status: "waiting-for-acceptance", statusId: "current", email: "member@example.test" })),
    accept: vi.fn(), retry: vi.fn(), dismiss: vi.fn(),
  };
  registerShareHandoffIpcHandlers({
    registerHandler: (channel, handler) => { expect(handlers.has(channel)).toBe(false); handlers.set(channel, handler); },
    assertTrustedSender: (event: { trusted: boolean }) => { if (!event.trusted) throw new Error("untrusted"); },
    shareHandoffRedemption: coordinator,
  });
  const invoke = (channel: string, trusted: boolean, ...args: unknown[]) => handlers.get(channel)!({ trusted }, ...args);
  return { handlers, coordinator, invoke };
}

describe("registered share handoff handlers", () => {
  it("registers the original sequence and gates every action before parsing", () => {
    const h = harness();
    expect([...h.handlers.keys()]).toEqual([
      CHANNELS.getShareHandoffStatus, CHANNELS.acceptShareHandoff,
      CHANNELS.retryShareHandoff, CHANNELS.dismissShareHandoff,
    ]);
    for (const channel of h.handlers.keys()) expect(() => h.invoke(channel, false, null)).toThrow("untrusted");
    for (const method of Object.values(h.coordinator)) expect(method).not.toHaveBeenCalled();
  });

  it("returns the coordinator status and passes only a validated status identity", () => {
    const h = harness();
    expect(h.invoke(CHANNELS.getShareHandoffStatus, true)).toEqual(h.coordinator.status());
    h.invoke(CHANNELS.acceptShareHandoff, true, { statusId: "current" });
    h.invoke(CHANNELS.dismissShareHandoff, true, { statusId: "current" });
    h.invoke(CHANNELS.retryShareHandoff, true);
    expect(h.coordinator.accept).toHaveBeenCalledWith("current");
    expect(h.coordinator.dismiss).toHaveBeenCalledWith("current");
    expect(h.coordinator.retry).toHaveBeenCalledOnce();
  });

  it("rejects renderer-supplied links and extra arguments before reaching the coordinator", () => {
    const h = harness();
    for (const channel of [CHANNELS.getShareHandoffStatus, CHANNELS.retryShareHandoff]) {
      expect(() => h.invoke(channel, true, "dohc://share/forged")).toThrow("do not accept arguments");
    }
    for (const channel of [CHANNELS.acceptShareHandoff, CHANNELS.dismissShareHandoff]) {
      expect(() => h.invoke(channel, true)).toThrow("requires one status identity");
      expect(() => h.invoke(channel, true, { statusId: "current" }, "extra")).toThrow("requires one status identity");
      expect(() => h.invoke(channel, true, { url: "dohc://share/forged" })).toThrow();
    }
    for (const method of Object.values(h.coordinator)) expect(method).not.toHaveBeenCalled();
  });
});
