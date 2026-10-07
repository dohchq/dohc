// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CheckSharedViewAccessResult, DohcDesktopBridge } from "../../ipc/bridgeContract";
import { deferred } from "../../testing/deferred";
import { useSharedViewAccess } from "./useSharedViewAccess";

const check = vi.fn<DohcDesktopBridge["checkSharedViewAccess"]>();
let visible = true;
const verified = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  visible = true;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visible ? "visible" : "hidden");
  check.mockReset().mockResolvedValue({ status: "current", access: "edit" });
  verified.mockReset();
  window.dohcDesktop = { checkSharedViewAccess: check } as unknown as DohcDesktopBridge;
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); delete window.dohcDesktop; });
const flush = () => act(async () => { await Promise.resolve(); });
function setup() {
  return renderHook(({ workspaceId, admission }) => useSharedViewAccess({
    workspaceId, admission, enabled: true, onVerified: verified,
  }), { initialProps: { workspaceId: "A", admission: { superseded: false } } });
}

it("discovers ended access at the next five-second check", async () => {
  setup(); await flush();
  check.mockResolvedValue({ status: "ended" });
  await act(() => vi.advanceTimersByTimeAsync(4_999));
  expect(check).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(verified).toHaveBeenLastCalledWith({ status: "ended" });
});

it("never overlaps deferred requests and rechecks a focus event after that request", async () => {
  const response = deferred<CheckSharedViewAccessResult>();
  check.mockReturnValueOnce(response.promise);
  setup();
  await act(() => vi.advanceTimersByTimeAsync(15_000));
  act(() => window.dispatchEvent(new Event("focus")));
  expect(check).toHaveBeenCalledTimes(1);
  await act(async () => { response.resolve({ status: "current", access: "edit" }); });
  expect(check).toHaveBeenCalledTimes(2);
});

it("checks again after an in-flight request when a push caller requests a recheck", async () => {
  const response = deferred<CheckSharedViewAccessResult>();
  check.mockReturnValueOnce(response.promise);
  const hook = setup();
  let requested: Promise<CheckSharedViewAccessResult>;
  act(() => { requested = hook.result.current(); });
  check.mockResolvedValue({ status: "ended" });
  await act(async () => {
    response.resolve({ status: "current", access: "edit" });
    expect(await requested!).toEqual({ status: "ended" });
  });
  expect(check).toHaveBeenCalledTimes(2);
});

it("pauses hidden checks and immediately checks visibility and focus", async () => {
  visible = false;
  setup();
  await act(() => vi.advanceTimersByTimeAsync(15_000));
  act(() => window.dispatchEvent(new Event("focus")));
  expect(check).not.toHaveBeenCalled();
  visible = true;
  for (const event of ["visibilitychange", "focus"]) {
    act(() => (event === "visibilitychange" ? document : window).dispatchEvent(new Event(event)));
    await flush();
  }
  expect(check).toHaveBeenCalledTimes(2);
});

it("keeps offline separate from ended and discards answers on close", async () => {
  check.mockResolvedValue({ status: "unverified" });
  const hook = setup(); await flush();
  expect(verified).not.toHaveBeenCalled();
  const response = deferred<CheckSharedViewAccessResult>();
  check.mockReturnValueOnce(response.promise);
  await act(() => vi.advanceTimersByTimeAsync(5_000));
  hook.unmount();
  await act(async () => { response.resolve({ status: "ended" }); });
  expect(verified).not.toHaveBeenCalled();
});

it("discards an answer after workspace admission is superseded", async () => {
  const response = deferred<CheckSharedViewAccessResult>();
  check.mockReturnValueOnce(response.promise);
  const hook = setup();
  hook.rerender({ workspaceId: "B", admission: { superseded: false } });
  await flush();
  verified.mockClear();
  await act(async () => { response.resolve({ status: "ended" }); });
  expect(verified).not.toHaveBeenCalled();
});

it("rechecks immediately when workspace relay sync recovers", async () => {
  const admission = { superseded: false };
  const hook = renderHook(({ relayFailed }) => useSharedViewAccess({ workspaceId: "A", admission, enabled: true, relayFailed, onVerified: verified }),
    { initialProps: { relayFailed: false } });
  await flush();
  hook.rerender({ relayFailed: true }); await flush();
  expect(check).toHaveBeenCalledTimes(1);
  hook.rerender({ relayFailed: false }); await flush();
  expect(check).toHaveBeenCalledTimes(2);
  hook.rerender({ relayFailed: false }); await flush();
  expect(check).toHaveBeenCalledTimes(2);
});

it("does not interpret another workspace's healthy sync as recovery", async () => {
  const hook = renderHook(({ workspaceId, admission, relayFailed }) => useSharedViewAccess({ workspaceId, admission, enabled: true, relayFailed, onVerified: verified }),
    { initialProps: { workspaceId: "A", admission: { superseded: false }, relayFailed: true } });
  await flush();
  hook.rerender({ workspaceId: "B", admission: { superseded: false }, relayFailed: false }); await flush();
  expect(check).toHaveBeenCalledTimes(2);
  expect(check).toHaveBeenLastCalledWith({ workspaceId: "B" });
});
