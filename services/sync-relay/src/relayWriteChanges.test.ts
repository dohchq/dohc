import {expect, it, vi} from "vitest";
import {notifyRelayWrite, observeRelayWrites} from "./relayWriteChanges";

it("coalesces writes after the transaction stack and removes closed hosts", async () => {
  const storage = {}, first = vi.fn(), second = vi.fn();
  const stop = observeRelayWrites(storage, first);
  const stopSecond = observeRelayWrites(storage, second);
  notifyRelayWrite(storage); notifyRelayWrite(storage);
  expect(first).not.toHaveBeenCalled();
  stopSecond();
  await new Promise<void>(queueMicrotask);
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).not.toHaveBeenCalled();
  stop(); notifyRelayWrite(storage);
  await new Promise<void>(queueMicrotask);
  expect(first).toHaveBeenCalledTimes(1);
});

it("isolates a failing host observer", async () => {
  const storage = {}, observed = vi.fn();
  const stop = observeRelayWrites(storage, () => {throw new Error("retired");});
  const stopOther = observeRelayWrites(storage, observed);
  notifyRelayWrite(storage);
  await new Promise<void>(queueMicrotask);
  expect(observed).toHaveBeenCalledTimes(1);
  stop(); stopOther();
});
