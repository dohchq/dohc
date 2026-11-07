// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useRequestSequence } from "./useRequestSequence";

describe("request sequences", () => {
  it("keeps only the latest request current across rerenders", () => {
    const hook = renderHook(() => useRequestSequence());
    const requests = hook.result.current;
    const first = requests.next();
    hook.rerender();
    expect(hook.result.current).toBe(requests);
    expect(requests.isCurrent(first)).toBe(true);
    const second = requests.next();
    expect(requests.isCurrent(first)).toBe(false);
    expect(requests.isCurrent(second)).toBe(true);
    hook.unmount();
    expect(requests.isCurrent(second)).toBe(false);
  });

  it("tells a request its owner cut off from one a newer request replaced", () => {
    const hook = renderHook(() => useRequestSequence());
    const requests = hook.result.current;
    const replaced = requests.next();
    const newest = requests.next();
    expect(requests.isCutOff(newest)).toBe(false);
    hook.unmount();
    expect(requests.isCutOff(newest)).toBe(true);
    expect(requests.isCutOff(replaced)).toBe(false);
  });

  it("retires requests when their workspace identity changes", () => {
    const hook = renderHook(({ workspaceId }) => useRequestSequence([workspaceId]), {
      initialProps: { workspaceId: "a" },
    });
    const requests = hook.result.current;
    const first = requests.next();
    act(() => hook.rerender({ workspaceId: "b" }));
    expect(requests.isCurrent(first)).toBe(false);
    expect(requests.isCurrent(requests.next())).toBe(true);
    hook.unmount();
  });
});
