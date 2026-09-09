import {expect, it, vi} from "vitest";
import {ownerRestoreReviewResponse} from "./ownerRestoreResponse";

function lease(maxOutputBytes = 1_000_000) {
  const controller = new AbortController();
  const close = vi.fn(() => controller.abort(Error("closed")));
  return {controller, close, invalidated: controller.signal, maxOutputBytes};
}
it("holds the host lease through consumption, including a parked last chunk", async () => {
  const l = lease(), value = {content: "a".repeat(100_000)};
  const response = ownerRestoreReviewResponse(value, l), reader = response.body!.getReader();
  expect(l.close).not.toHaveBeenCalled();
  const first = await reader.read(); expect(first.value!.byteLength).toBe(65_536);
  const last = await reader.read(); expect(last.done).toBe(false);
  expect(l.close).not.toHaveBeenCalled();
  expect(await reader.read()).toEqual({done: true, value: undefined});
  expect(l.close).toHaveBeenCalledTimes(1);
});
it("drops a parked response when its lease expires", async () => {
  const l = lease(), response = ownerRestoreReviewResponse({content: "a".repeat(100_000)}, l);
  l.controller.abort(Error("expired"));
  await expect(response.text()).rejects.toThrow("expired");
  expect(l.close).toHaveBeenCalledTimes(1);
});
it("releases a disconnected response without consumption", async () => {
  const l = lease(), response = ownerRestoreReviewResponse({content: "a".repeat(100_000)}, l);
  await response.body!.cancel();
  expect(l.close).toHaveBeenCalledTimes(1);
});
it("charges the final envelope at its exact serialized byte boundary", async () => {
  const value = {status: {phase: "native-fenced"}, result: {content: "😀"}}, exact = Buffer.byteLength(JSON.stringify(value));
  const allowed = lease(exact); expect(await ownerRestoreReviewResponse(value, allowed).json()).toEqual(value);
  expect(allowed.close).toHaveBeenCalledTimes(1);
  const denied = lease(exact - 1); expect(() => ownerRestoreReviewResponse(value, denied)).toThrow(/output budget/);
  expect(denied.close).toHaveBeenCalledTimes(1);
});
it("refuses an already-retired lease", () => {
  const l = lease(); l.controller.abort(Error("retired"));
  expect(() => ownerRestoreReviewResponse({}, l)).toThrow("retired");
  expect(l.close).toHaveBeenCalledTimes(1);
});
