import { afterEach, expect, it, vi } from "vitest";
import worker from "./worker";

const assets = { fetch: vi.fn(async () => new Response("page")) };
const upstream = vi.fn(
  async (_url: string, _init: RequestInit) =>
    new Response("ok", { headers: { "set-cookie": "a=b", "content-type": "text/plain" } }),
);
vi.stubGlobal("fetch", upstream);
afterEach(() => vi.clearAllMocks());

it("forwards events to PostHog with only the SDK's headers and the visitor's address", async () => {
  const response = await worker.fetch(
    new Request("https://dohc.computer/ingest/i/v0/e/?ver=1", {
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
    }),
    { ASSETS: assets },
  );
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
  await worker.fetch(new Request("https://dohc.computer/ingest/static/surveys.js"), {
    ASSETS: assets,
  });
  await worker.fetch(new Request("https://dohc.computer/ingest/array/phc_x/config"), {
    ASSETS: assets,
  });
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

const ALLOWED_KEY = "phc_desktop1234567890";
const OTHER_KEY = "phc_other9876543210";

it("forwards allowed /telemetry/batch/ JSON payloads while stripping IP headers and $ip fields", async () => {
  const response = await worker.fetch(
    new Request("https://dohc.computer/telemetry/batch/", {
      method: "POST",
      headers: {
        cookie: "session=secret",
        "cf-connecting-ip": "203.0.113.7",
        "cf-ipcountry": "SG",
        "x-forwarded-for": "203.0.113.7",
        "x-real-ip": "203.0.113.7",
        authorization: "Bearer phx_personal",
        "content-type": "application/json",
        "user-agent": "dohc/1.0",
      },
      body: JSON.stringify({
        api_key: ALLOWED_KEY,
        sent_at: "2026-11-25T05:00:00.000Z",
        extra_field: "dropped",
        batch: [
          {
            event: "app_launched",
            distinct_id: "install-1",
            $ip: "203.0.113.7",
            properties: {
              $ip: "203.0.113.7",
              $set: { $ip: "203.0.113.7", keep: true },
              channel: "nightly",
            },
          },
        ],
      }),
    }),
    { ASSETS: assets, ALLOWED_TELEMETRY_KEYS: `${ALLOWED_KEY}, phc_second1234567890` },
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).toBeNull();
  const [url, init] = upstream.mock.calls[0]!;
  expect(url).toBe("https://us.i.posthog.com/batch/");
  expect([...new Headers(init.headers)]).toEqual([["content-type", "application/json"]]);
  expect(JSON.parse(init.body as string)).toEqual({
    api_key: ALLOWED_KEY,
    sent_at: "2026-11-25T05:00:00.000Z",
    batch: [
      {
        event: "app_launched",
        distinct_id: "install-1",
        properties: { $set: { keep: true }, $geoip_disable: true, channel: "nightly" },
      },
    ],
  });
  expect(assets.fetch).not.toHaveBeenCalled();
});

it("refuses /telemetry/batch/ when unconfigured, wrong media type, wrong key, wrong method, wrong path, bad JSON, or oversized", async () => {
  const validBody = JSON.stringify({ api_key: ALLOWED_KEY, batch: [{ event: "app_launched" }] });
  const jsonHeaders = { "content-type": "application/json; charset=utf-8" };
  const unconfigured = await worker.fetch(
    new Request("https://dohc.computer/telemetry/batch/", {
      method: "POST",
      headers: jsonHeaders,
      body: validBody,
    }),
    { ASSETS: assets },
  );
  expect(unconfigured.status).toBe(503);

  const wrongMediaType = await worker.fetch(
    new Request("https://dohc.computer/telemetry/batch/", {
      method: "POST",
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: validBody,
    }),
    { ASSETS: assets, ALLOWED_TELEMETRY_KEYS: ALLOWED_KEY },
  );
  expect(wrongMediaType.status).toBe(415);

  const wrongMethod = await worker.fetch(
    new Request("https://dohc.computer/telemetry/batch/", { method: "GET" }),
    { ASSETS: assets, ALLOWED_TELEMETRY_KEYS: ALLOWED_KEY },
  );
  expect(wrongMethod.status).toBe(405);
  expect(wrongMethod.headers.get("allow")).toBe("POST");

  const wrongPath = await worker.fetch(
    new Request("https://dohc.computer/telemetry/e/", {
      method: "POST",
      headers: jsonHeaders,
      body: validBody,
    }),
    { ASSETS: assets, ALLOWED_TELEMETRY_KEYS: ALLOWED_KEY },
  );
  expect(wrongPath.status).toBe(404);

  const forbidden = await worker.fetch(
    new Request("https://dohc.computer/telemetry/batch/", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ api_key: OTHER_KEY, batch: [{ event: "app_launched" }] }),
    }),
    { ASSETS: assets, ALLOWED_TELEMETRY_KEYS: ALLOWED_KEY },
  );
  expect(forbidden.status).toBe(403);

  const badJson = await worker.fetch(
    new Request("https://dohc.computer/telemetry/batch/", {
      method: "POST",
      headers: jsonHeaders,
      body: "not-json",
    }),
    { ASSETS: assets, ALLOWED_TELEMETRY_KEYS: ALLOWED_KEY },
  );
  expect(badJson.status).toBe(400);

  const emptyBatch = await worker.fetch(
    new Request("https://dohc.computer/telemetry/batch/", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ api_key: ALLOWED_KEY, batch: [] }),
    }),
    { ASSETS: assets, ALLOWED_TELEMETRY_KEYS: ALLOWED_KEY },
  );
  expect(emptyBatch.status).toBe(400);
  expect(await emptyBatch.text()).toContain("1 to 200 events (got 0 events)");

  const oversized = await worker.fetch(
    new Request("https://dohc.computer/telemetry/batch/", {
      method: "POST",
      headers: jsonHeaders,
      body: "a".repeat(1_048_577),
    }),
    { ASSETS: assets, ALLOWED_TELEMETRY_KEYS: ALLOWED_KEY },
  );
  expect(oversized.status).toBe(413);
  expect(await oversized.text()).toContain("1048576 bytes (got at least 1048577 bytes)");

  const deepNested = await worker.fetch(
    new Request("https://dohc.computer/telemetry/batch/", {
      method: "POST",
      headers: jsonHeaders,
      body: `{"api_key":"${ALLOWED_KEY}","batch":[{"event":"x","properties":{"a":${"[".repeat(64)}1${"]".repeat(64)}}}]}`,
    }),
    { ASSETS: assets, ALLOWED_TELEMETRY_KEYS: ALLOWED_KEY },
  );
  expect(deepNested.status).toBe(400);
  expect(await deepNested.text()).toContain("32 levels (reached 33 levels)");
  expect(upstream).not.toHaveBeenCalled();
  expect(assets.fetch).not.toHaveBeenCalled();

  const protoBody = `{"api_key":"${ALLOWED_KEY}","batch":[{"event":"app_launched","properties":{"__proto__":{"keep":1},"$ip":"1.2.3.4"}}]}`;
  const protoResponse = await worker.fetch(
    new Request("https://dohc.computer/telemetry/batch/", {
      method: "POST",
      headers: jsonHeaders,
      body: protoBody,
    }),
    { ASSETS: assets, ALLOWED_TELEMETRY_KEYS: ALLOWED_KEY },
  );
  expect(protoResponse.status).toBe(200);
  expect(upstream.mock.calls[0]![1].body).toContain('"__proto__":{"keep":1}');
  expect(upstream.mock.calls[0]![1].body).not.toContain('"$ip"');
});
