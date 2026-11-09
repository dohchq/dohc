import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { toNodeHandler } from "better-auth/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CRASH_REPORT_DRAIN_MAX_BYTES,
  CRASH_REPORT_DRAIN_MAX_MS,
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

function streamPost(body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}): Request {
  return new Request(`https://api.example.test${CRASH_REPORT_PATH}`, {
    method: "POST",
    headers: { "content-type": "text/plain; charset=utf-8", "x-dohc-auth-client-ip": "203.0.113.7", ...headers },
    body,
    duplex: "half",
  } as RequestInit);
}

// Sends `size` bytes in 16 KiB chunks, or without end when `size` is
// Infinity, and counts what the server read.
function upload(size: number) {
  const counted = { pulled: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (counted.pulled >= size) return controller.close();
      const chunk = new Uint8Array(Math.min(16 * 1024, size - counted.pulled));
      counted.pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
  }, { highWaterMark: 0 });
  return { body, counted };
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

  it("reads a declared oversized upload to its end before answering 413, unless it is past the drain limit", async () => {
    const { rows, store } = memoryStore();
    const intake = createCrashReportIntake({ store });
    const within = upload(2 * CRASH_REPORT_MAX_BYTES);
    const answer = await intake(streamPost(within.body, { "content-length": String(2 * CRASH_REPORT_MAX_BYTES) }));
    expect(answer).toEqual({ status: 413, body: { ok: false, error: "the report is too large" }, headers: { connection: "close" } });
    expect(within.counted.pulled).toBe(2 * CRASH_REPORT_MAX_BYTES);

    const past = upload(CRASH_REPORT_DRAIN_MAX_BYTES + 1);
    const refused = await intake(streamPost(past.body, { "content-length": String(CRASH_REPORT_DRAIN_MAX_BYTES + 1) }));
    expect(refused.status).toBe(413);
    expect(past.counted.pulled).toBe(0);
    expect(rows).toEqual([]);
  });

  it("stops reading an oversized upload past the drain limit", async () => {
    const { store } = memoryStore();
    const endless = upload(Infinity);
    expect((await createCrashReportIntake({ store })(streamPost(endless.body))).status).toBe(413);
    // It starts no read once it has the limit, so it stops within the chunk that reaches it.
    expect(endless.counted.pulled).toBeGreaterThanOrEqual(CRASH_REPORT_DRAIN_MAX_BYTES);
    expect(endless.counted.pulled).toBeLessThan(CRASH_REPORT_DRAIN_MAX_BYTES + 16 * 1024);
  });

  it("answers 413 and closes a stalled oversized upload when the drain runs out of time", async () => {
    const { rows, store } = memoryStore();
    const intake = createCrashReportIntake({ store, drainMaxMs: 50 });
    const handler = toNodeHandler(async (request: Request) => {
      const answer = await intake(request);
      return Response.json(answer.body, { status: answer.status, headers: answer.headers ?? {} });
    });
    const server = createServer((request, response) => {
      request.headers["x-dohc-auth-client-ip"] = "203.0.113.10";
      void handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    let client: Socket | undefined;
    try {
      const { port } = server.address() as AddressInfo;
      const socket = connect(port, "127.0.0.1");
      client = socket;
      let answer = "";
      socket.setEncoding("latin1");
      socket.on("data", (text: string) => { answer += text; });
      const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
      // Past the size limit, then a few bytes more, then nothing and no end.
      const over = CRASH_REPORT_MAX_BYTES + 1;
      const started = Date.now();
      socket.write(`POST ${CRASH_REPORT_PATH} HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-type: text/plain; charset=utf-8\r\ntransfer-encoding: chunked\r\n\r\n`);
      socket.write(`${over.toString(16)}\r\n${"x".repeat(over)}\r\n3\r\nabc\r\n`);
      await closed;
      // The drain's 50 ms, with room for a loaded machine. A drain that kept
      // the default 10 s fails here, and one with no time limit would hold the
      // connection until Node's request timeout, past this test's own.
      expect(Date.now() - started).toBeLessThan(CRASH_REPORT_DRAIN_MAX_MS / 2);
      expect(answer).toMatch(/^HTTP\/1\.1 413 /);
      expect(answer.toLowerCase()).toContain("\r\nconnection: close\r\n");
      expect(rows).toEqual([]);
    } finally {
      client?.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("caps a report at the desktop's limit, so the desktop never gets a 413", () => {
    const desktop = readFileSync(new URL("../../../apps/desktop/src/ipc/bridgeContract.ts", import.meta.url), "utf8");
    const chars = /export const CRASH_REPORT_MAX_CHARS = ([\d_]+);/.exec(desktop)?.[1];
    expect(chars).toBeDefined();
    // The desktop counts UTF-16 code units, and each is at most three bytes of UTF-8.
    expect(Number(chars!.replaceAll("_", "")) * 3).toBe(CRASH_REPORT_MAX_BYTES);
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
      connect: async () => { throw new Error("delete takes no transaction"); },
    });
    expect(await store.deleteExpired()).toBe(1_003);
    expect(queries).toEqual(Array(4).fill([90, 500]));
  });
});

describe("storing a crash report", () => {
  function fakePool(failOn?: RegExp) {
    const statements: string[] = [];
    let released = 0;
    const client = {
      query: async (sql: string) => {
        statements.push(sql.replace(/\s+/g, " ").trim().split(" ").slice(0, 2).join(" "));
        if (failOn?.test(sql)) throw new Error("the database went away");
        return { rowCount: 1 };
      },
      release: () => { released += 1; },
    };
    const pool = {
      query: async () => { throw new Error("insert must use one connection"); },
      connect: async () => client,
    };
    return { pool, statements, released: () => released };
  }

  it("takes the lock before the count, inside one transaction", async () => {
    const { pool, statements, released } = fakePool();
    const stored = await createPostgresCrashReportStore(pool).insert({ id: "r", appVersion: null, body: REPORT });
    expect(stored).toBe(true);
    expect(statements).toEqual(["begin", "select pg_advisory_xact_lock(hashtext('crash_reports'))", "insert into", "commit"]);
    expect(released()).toBe(1);
  });

  it("rolls back and releases the connection when the insert fails", async () => {
    const { pool, statements, released } = fakePool(/^\s*insert/);
    await expect(createPostgresCrashReportStore(pool).insert({ id: "r", appVersion: null, body: REPORT }))
      .rejects.toThrow("the database went away");
    expect(statements.at(-1)).toBe("rollback");
    expect(released()).toBe(1);
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
