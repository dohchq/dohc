// @vitest-environment jsdom
import type { PostHogConfig } from "posthog-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const posthog = vi.hoisted(() => ({
  init: vi.fn<(token: string, config: Partial<PostHogConfig>) => void>(),
  capture: vi.fn(),
}));
vi.mock("posthog-js", () => ({ default: posthog }));

beforeEach(async () => {
  vi.useFakeTimers();
  posthog.capture.mockClear();
  document.body.innerHTML = `
    <a data-download-primary data-download-build="" href="#downloads">Download dohc</a>
    <a data-download-card="mac-arm64" href="#downloads"><span>Download</span></a>`;
  await import("./analytics");
});
afterEach(() => vi.useRealTimers());

it("loads PostHog cookieless and without replay, only once the page is idle", async () => {
  expect(posthog.init).not.toHaveBeenCalled();
  await vi.runAllTimersAsync();
  expect(posthog.init).toHaveBeenCalledOnce();
  expect(posthog.init.mock.calls[0]![1]).toMatchObject({
    api_host: "/ingest",
    cookieless_mode: "always",
    disable_session_recording: true,
    capture_heatmaps: false,
    disable_scroll_properties: true,
    disableDeviceModel: true,
    // Without it, PostHog's remote config could switch features back on.
    advanced_disable_flags: true,
  });
});

it("asks PostHog not to look up a location for any event", async () => {
  await vi.runAllTimersAsync();
  const { before_send } = posthog.init.mock.calls[0]![1];
  if (typeof before_send !== "function") throw new Error("before_send is not one function");
  for (const event of ["$pageview", "$pageleave", "$autocapture", "download_clicked"]) {
    const sent = before_send({ uuid: "u", event, properties: { $current_url: "https://dohc.computer/" } });
    expect(sent?.properties).toEqual({ $current_url: "https://dohc.computer/", $geoip_disable: true });
  }
});

it("autocaptures the site's own elements, not the demo's", async () => {
  await vi.runAllTimersAsync();
  const { autocapture } = posthog.init.mock.calls[0]![1];
  if (typeof autocapture !== "object") throw new Error("autocapture has no selectors");
  // As PostHog does: the target and its ancestors, through shadow hosts.
  const chain = (el: Element) => {
    const elements: Element[] = [];
    for (let node: Node | null = el; node; node = node instanceof ShadowRoot ? node.host : node.parentNode) {
      if (node instanceof Element && node.tagName !== "HTML") elements.push(node);
    }
    return elements;
  };
  const anyMatches = (el: Element, selectors: string[] = []) =>
    chain(el).some((node) => selectors.some((selector) => node.matches(selector)));
  const captured = (el: Element) =>
    anyMatches(el, autocapture.css_selector_allowlist) && !anyMatches(el, autocapture.css_selector_ignorelist);
  document.body.innerHTML = `<main><a href="#">Read</a><section><div id="desktop-demo"></div></section>
    <div class="sync-stage"><div data-sync-demo><textarea></textarea></div>
    <label><input type="checkbox" data-sync-toggle /></label></div></main>`;
  const shadow = document.getElementById("desktop-demo")!.attachShadow({ mode: "open" });
  shadow.innerHTML = `<main><button>notes.md</button></main>`;
  const portal = document.createElement("button");
  document.body.append(portal);
  expect(captured(document.querySelector("a")!)).toBe(true);
  expect(captured(shadow.querySelector("button")!)).toBe(false);
  expect(captured(portal)).toBe(false);
  expect(captured(document.querySelector("textarea")!)).toBe(false);
  expect(captured(document.querySelector("[data-sync-toggle]")!)).toBe(false);
});

it("names the build in a download click, and skips a click that only scrolls", async () => {
  document.querySelector<HTMLElement>("[data-download-primary]")!.click();
  document.querySelector<HTMLElement>("[data-download-card] span")!.click();
  await vi.runAllTimersAsync();
  expect(posthog.capture.mock.calls).toEqual([
    ["download_clicked", { asset: "mac-arm64", platform: "mac" }, { send_instantly: true }],
  ]);
});
