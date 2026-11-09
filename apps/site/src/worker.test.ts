import { afterEach, expect, it, vi } from "vitest";
import worker from "./worker";

const assets = { fetch: vi.fn(async () => new Response("page")) };
const upstream = vi.fn(async (_url: string, _init: RequestInit) =>
  new Response("ok", { headers: { "set-cookie": "a=b", "content-type": "text/plain" } }));
vi.stubGlobal("fetch", upstream);
afterEach(() => vi.clearAllMocks());

it("forwards events to PostHog with only the SDK's headers and the visitor's address", async () => {
  const response = await worker.fetch(new Request("https://dohc.computer/ingest/i/v0/e/?ver=1", {
    method: "POST",
    body: "{}",
    headers: {
      cookie: "cf_clearance=x",
      "cf-connecting-ip": "203.0.113.7",
      "cf-ipcountry": "NZ",
      "cf-ipcity": "Wellington",
      "x-real-ip": "203.0.113.7",
      authorization: "Bearer phx_personal",
      "content-type": "application/json",
      "user-agent": "Browser/1",
    },
  }), { ASSETS: assets });
  const [url, init] = upstream.mock.calls[0]!;
  const headers = new Headers(init.headers);
  expect(url).toBe("https://us.i.posthog.com/i/v0/e/?ver=1");
  expect([...headers]).toEqual([
    ["content-type", "application/json"],
    ["user-agent", "Browser/1"],
    ["x-forwarded-for", "203.0.113.7"],
  ]);
  expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe("{}");
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(assets.fetch).not.toHaveBeenCalled();
});

it("loads PostHog's scripts and remote config from its asset host", async () => {
  await worker.fetch(new Request("https://dohc.computer/ingest/static/surveys.js"), { ASSETS: assets });
  await worker.fetch(new Request("https://dohc.computer/ingest/array/phc_x/config"), { ASSETS: assets });
  expect(upstream.mock.calls.map(([url]) => url)).toEqual([
    "https://us-assets.i.posthog.com/static/surveys.js",
    "https://us-assets.i.posthog.com/array/phc_x/config",
  ]);
});

it("serves every other path from the site's files", async () => {
  for (const path of ["/", "/privacy.html", "/ingestion", "/ingest"]) {
    await worker.fetch(new Request(`https://dohc.computer${path}`), { ASSETS: assets });
  }
  expect(assets.fetch).toHaveBeenCalledTimes(4);
  expect(upstream).not.toHaveBeenCalled();
});
