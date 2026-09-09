import {expect, it, vi} from "vitest";
import {OwnerYDocOutbox} from "@dohc/workspace-engine-client";
import {parseHostEpoch} from "@dohc/live-session-contract/host-control";
import {OwnerYDocOutboxDrainer, type OwnerYDocDelivery} from "./ownerYDocOutbox";

function fixture(state: "active" | "sealed" | "quarantined") {
  const pending: Awaited<ReturnType<OwnerYDocOutbox["readHead"]>> = {
    outboxId: "outbox",binding: {workspaceId: "workspace",mainVersionId: "main",objectId: "object",
      lineageClaimId: "a".repeat(64),currentPath: "a.md",selectorPaths: ["a.md"],restoreFenceGeneration: 1},
    baseUpdate: new Uint8Array([0,0]),baseUpdateDigest: "a".repeat(64),state,
    pendingBytes: 20_000_000,oldestEntryAtMs: 0,quarantineReason: state === "quarantined" ? "binding changed" : null,observedBinding: null,
    entry: {sequence: 7,appendKey: "append",deliveryId: "delivery",update: new Uint8Array([1,2]),updateDigest: "b".repeat(64),byteLength: 2,createdAtMs: 0},
  };
  const receipt = {deliveryId: "delivery",updateDigest: "b".repeat(64),journalCursor: 9,acceptingHostEpoch: parseHostEpoch(1)};
  class TestOutbox extends OwnerYDocOutbox {
    override readHead = vi.fn(async () => pending);
    override acknowledge = vi.fn(async () => ({acknowledged: 1,pendingBytes: 0,oldestEntryAtMs: null}));
    override quarantine = vi.fn(async () => {});
  }
  const outbox = new TestOutbox({sendRequest: async () => {throw new Error("unexpected request");}},"handle");
  const delivery = {
    freshOwnerAuthority: vi.fn<OwnerYDocDelivery["freshOwnerAuthority"]>(async () => ({kind: "authority",authority: {value: {},hostEpoch: parseHostEpoch(2)}})),
    deliver: vi.fn<OwnerYDocDelivery["deliver"]>(async () => ({kind: "receipt",receipt})),
  };
  const drainer = new OwnerYDocOutboxDrainer(outbox,"outbox",delivery);
  return {pending,receipt,outbox,delivery,drainer,close: () => {drainer.dispose(); outbox.dispose();}};
}

it.each(["active","sealed"] as const)("drains an old, large %s queue after fresh authority without changing bytes or identity", async state => {
  const f = fixture(state);
  try {
    expect(await f.drainer.drainOnce()).toBe("acknowledged");
    expect(f.delivery.freshOwnerAuthority).toHaveBeenCalledWith(f.pending.binding);
    expect(f.delivery.deliver).toHaveBeenCalledWith({value: {},hostEpoch: 2}, {
      outboxId: f.pending.outboxId,binding: f.pending.binding,baseUpdate: f.pending.baseUpdate,baseUpdateDigest: f.pending.baseUpdateDigest,
      sequence: 7,appendKey: "append",deliveryId: "delivery",update: f.pending.entry!.update,updateDigest: "b".repeat(64),
    });
    expect(f.outbox.acknowledge).toHaveBeenCalledWith("outbox",[f.receipt]);
  } finally {f.close();}
});

it("keeps quarantine frozen without requesting fresh authority or delivering", async () => {
  const f = fixture("quarantined");
  try {
    expect(await f.drainer.drainOnce()).toBe("frozen");
    expect(f.delivery.freshOwnerAuthority).not.toHaveBeenCalled();
    expect(f.delivery.deliver).not.toHaveBeenCalled();
    expect(f.outbox.acknowledge).not.toHaveBeenCalled();
  } finally {f.close();}
});

it("retains a sealed head on retry and quarantines it if fresh standing changes", async () => {
  const f = fixture("sealed");
  try {
    f.delivery.freshOwnerAuthority.mockResolvedValueOnce({kind: "retry"});
    expect(await f.drainer.drainOnce()).toBe("retry");
    f.delivery.freshOwnerAuthority.mockResolvedValueOnce({kind: "quarantine",reason: "binding changed"});
    expect(await f.drainer.drainOnce()).toBe("frozen");
    expect(f.outbox.quarantine).toHaveBeenCalledWith({outboxId: "outbox",reason: "binding changed"});
    expect(f.delivery.deliver).not.toHaveBeenCalled();
    expect(f.outbox.acknowledge).not.toHaveBeenCalled();
  } finally {f.close();}
});
