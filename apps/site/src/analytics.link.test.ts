// @vitest-environment jsdom
// The real PostHog SDK, not a mock. Anyone can send a visitor a link to this
// site, so what the link carries must not change what privacy.html promises:
// nothing kept in the browser, and only the page's address without anything
// after a ? or #.
import { gunzipSync } from "node:zlib";
import { expect, it, vi } from "vitest";

it("keeps nothing and sends no part of a link after its ? or #", async () => {
  // The SDK's toolbar and debug switches read the address; the rest are the
  // campaign tags and query an email link may carry.
  const toolbar = btoa(JSON.stringify({ action: "ph_authorize", token: "phc_4EUB88JK9BzR2LEtJ24xVwMV8pczEBs95yTMpwJuvu4" }));
  history.replaceState(null, "", `/?utm_source=news&gclid=abc123&email=a%40b.c&__posthog_debug=true#__posthog=${toolbar}`);
  // From another page of this site, the browser sends that page's whole address.
  Object.defineProperty(document, "referrer", { value: "http://localhost:3000/privacy?from=b%40c.d#top" });
  const bodies: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    const body = new Uint8Array(await new Response(init?.body).arrayBuffer());
    bodies.push((body[0] === 0x1f ? gunzipSync(body) : Buffer.from(body)).toString());
    return new Response("{}");
  }));

  const { default: posthog } = await import("posthog-js");
  await import("./analytics");
  await vi.waitFor(() => expect(posthog.__loaded).toBe(true), { timeout: 5000 });
  posthog.capture("check", {}, { send_instantly: true });
  await vi.waitFor(() => expect(bodies.join()).toContain('"check"'));

  expect({ ...localStorage }).toEqual({});
  expect({ ...sessionStorage }).toEqual({});
  expect(document.querySelectorAll("script")).toHaveLength(0);
  const sent = bodies.join();
  expect(sent).toContain('"$current_url":"http://localhost:3000/"');
  expect(sent).toContain('"$referrer":"http://localhost:3000/privacy"');
  for (const part of ["utm_source", "news", "gclid", "abc123", "a%40b.c", "__posthog", "b%40c.d", "#top"]) {
    expect(sent, part).not.toContain(part);
  }
});
