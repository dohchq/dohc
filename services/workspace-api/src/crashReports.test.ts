import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { toNodeHandler } from "better-auth/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CRASH_REPORT_MAX_BYTES,
  CRASH_REPORT_PATH,
  CRASH_REPORTS_PER_CLIENT_PER_HOUR,
  CRASH_REPORTS_PER_HOUR,
  clientKey,
  createCrashReportIntake,
  createPostgresCrashReportStore,
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

  it("counts one IPv6 /48 as one address", async () => {
    const { store } = memoryStore();
    const intake = createCrashReportIntake({ store });
    for (let index = 0; index < CRASH_REPORTS_PER_CLIENT_PER_HOUR; index += 1) {
      const address = `2001:db8:1:${(index + 1).toString(16)}::1`;
      expect((await intake(post(REPORT, { "x-dohc-auth-client-ip": address }))).status).toBe(201);
    }
    expect((await intake(post(REPORT, { "x-dohc-auth-client-ip": "2001:db8:1:ffff::9" }))).status).toBe(429);
    expect((await intake(post(REPORT, { "x-dohc-auth-client-ip": "2001:db8:2::1" }))).status).toBe(201);
  });

  it("refuses a limited address before reading its body", async () => {
    const { store } = memoryStore();
    const intake = createCrashReportIntake({ store });
    for (let index = 0; index < CRASH_REPORTS_PER_CLIENT_PER_HOUR; index += 1) {
      expect((await intake(post(REPORT))).status).toBe(201);
    }
    let pulled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled = true;
        controller.enqueue(new TextEncoder().encode(REPORT));
        controller.close();
      },
    }, { highWaterMark: 0 });
    const request = new Request(`https://api.example.test${CRASH_REPORT_PATH}`, {
      method: "POST",
      headers: { "content-type": "text/plain; charset=utf-8", "x-dohc-auth-client-ip": "203.0.113.7" },
      body,
      duplex: "half",
    } as RequestInit);
    expect((await intake(request)).status).toBe(429);
    expect(pulled).toBe(false);
  });

  it("answers an oversized upload with 413 and closes the connection, instead of resetting it", async () => {
    const { rows, store } = memoryStore();
    const intake = createCrashReportIntake({ store });
    const handler = toNodeHandler(async (request: Request) => {
      const answer = await intake(request);
      return Response.json(answer.body, { status: answer.status, headers: answer.headers ?? {} });
    });
    const server = createServer((request, response) => {
      request.headers["x-dohc-auth-client-ip"] = "203.0.113.9";
      void handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const chunk = new TextEncoder().encode(`${REPORT}\n${"x".repeat(16 * 1024)}`);
      let sent = 0;
      // Sent in chunks with no length, so only reading finds the size.
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= 2 * CRASH_REPORT_MAX_BYTES) return controller.close();
          sent += chunk.byteLength;
          controller.enqueue(chunk);
        },
      });
      const response = await fetch(`http://127.0.0.1:${port}${CRASH_REPORT_PATH}`, {
        method: "POST", body, duplex: "half",
        headers: { "content-type": "text/plain; charset=utf-8" },
      } as RequestInit);
      expect(response.status).toBe(413);
      expect(response.headers.get("connection")).toBe("close");
      expect(rows).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("answers 503 when storage is full", async () => {
    const { store } = memoryStore({ full: true });
    const answer = await createCrashReportIntake({ store })(post(REPORT));
    expect(answer).toEqual({ status: 503, body: { ok: false, error: "this server's crash report storage is full" } });
  });
});

describe("expired crash reports", () => {
  it("deletes in batches until none are left", async () => {
    const counts = [500, 500, 3, 0];
    const queries: unknown[][] = [];
    const store = createPostgresCrashReportStore({
      query: async (_sql, values) => {
        queries.push(values);
        return { rowCount: counts.shift() ?? 0 };
      },
    });
    expect(await store.deleteExpired()).toBe(1_003);
    expect(queries).toEqual(Array(4).fill([90, 500]));
  });
});

describe("crash report client key", () => {
  it("keeps an IPv4 address and groups IPv6 by /48", () => {
    expect(clientKey("203.0.113.7")).toBe("203.0.113.7");
    expect(clientKey("2001:db8::1")).toBe("2001:0db8:0000::/48");
    expect(clientKey("2001:db8:1:2:3:4:5:6")).toBe("2001:0db8:0001::/48");
    expect(clientKey("::1")).toBe("0000:0000:0000::/48");
    expect(clientKey(null)).toBe("unknown");
  });
});
