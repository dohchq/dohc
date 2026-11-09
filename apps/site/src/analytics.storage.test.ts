// @vitest-environment jsdom
// The real PostHog SDK, not a mock: privacy.html promises no cookies, even
// when the browser refuses storage and the SDK looks for somewhere else.
import { expect, it, vi } from "vitest";

it("writes no cookie while PostHog starts, even when storage writes fail", async () => {
  const cookies: string[] = [];
  const cookie = Object.getOwnPropertyDescriptor(Document.prototype, "cookie")!;
  Object.defineProperty(document, "cookie", {
    configurable: true,
    get: () => cookie.get!.call(document),
    set: (value: string) => {
      cookies.push(value);
      cookie.set!.call(document, value);
    },
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("Storage is full", "QuotaExceededError");
  });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));

  // After the spies, because the SDK checks storage when it loads.
  const { default: posthog } = await import("posthog-js");
  await import("./analytics");
  await vi.waitFor(() => expect(posthog.__loaded).toBe(true), { timeout: 5000 });
  posthog.capture("check");

  expect(cookies).toEqual([]);
});
