import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CRASH_REPORT_MAX_BYTES,
  CRASH_REPORT_PATH,
  CRASH_REPORTS_PER_CLIENT_PER_HOUR,
  CRASH_REPORTS_PER_HOUR,
  clientKey,
  createCrashReportIntake,
  type CrashReportStore,
  type StoredCrashReport,
} from "./crashReports";

const REPORT = [
  "dohc crash report",
  "",
  "Time: 2026-09-25T10:00:00.000Z",
  "Process: workspace engine",
  "Version: 0.9.0 (latest)",
  "Error: EngineDaemonUnavailableError: Rust engine daemon exited unexpectedly with code 1.",
].join("\n");

function memoryStore(options: { full?: boolean; fail?: boolean } = {}) {
  const rows: StoredCrashReport[] = [];
  const store: CrashReportStore = {
    async insert(report) {
      if (options.fail) throw new Error("the database went away");
      if (options.full) return false;
      rows.push(report);
      return true;
    },
    async deleteExpired() {
      return 0;
    },
  };
  return { rows, store };
}

function post(body: BodyInit | null, headers: Record<string, string> = {}): Request {
  return new Request(`https://api.example.test${CRASH_REPORT_PATH}`, {
    method: "POST",
    headers: { "content-type": "text/plain; charset=utf-8", "x-dohc-auth-client-ip": "203.0.113.7", ...headers },
    body,
  });
}

afterEach(() => vi.restoreAllMocks());

describe("crash report intake", () => {
  it("stores the report with its version and answers with an id", async () => {
    const { rows, store } = memoryStore();
    const answer = await createCrashReportIntake({ store })(post(REPORT));
    expect(answer.status).toBe(201);
    expect(answer.body).toEqual({ ok: true, id: rows[0]!.id });
    expect(rows).toEqual([{ id: expect.any(String), appVersion: "0.9.0", body: REPORT }]);
  });

  it("refuses what is not a dohc crash report, and stores nothing", async () => {
    const { rows, store } = memoryStore();
    const intake = createCrashReportIntake({ store });
    const cases: [Request, number][] = [
      [post(REPORT, { "content-type": "application/json" }), 415],
      [post(REPORT, { "content-type": "text/plain; charset=latin1" }), 415],
      [post(REPORT, { origin: "https://example.test" }), 403],
      [post("hello"), 400],
      [post(`${REPORT}\u0000`), 400],
      [post(new Uint8Array([...new TextEncoder().encode(REPORT), 0xff])), 400],
      [post(null), 400],
      [post(REPORT, { "content-length": String(CRASH_REPORT_MAX_BYTES + 1) }), 413],
      [post(`${REPORT}\n${"x".repeat(CRASH_REPORT_MAX_BYTES)}`), 413],
    ];
    for (const [request, status] of cases) {
      expect((await intake(request)).status).toBe(status);
    }
    expect(rows).toEqual([]);
  });

  it("accepts a report of the largest size the desktop can make", async () => {
    const { rows, store } = memoryStore();
    // 32,768 UTF-16 code units, each three bytes of UTF-8.
    const body = `${REPORT}\n`.padEnd(32_768, "€");
    expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(CRASH_REPORT_MAX_BYTES);
    expect((await createCrashReportIntake({ store })(post(body))).status).toBe(201);
    expect(rows).toHaveLength(1);
  });

  it("limits each address per hour, and lets it send again an hour later", async () => {
    let now = 1_000_000;
    const { rows, store } = memoryStore();
    const intake = createCrashReportIntake({ store, nowMs: () => now });
    for (let index = 0; index < CRASH_REPORTS_PER_CLIENT_PER_HOUR; index += 1) {
      expect((await intake(post(REPORT))).status).toBe(201);
    }
    const refused = await intake(post(REPORT));
    expect(refused.status).toBe(429);
    expect(refused.headers?.["retry-after"]).toBe("3600");
    // Another address is not held back.
    expect((await intake(post(REPORT, { "x-dohc-auth-client-ip": "203.0.113.8" }))).status).toBe(201);

    now += 60 * 60 * 1000;
    expect((await intake(post(REPORT))).status).toBe(201);
    expect(rows).toHaveLength(CRASH_REPORTS_PER_CLIENT_PER_HOUR + 2);
  });

  it("limits the whole server per hour", async () => {
    const { store } = memoryStore();
    const intake = createCrashReportIntake({ store, nowMs: () => 5_000 });
    for (let index = 0; index < CRASH_REPORTS_PER_HOUR; index += 1) {
      const address = `198.51.${Math.floor(index / 250)}.${index % 250}`;
      expect((await intake(post(REPORT, { "x-dohc-auth-client-ip": address }))).status).toBe(201);
    }
    const refused = await intake(post(REPORT, { "x-dohc-auth-client-ip": "192.0.2.1" }));
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({ ok: false, error: "this server is taking no more crash reports this hour" });
  });

  it("counts one IPv6 /64 as one address", async () => {
    const { store } = memoryStore();
    const intake = createCrashReportIntake({ store });
    for (let index = 0; index < CRASH_REPORTS_PER_CLIENT_PER_HOUR; index += 1) {
      const address = `2001:db8:1:2::${(index + 1).toString(16)}`;
      expect((await intake(post(REPORT, { "x-dohc-auth-client-ip": address }))).status).toBe(201);
    }
    expect((await intake(post(REPORT, { "x-dohc-auth-client-ip": "2001:db8:1:2:ffff::9" }))).status).toBe(429);
    expect((await intake(post(REPORT, { "x-dohc-auth-client-ip": "2001:db8:1:3::1" }))).status).toBe(201);
  });

  it("answers 503 when storage is full", async () => {
    const { store } = memoryStore({ full: true });
    const answer = await createCrashReportIntake({ store })(post(REPORT));
    expect(answer).toEqual({ status: 503, body: { ok: false, error: "this server's crash report storage is full" } });
  });
});

describe("crash report client key", () => {
  it("keeps an IPv4 address and groups IPv6 by /64", () => {
    expect(clientKey("203.0.113.7")).toBe("203.0.113.7");
    expect(clientKey("2001:db8::1")).toBe("2001:0db8:0000:0000::/64");
    expect(clientKey("2001:db8:1:2:3:4:5:6")).toBe("2001:0db8:0001:0002::/64");
    expect(clientKey("::1")).toBe("0000:0000:0000:0000::/64");
    expect(clientKey(null)).toBe("unknown");
  });
});
