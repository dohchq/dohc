import { randomUUID } from "node:crypto";

// Crash reports a person chose to send from the desktop app. The desktop shows
// the whole report and sends it only after the person confirms, so this route
// takes no account and stores only the text it was sent. It never logs a
// report: the person read it before sending, and nobody else should.

export const CRASH_REPORT_PATH = "/api/crash-reports";
// Every report starts with this line (the desktop's crashReportText).
export const CRASH_REPORT_HEADER = "dohc crash report";
// The desktop caps a report at 32,768 UTF-16 code units, which is at most
// 96 KiB of UTF-8.
export const CRASH_REPORT_MAX_BYTES = 96 * 1024;
export const CRASH_REPORTS_PER_CLIENT_PER_HOUR = 10;
export const CRASH_REPORTS_PER_HOUR = 1_000;
// At most about 4.6 GiB at the largest report size, and far less in
// practice: a real report is a few KiB.
export const CRASH_REPORTS_STORED_MAX = 50_000;
export const CRASH_REPORT_RETENTION_DAYS = 90;
// At most about 47 MiB of reports per delete statement.
const CRASH_REPORT_DELETE_BATCH = 500;
const HOUR_MS = 60 * 60 * 1000;

export interface StoredCrashReport {
  id: string;
  // Read from the report's "Version:" line, so reports can be grouped
  // without reading every body.
  appVersion: string | null;
  body: string;
}

export interface CrashReportStore {
  // False when storage already holds CRASH_REPORTS_STORED_MAX reports.
  insert(report: StoredCrashReport): Promise<boolean>;
  // Deletes reports older than the retention period and returns the count.
  deleteExpired(): Promise<number>;
}

interface CrashReportQuery {
  query(sql: string, values: unknown[]): Promise<{ rowCount: number | null }>;
}

/** The slice of `pg.Pool` the store uses. */
export interface CrashReportPool extends CrashReportQuery {
  connect(): Promise<CrashReportQuery & { release(): void }>;
}

export function createPostgresCrashReportStore(
  pool: CrashReportPool,
  storedMax = CRASH_REPORTS_STORED_MAX,
  deleteBatch = CRASH_REPORT_DELETE_BATCH,
): CrashReportStore {
  return {
    // One insert at a time holds the lock from before the count until its
    // commit, so two requests can never both see room for one more report.
    // Each statement reads a fresh snapshot, so the count sees every report
    // committed before the lock was granted.
    async insert(report) {
      const client = await pool.connect();
      try {
        await client.query("begin", []);
        try {
          await client.query("select pg_advisory_xact_lock(hashtext('crash_reports'))", []);
          const result = await client.query(
            `insert into crash_reports (id, app_version, body)
             select $1, $2, $3
             where (select count(*) from crash_reports) < $4`,
            [report.id, report.appVersion, report.body, storedMax],
          );
          await client.query("commit", []);
          return result.rowCount === 1;
        } catch (error) {
          await client.query("rollback", []).catch(() => undefined);
          throw error;
        }
      } finally {
        client.release();
      }
    },
    // In batches, so each statement stays within the pool's statement
    // timeout even after a long outage, and every batch that ends is kept.
    async deleteExpired() {
      let total = 0;
      for (;;) {
        const result = await pool.query(
          `delete from crash_reports where id in (
             select id from crash_reports
             where received_at < now() - make_interval(days => $1)
             limit $2)`,
          [CRASH_REPORT_RETENTION_DAYS, deleteBatch],
        );
        const deleted = result.rowCount ?? 0;
        if (deleted === 0) return total;
        total += deleted;
      }
    },
  };
}

export interface CrashReportAnswer {
  status: number;
  body: { ok: true; id: string } | { ok: false; error: string };
  headers?: Record<string, string>;
}

export type CrashReportIntake = (request: Request) => Promise<CrashReportAnswer>;

/**
 * Checks and stores one report. The client is the x-dohc-auth-client-ip
 * header, which main.ts sets on every request from the socket and this
 * server's trusted proxies, so no caller chooses it. The per-client and
 * overall hourly limits hold only accepted reports, so memory stays within
 * CRASH_REPORTS_PER_HOUR entries.
 */
export function createCrashReportIntake(deps: {
  store: CrashReportStore;
  nowMs?: () => number;
}): CrashReportIntake {
  const nowMs = deps.nowMs ?? Date.now;
  // Accepted reports in the last hour, oldest first, and a count per client.
  const accepted: { atMs: number; client: string }[] = [];
  const perClient = new Map<string, number>();

  function prune(now: number): void {
    while (accepted.length > 0 && accepted[0]!.atMs <= now - HOUR_MS) {
      const { client } = accepted.shift()!;
      const count = (perClient.get(client) ?? 1) - 1;
      if (count === 0) perClient.delete(client);
      else perClient.set(client, count);
    }
  }

  // Seconds until the oldest entry that blocks this client leaves the window.
  function retryAfter(now: number, client: string | null): string {
    const oldest = client === null ? accepted[0] : accepted.find((entry) => entry.client === client);
    return String(Math.max(1, Math.ceil(((oldest?.atMs ?? now) + HOUR_MS - now) / 1000)));
  }

  function limited(client: string): CrashReportAnswer | null {
    const now = nowMs();
    prune(now);
    if ((perClient.get(client) ?? 0) >= CRASH_REPORTS_PER_CLIENT_PER_HOUR) {
      return refuse(429, "too many crash reports from this address", { "retry-after": retryAfter(now, client) });
    }
    if (accepted.length >= CRASH_REPORTS_PER_HOUR) {
      return refuse(429, "this server is taking no more crash reports this hour", { "retry-after": retryAfter(now, null) });
    }
    return null;
  }

  return async (request) => {
    // The desktop posts from its main process, which sends no Origin. A
    // browser always does, so a web page cannot make its visitors post.
    if (request.headers.get("origin") !== null) return refuse(403, "browsers cannot send crash reports");
    if (!isPlainText(request.headers.get("content-type"))) {
      return refuse(415, "send the report as text/plain; charset=utf-8");
    }
    // A limited client is refused before its body is read.
    const client = clientKey(request.headers.get("x-dohc-auth-client-ip"));
    const early = limited(client);
    if (early) return early;
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > CRASH_REPORT_MAX_BYTES) return tooLarge();
    const bytes = await readAtMost(request, CRASH_REPORT_MAX_BYTES);
    if (bytes === "too-large") return tooLarge();
    let body: string;
    try {
      body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return refuse(400, "the report is not a dohc crash report");
    }
    // Postgres text cannot hold NUL, and a report never has control
    // characters other than tabs and line breaks.
    if (!body.startsWith(CRASH_REPORT_HEADER) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body)) {
      return refuse(400, "the report is not a dohc crash report");
    }

    // Checked again with the count, in one step, because other requests can
    // be counted while this body is read.
    const late = limited(client);
    if (late) return late;
    accepted.push({ atMs: nowMs(), client });
    perClient.set(client, (perClient.get(client) ?? 0) + 1);

    const id = randomUUID();
    const stored = await deps.store.insert({ id, appVersion: appVersion(body), body });
    if (!stored) return refuse(503, "this server's crash report storage is full");
    return { status: 201, body: { ok: true, id } };
  };
}

function refuse(status: number, error: string, headers?: Record<string, string>): CrashReportAnswer {
  return { status, body: { ok: false, error }, ...(headers ? { headers } : {}) };
}

// The rest of the body stays unread. Node sends this answer, then closes
// the connection instead of reading on. Cancelling the body would reset the
// connection before the client saw the answer.
function tooLarge(): CrashReportAnswer {
  return refuse(413, "the report is too large", { connection: "close" });
}

function isPlainText(value: string | null): boolean {
  if (value === null) return false;
  const [type, ...parameters] = value.split(";").map((part) => part.trim().toLowerCase());
  if (type !== "text/plain") return false;
  return parameters.every((parameter) => !parameter.startsWith("charset=") || parameter === "charset=utf-8");
}

async function readAtMost(request: Request, maxBytes: number): Promise<Uint8Array | "too-large"> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      reader.releaseLock();
      return "too-large";
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function appVersion(body: string): string | null {
  return /^Version: ([^\s(]{1,64})/m.exec(body)?.[1] ?? null;
}

/**
 * The key a client's reports count against: an IPv4 address, or the /48 an
 * IPv6 address belongs to. One home connection is commonly given a /56 or
 * more, which holds 256 /64s.
 */
export function clientKey(address: string | null): string {
  if (!address) return "unknown";
  if (!address.includes(":")) return address;
  const [head = "", tail] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined
    ? left
    : [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return `${groups.slice(0, 3).map((group) => group.padStart(4, "0")).join(":")}::/48`;
}
