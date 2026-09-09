import {describe, expect, it, vi} from "vitest";
import {LiveCommittedDelivery} from "./liveCommittedDelivery";
import {OwnerCommittedDelivery} from "./ownerCommittedDelivery";
import {LiveHostRegistrations} from "./liveHostRegistration";
import type {LiveObjectBinding} from "@dohc/live-session-contract/live-object-binding";

const digest = "a".repeat(64);
const document = {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "b".repeat(64)};
const binding: LiveObjectBinding = {...document, currentPath: "document.md", selectorPaths: ["document.md"], restoreFenceGeneration: 2};
const lookup = {workspaceId: document.workspaceId, ownerUserId: "owner", operationId: "operation"};

function fixture(kind: "bootstrap" | "owner") {
  const result = {kind: "resumed" as const, proposalDigest: digest, receipt: {operationId: lookup.operationId}};
  const confirm = vi.fn(async (_options: unknown, expected: string) => {
    if (expected !== digest) throw new Error("Restore continuation does not match the retained proposal.");
    return result;
  });
  const prepare = vi.fn(async () => {throw new Error("Preparation interrupted after entry.");});
  const store = {stopRestoreDocument: vi.fn(() => structuredClone(document))};
  const storage = {createLiveCommittedDeliveryStore: vi.fn(() => store)};
  const connection = {client: {}, workspace: "native-workspace", deadlineMs: 1_000, nextRequestId: () => 1,
    host: {mode: "device" as const, hostId: "host", hostEpoch: 1, instanceId: "instance", connectionId: "connection"},
    restore: {confirm, prepare}, bounds: {maxBytes: 10_000, maxEvents: 100}, ownerAdmission: {shares: new Map()}};
  const consumer = kind === "bootstrap"
    ? new LiveCommittedDelivery(storage as unknown as ConstructorParameters<typeof LiveCommittedDelivery>[0],
      {} as ConstructorParameters<typeof LiveCommittedDelivery>[1],
      connection as unknown as ConstructorParameters<typeof LiveCommittedDelivery>[2])
    : new OwnerCommittedDelivery(storage as unknown as ConstructorParameters<typeof OwnerCommittedDelivery>[0],
      {} as ConstructorParameters<typeof OwnerCommittedDelivery>[1],
      connection as unknown as ConstructorParameters<typeof OwnerCommittedDelivery>[2]);
  // Seed the consumer's real registry without a native transport. All subsequent
  // captures and invalidations use the production implementation.
  const seed = vi.spyOn(LiveHostRegistrations.prototype, "capture").mockImplementationOnce(function(this: LiveHostRegistrations, value) {
    return this.remember(value, 1);
  });
  let registration: ReturnType<LiveHostRegistrations["capture"]>;
  try {registration = consumer.captureRegistration(binding);}
  finally {seed.mockRestore();}
  return {consumer, registration, confirm, prepare, result};
}

describe.each(["bootstrap", "owner"] as const)("%s restore confirmation registration", kind => {
  it("keeps a reconnected reader alive when a stale digest is refused", async () => {
    const f = fixture(kind), closed = vi.fn();
    f.registration.invalidated.addEventListener("abort", closed);
    await expect(f.consumer.confirmRestore(lookup, "c".repeat(64))).rejects.toThrow("retained proposal");
    expect(f.confirm).toHaveBeenCalledTimes(1);
    expect(closed).not.toHaveBeenCalled();
    expect(f.registration.invalidated.aborted).toBe(false);
    expect(f.consumer.captureRegistration(binding)).toEqual(f.registration);
  });

  it("keeps a reconnected reader alive when completed confirmation is retried", async () => {
    const f = fixture(kind), closed = vi.fn();
    f.registration.invalidated.addEventListener("abort", closed);
    await expect(f.consumer.confirmRestore(lookup, digest)).resolves.toEqual(f.result);
    await expect(f.consumer.confirmRestore(lookup, digest)).resolves.toEqual(f.result);
    expect(f.confirm).toHaveBeenCalledTimes(2);
    expect(closed).not.toHaveBeenCalled();
    expect(f.registration.invalidated.aborted).toBe(false);
    expect(f.consumer.captureRegistration(binding)).toEqual(f.registration);
  });

  it("retires the old reader before preparation starts, including interrupted preparation", async () => {
    const f = fixture(kind);
    f.prepare.mockImplementationOnce(async () => {
      expect(f.registration.invalidated.aborted).toBe(true);
      throw new Error("Preparation interrupted after entry.");
    });
    await expect(f.consumer.prepareRestore(lookup)).rejects.toThrow("Preparation interrupted");
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.registration.invalidated.aborted).toBe(true);
    expect(() => f.consumer.captureRegistration(binding)).toThrow("unavailable");
  });
});
