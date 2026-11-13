import { expect, it, vi } from "vitest";
import { NO_LIVE_AUTHORITY, notifyRelayWrite, observeRelayWrites } from "./relayWriteChanges";

it("coalesces writes after the transaction stack and removes closed hosts", async () => {
  const storage = {},
    first = vi.fn(),
    second = vi.fn();
  const stop = observeRelayWrites(storage, first);
  const stopSecond = observeRelayWrites(storage, second);
  notifyRelayWrite(storage);
  notifyRelayWrite(storage);
  expect(first).not.toHaveBeenCalled();
  stopSecond();
  await new Promise<void>(queueMicrotask);
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).not.toHaveBeenCalled();
  stop();
  notifyRelayWrite(storage);
  await new Promise<void>(queueMicrotask);
  expect(first).toHaveBeenCalledTimes(1);
});

it("isolates a failing host observer", async () => {
  const storage = {},
    observed = vi.fn();
  const stop = observeRelayWrites(storage, () => {
    throw new Error("retired");
  });
  const stopOther = observeRelayWrites(storage, observed);
  notifyRelayWrite(storage);
  await new Promise<void>(queueMicrotask);
  expect(observed).toHaveBeenCalledTimes(1);
  stop();
  stopOther();
});

it("names the documents coalesced writes were limited to, and none once any write was not", async () => {
  const storage = {},
    observed = vi.fn();
  const a = {
      workspaceId: "workspace",
      mainVersionId: "main",
      objectId: "a",
      lineageClaimId: "lineage",
    },
    b = { ...a, objectId: "b" };
  const stop = observeRelayWrites(storage, observed);
  notifyRelayWrite(storage, a);
  notifyRelayWrite(storage, b);
  notifyRelayWrite(storage, { ...a });
  await new Promise<void>(queueMicrotask);
  expect(observed).toHaveBeenLastCalledWith([a, b]);
  notifyRelayWrite(storage, a);
  notifyRelayWrite(storage);
  notifyRelayWrite(storage, b);
  await new Promise<void>(queueMicrotask);
  expect(observed).toHaveBeenLastCalledWith(undefined);
  expect(observed).toHaveBeenCalledTimes(2);
  stop();
});

it("names no document for writes that changed no live authority, yet wakes every observer", async () => {
  const storage = {},
    observed = vi.fn();
  const a = {
    workspaceId: "workspace",
    mainVersionId: "main",
    objectId: "a",
    lineageClaimId: "lineage",
  };
  const stop = observeRelayWrites(storage, observed);
  notifyRelayWrite(storage, NO_LIVE_AUTHORITY);
  notifyRelayWrite(storage, NO_LIVE_AUTHORITY);
  await new Promise<void>(queueMicrotask);
  expect(observed).toHaveBeenLastCalledWith([]);
  notifyRelayWrite(storage, NO_LIVE_AUTHORITY);
  notifyRelayWrite(storage, a);
  await new Promise<void>(queueMicrotask);
  expect(observed).toHaveBeenLastCalledWith([a]);
  notifyRelayWrite(storage, NO_LIVE_AUTHORITY);
  notifyRelayWrite(storage);
  await new Promise<void>(queueMicrotask);
  expect(observed).toHaveBeenLastCalledWith(undefined);
  expect(observed).toHaveBeenCalledTimes(3);
  stop();
});
