// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAsyncResponseEffect } from "./useAsyncResponseEffect";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(cleanup);

describe("useAsyncResponseEffect", () => {
  it("delivers the current successful response", async () => {
    const response = deferred<string>();
    const onSuccess = vi.fn();
    const onError = vi.fn();
    renderHook(() =>
      useAsyncResponseEffect(
        () => response.promise,
        { onSuccess, onError },
        [],
      ),
    );

    await act(async () => {
      response.resolve("ready");
      await response.promise;
    });

    expect(onSuccess).toHaveBeenCalledWith("ready");
    expect(onError).not.toHaveBeenCalled();
  });

  it("delivers the current rejected response", async () => {
    const response = deferred<string>();
    const onSuccess = vi.fn();
    const onError = vi.fn();
    renderHook(() =>
      useAsyncResponseEffect(
        () => response.promise,
        { onSuccess, onError },
        [],
      ),
    );

    const failure = new Error("unavailable");
    await act(async () => {
      response.reject(failure);
      await response.promise.catch(() => undefined);
    });

    expect(onError).toHaveBeenCalledWith(failure);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("drops a successful response after its identity is replaced", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const onSuccess = vi.fn();
    const { rerender } = renderHook(
      ({ identity }) =>
        useAsyncResponseEffect(
          () => (identity === "first" ? first.promise : second.promise),
          { onSuccess, onError: vi.fn() },
          [identity],
        ),
      { initialProps: { identity: "first" } },
    );

    rerender({ identity: "second" });
    await act(async () => {
      first.resolve("stale");
      await first.promise;
    });
    expect(onSuccess).not.toHaveBeenCalled();

    await act(async () => {
      second.resolve("current");
      await second.promise;
    });
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(onSuccess).toHaveBeenCalledWith("current");
  });

  it("drops a rejected response after its identity is replaced", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const onError = vi.fn();
    const { rerender } = renderHook(
      ({ identity }) =>
        useAsyncResponseEffect(
          () => (identity === "first" ? first.promise : second.promise),
          { onSuccess: vi.fn(), onError },
          [identity],
        ),
      { initialProps: { identity: "first" } },
    );

    rerender({ identity: "second" });
    await act(async () => {
      first.reject(new Error("stale"));
      await first.promise.catch(() => undefined);
    });
    expect(onError).not.toHaveBeenCalled();

    const current = new Error("current");
    await act(async () => {
      second.reject(current);
      await second.promise.catch(() => undefined);
    });
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(current);
  });

  it("drops a response after unmount", async () => {
    const response = deferred<string>();
    const onSuccess = vi.fn();
    const view = renderHook(() =>
      useAsyncResponseEffect(
        () => response.promise,
        { onSuccess, onError: vi.fn() },
        [],
      ),
    );

    view.unmount();
    await act(async () => {
      response.resolve("stale");
      await response.promise;
    });
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("starts no request while dormant", () => {
    const request = vi.fn(() => null);
    const onSuccess = vi.fn();
    const onError = vi.fn();
    renderHook(() =>
      useAsyncResponseEffect(request, { onSuccess, onError }, []),
    );

    expect(request).toHaveBeenCalledOnce();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("drops an active response after its replacement becomes dormant", async () => {
    const response = deferred<string>();
    const onSuccess = vi.fn();
    const { rerender } = renderHook(
      ({ active }) =>
        useAsyncResponseEffect(
          () => (active ? response.promise : null),
          { onSuccess, onError: vi.fn() },
          [active],
        ),
      { initialProps: { active: true } },
    );

    rerender({ active: false });
    await act(async () => {
      response.resolve("stale");
      await response.promise;
    });

    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("drops the retired StrictMode invocation", async () => {
    const retired = deferred<string>();
    const current = deferred<string>();
    const request = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(retired.promise)
      .mockReturnValueOnce(current.promise);
    const onSuccess = vi.fn();
    renderHook(
      () =>
        useAsyncResponseEffect(
          request,
          { onSuccess, onError: vi.fn() },
          [],
        ),
      { reactStrictMode: true },
    );
    expect(request).toHaveBeenCalledTimes(2);

    await act(async () => {
      retired.resolve("retired");
      await retired.promise;
    });
    expect(onSuccess).not.toHaveBeenCalled();

    await act(async () => {
      current.resolve("current");
      await current.promise;
    });
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(onSuccess).toHaveBeenCalledWith("current");
  });
});
