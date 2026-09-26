// Liveness answers "this process runs". Readiness answers "this process can
// serve accounts", which means Postgres answers AND carries the Better Auth
// schema. A proxy that routes sign-ins at a database with no tables turns
// every account action into a 500, so readiness checks both.

/** Every table the auth surface reads. Created by migration 0001_better_auth. */
export const REQUIRED_TABLES = [
  "user",
  "session",
  "account",
  "verification",
  "organization",
  "member",
  "invitation",
  "deviceCode",
] as const;

export interface ReadinessReport {
  ok: boolean;
  database: "ok" | "unreachable";
  schema: "ok" | "incomplete" | "unknown";
  missingTables: string[];
  /** One line naming what failed, for the operator reading the response. */
  detail?: string;
}

/** The narrow slice of `pg.Pool` this probe needs. */
export interface TableQuery {
  query(sql: string, values: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

// quote_ident keeps the mixed-case "deviceCode" from folding to lower case.
const PRESENT_TABLES =
  'select t.name from unnest($1::text[]) as t(name) where to_regclass(quote_ident(t.name)) is not null';

/** The table crash reports go to, when they are on. Created by migration 0003_crash_reports. */
export const CRASH_REPORT_TABLE = "crash_reports";

export function createReadinessProbe(
  client: TableQuery,
  options: { timeoutMs?: number; emailConfigured?: boolean; crashReports?: boolean } = {},
): () => Promise<ReadinessReport> {
  const timeoutMs = options.timeoutMs ?? 3000;
  const tables: string[] = [...REQUIRED_TABLES, ...(options.crashReports ? [CRASH_REPORT_TABLE] : [])];
  let pending: ReturnType<TableQuery["query"]> | undefined;
  return async () => {
    let rows: Array<Record<string, unknown>>;
    try {
      // Keep one probe until the database settles, even after an HTTP timeout.
      pending ??= client.query(PRESENT_TABLES, [tables]).finally(() => { pending = undefined; });
      rows = (await withTimeout(pending, timeoutMs)).rows;
    } catch {
      return {
        ok: false,
        database: "unreachable",
        schema: "unknown",
        missingTables: [],
        detail: "The account database is unavailable.",
      };
    }
    const present = new Set(rows.map((row) => String(row.name)));
    const missingTables = tables.filter((table) => !present.has(table));
    if (missingTables.length > 0) {
      return {
        ok: false,
        database: "ok",
        schema: "incomplete",
        missingTables,
        detail: "Apply the Postgres migrations with `pnpm migrate`.",
      };
    }
    if (options.emailConfigured === false) {
      return { ok: false, database: "ok", schema: "ok", missingTables: [], detail: "Configure SMTP for account email." };
    }
    return { ok: true, database: "ok", schema: "ok", missingTables: [] };
  };
}

function withTimeout<Result>(work: Promise<Result>, timeoutMs: number): Promise<Result> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Postgres did not answer in ${timeoutMs}ms.`)),
      timeoutMs,
    );
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
