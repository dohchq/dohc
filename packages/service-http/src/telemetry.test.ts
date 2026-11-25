import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AnalyticsConfigError,
  createServiceAnalyticsClient,
  posthogProject,
  rateLimitMs,
  readAnalyticsEnvConfig,
} from "./telemetry";

afterEach(() => {
  vi.useRealTimers();
});

describe("posthogProject and readAnalyticsEnvConfig", () => {
  it("returns null when both analytics env vars are unset or blank", () => {
    expect(readAnalyticsEnvConfig({})).toBeNull();
    expect(
      readAnalyticsEnvConfig({ DOHC_ANALYTICS_KEY: "  ", DOHC_ANALYTICS_HOST: "" }),
    ).toBeNull();
  });

  it("throws when partially configured or malformed", () => {
    expect(() => readAnalyticsEnvConfig({ DOHC_ANALYTICS_KEY: "phc_1234567890" })).toThrow(
      AnalyticsConfigError,
    );
    expect(() =>
      readAnalyticsEnvConfig({ DOHC_ANALYTICS_HOST: "https://dohc.computer/telemetry" }),
    ).toThrow(AnalyticsConfigError);
    expect(() =>
      readAnalyticsEnvConfig({
        DOHC_ANALYTICS_KEY: "bad-key",
        DOHC_ANALYTICS_HOST: "https://dohc.computer/telemetry",
      }),
    ).toThrow(AnalyticsConfigError);
    expect(() =>
      readAnalyticsEnvConfig({
        DOHC_ANALYTICS_KEY: "phc_1234567890",
        DOHC_ANALYTICS_HOST: "http://dohc.computer/telemetry",
      }),
    ).toThrow(AnalyticsConfigError);
    expect(
      posthogProject("phc_1234567890", "https://user:pass@dohc.computer/telemetry"),
    ).toBeNull();
    expect(posthogProject("phc_1234567890", "https://dohc.computer/telemetry?a=1")).toBeNull();
    expect(posthogProject("phc_1234567890", "https://dohc.computer/telemetry#frag")).toBeNull();
    expect(() =>
      readAnalyticsEnvConfig({
        DOHC_ANALYTICS_KEY: "phc_1234567890",
        DOHC_ANALYTICS_HOST: "https://dohc.computer/telemetry?x=1",
      }),
    ).toThrow(AnalyticsConfigError);
  });

  it("resolves valid https batch URLs with or without a trailing slash", () => {
    const config = readAnalyticsEnvConfig({
      DOHC_ANALYTICS_KEY: "phc_driveProject123",
      DOHC_ANALYTICS_HOST: "https://dohc.computer/telemetry/",
    });
    expect(config).toEqual({
      key: "phc_driveProject123",
      url: new URL("https://dohc.computer/telemetry/batch/"),
    });
  });

  it("parses HTTP 429 Retry-After headers with default and maximum caps", () => {
    expect(rateLimitMs({ status: 200, headers: new Headers() })).toBe(0);
    expect(rateLimitMs({ status: 429, headers: new Headers({ "retry-after": "15" }) })).toBe(
      15_000,
    );
    expect(rateLimitMs({ status: 429, headers: new Headers() })).toBe(60_000);
    expect(rateLimitMs({ status: 429, headers: new Headers({ "retry-after": "99999" }) })).toBe(
      3_600_000,
    );
  });
});

describe("createServiceAnalyticsClient", () => {
  const config = {
    url: new URL("https://dohc.computer/telemetry/batch/"),
    key: "phc_driveProject123",
  };

  it("sends unlinkable events with unique distinct_id and uuid per event", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const client = createServiceAnalyticsClient({
      service: "workspace-api",
      config,
      now: () => Date.UTC(2026, 10, 25, 5, 0, 0),
      fetch: vi.fn(async (url, init) => {
        calls.push({
          url: String(url),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return new Response("{}", { status: 200 });
      }),
    });

    client.track("drive_signup_completed");
    client.track("drive_signin_completed", { client_kind: "desktop" });
    await client.flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://dohc.computer/telemetry/batch/");
    expect(calls[0]!.body.api_key).toBe("phc_driveProject123");
    const batch = calls[0]!.body.batch as Array<Record<string, unknown>>;
    expect(batch).toHaveLength(2);
    expect(batch[0]!.distinct_id).not.toBe(batch[1]!.distinct_id);
    expect(batch[0]!.uuid).not.toBe(batch[1]!.uuid);
    expect(batch[0]!.properties).toEqual({
      $process_person_profile: false,
      $geoip_disable: true,
      $lib: "dohc-workspace-api",
      service: "workspace-api",
    });
    expect(batch[1]!.properties).toMatchObject({ client_kind: "desktop" });
  });

  it("retries transient 5xx with the same event uuid and drops permanent 4xx immediately", async () => {
    vi.useFakeTimers();
    let nowMs = 1_000;
    const payloads: Array<Array<{ uuid: string; event: string }>> = [];
    const responses = [
      new Response("down", { status: 503 }),
      new Response("ok", { status: 200 }),
      new Response("bad", { status: 400 }),
    ];
    const client = createServiceAnalyticsClient({
      service: "sync-relay",
      config,
      now: () => nowMs,
      random: () => 0.5,
      flushMs: 100,
      baseBackoffMs: 200,
      fetch: vi.fn(async (_url, init) => {
        const parsed = JSON.parse(String(init?.body)) as {
          batch: Array<{ uuid: string; event: string }>;
        };
        payloads.push(parsed.batch);
        return responses.shift() ?? new Response("ok", { status: 200 });
      }),
    });

    client.track("sync_workspace_activated");
    nowMs += 100;
    await vi.advanceTimersByTimeAsync(100);
    expect(payloads).toHaveLength(1);

    nowMs += 200;
    await vi.advanceTimersByTimeAsync(200);
    expect(payloads).toHaveLength(2);
    expect(payloads[1]![0]!.uuid).toBe(payloads[0]![0]!.uuid);

    client.track("server_automation_ran", { outcome: "succeeded" });
    nowMs += 100;
    await vi.advanceTimersByTimeAsync(100);
    expect(payloads).toHaveLength(3);

    nowMs += 10_000;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(payloads).toHaveLength(3);
    await client.flush();
  });

  it("aborts slow shutdown flushes at the deadline and ignores events after flush", async () => {
    vi.useFakeTimers();
    const aborted = vi.fn();
    const fetchMock = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted();
            reject(new Error("aborted"));
          });
        }),
    );
    const client = createServiceAnalyticsClient({
      service: "share-web",
      config,
      shutdownTimeoutMs: 50,
      fetch: fetchMock,
    });

    client.track("share_link_opened");
    const flushing = client.flush();
    await vi.advanceTimersByTimeAsync(60);
    await flushing;

    expect(aborted).toHaveBeenCalledOnce();
    client.track("share_link_opened");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("retries when a batchSize flush fails while a flushMs timer is already armed", async () => {
    vi.useFakeTimers();
    let nowMs = 10_000;
    const batches: Array<Array<{ event: string }>> = [];
    const responses = [new Response("down", { status: 503 }), new Response("ok", { status: 200 })];
    const client = createServiceAnalyticsClient({
      service: "share-web",
      config,
      now: () => nowMs,
      random: () => 0.5,
      flushMs: 5_000,
      batchSize: 2,
      baseBackoffMs: 200,
      fetch: vi.fn(async (_url, init) => {
        const parsed = JSON.parse(String(init?.body)) as { batch: Array<{ event: string }> };
        batches.push(parsed.batch);
        return responses.shift() ?? new Response("ok", { status: 200 });
      }),
    });

    client.track("share_link_opened");
    client.track("published_app_launched");
    await vi.advanceTimersByTimeAsync(0);
    expect(batches).toHaveLength(1);

    nowMs += 200;
    await vi.advanceTimersByTimeAsync(200);
    expect(batches).toHaveLength(2);
    expect(batches[1]).toHaveLength(2);
    await client.flush();
  });

  it("drops events that exceed the 30-minute retry age before sending after a long 429 pause", async () => {
    vi.useFakeTimers();
    let nowMs = 1_000;
    const fetchMock = vi.fn(
      async () =>
        new Response("slow down", {
          status: 429,
          headers: { "retry-after": "3600" },
        }),
    );
    const client = createServiceAnalyticsClient({
      service: "workspace-api",
      config,
      now: () => nowMs,
      flushMs: 100,
      fetch: fetchMock,
    });

    client.track("drive_signup_completed");
    nowMs += 100;
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    nowMs += 3_600_000;
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await client.flush();
  });

  it("shares one in-flight promise across concurrent flush calls and preserves privacy fields", async () => {
    const received: Array<Record<string, unknown>> = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = createServiceAnalyticsClient({
      service: "sync-relay",
      config,
      fetch: vi.fn(async (_url, init) => {
        const parsed = JSON.parse(String(init?.body)) as { batch: Array<Record<string, unknown>> };
        received.push(...parsed.batch);
        await gate;
        return new Response("{}", { status: 200 });
      }),
    });

    client.track("sync_workspace_activated", {
      $geoip_disable: false,
      $process_person_profile: true,
      service: "spoofed",
    });
    const first = client.flush();
    const second = client.flush();
    expect(second).toBe(first);
    release();
    await second;

    expect(received).toHaveLength(1);
    expect(received[0]!.properties).toEqual({
      $process_person_profile: false,
      $geoip_disable: true,
      $lib: "dohc-sync-relay",
      service: "sync-relay",
    });
  });

  it("retries at backoff even when another event is tracked while the failing batch is in flight", async () => {
    vi.useFakeTimers();
    let nowMs = 10_000;
    const batches: Array<Array<{ event: string }>> = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let call = 0;
    const client = createServiceAnalyticsClient({
      service: "share-web",
      config,
      now: () => nowMs,
      random: () => 0.5,
      flushMs: 5_000,
      batchSize: 2,
      baseBackoffMs: 200,
      fetch: vi.fn(async (_url, init) => {
        call += 1;
        const parsed = JSON.parse(String(init?.body)) as { batch: Array<{ event: string }> };
        batches.push(parsed.batch);
        if (call === 1) {
          await firstGate;
          return new Response("down", { status: 503 });
        }
        return new Response("ok", { status: 200 });
      }),
    });

    client.track("share_link_opened");
    client.track("published_app_launched");
    client.track("share_link_opened");
    releaseFirst();
    await vi.advanceTimersByTimeAsync(0);
    expect(batches).toHaveLength(1);

    nowMs += 200;
    await vi.advanceTimersByTimeAsync(200);
    expect(batches).toHaveLength(3);
    expect(batches[1]).toHaveLength(2);
    expect(batches[2]).toHaveLength(1);
    await client.flush();
  });

  it("never strands draining when the clock ticks across the 30-minute cutoff during drain", async () => {
    vi.useFakeTimers();
    const times = [
      1_000, // track(first)
      1_000 + 30 * 60_000, // drain() entry at cutoff
      1_000 + 30 * 60_000 + 1, // subsequent check past cutoff
      1_000 + 30 * 60_000 + 2, // track(fresh)
    ];
    let lastTime = times[0]!;
    const sent: string[] = [];
    const client = createServiceAnalyticsClient({
      service: "workspace-api",
      config,
      now: () => {
        lastTime = times.shift() ?? lastTime;
        return lastTime;
      },
      flushMs: 100,
      fetch: vi.fn(async (_url, init) => {
        const parsed = JSON.parse(String(init?.body)) as { batch: Array<{ event: string }> };
        sent.push(...parsed.batch.map((item) => item.event));
        return new Response("ok", { status: 200 });
      }),
    });

    client.track("drive_signup_completed");
    await vi.advanceTimersByTimeAsync(100);
    client.track("drive_signin_completed");
    await client.flush();

    expect(sent).toContain("drive_signin_completed");
  });
});
