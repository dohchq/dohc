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

export function createReadinessProbe(
  client: TableQuery,
  options: { timeoutMs?: number; emailConfigured?: boolean } = {},
): () => Promise<ReadinessReport> {
  const timeoutMs = options.timeoutMs ?? 3000;
  let pending: ReturnType<TableQuery["query"]> | undefined;
  return async () => {
    let rows: Array<Record<string, unknown>>;
    try {
      // Keep one probe until the database settles, even after an HTTP timeout.
      pending ??= client.query(PRESENT_TABLES, [[...REQUIRED_TABLES]]).finally(() => { pending = undefined; });
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
    const missingTables = REQUIRED_TABLES.filter((table) => !present.has(table));
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
