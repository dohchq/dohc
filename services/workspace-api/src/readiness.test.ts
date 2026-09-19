import { describe, expect, it } from "vitest";
import { createReadinessProbe, REQUIRED_TABLES, type TableQuery } from "./readiness";

function answering(tables: readonly string[]): TableQuery {
  return {
    async query(_sql, values) {
      const requested = (values[0] as string[]).filter((name) => tables.includes(name));
      return { rows: requested.map((name) => ({ name })) };
    },
  };
}

describe("createReadinessProbe", () => {
  it("is ready when Postgres answers with the whole auth schema", async () => {
    const report = await createReadinessProbe(answering(REQUIRED_TABLES))();
    expect(report).toEqual({ ok: true, database: "ok", schema: "ok", missingTables: [] });
  });

  it("is not ready until account email is configured", async () => {
    const report = await createReadinessProbe(answering(REQUIRED_TABLES), { emailConfigured: false })();
    expect(report).toMatchObject({ ok: false, database: "ok", detail: "Configure SMTP for account email." });
  });

  it("names the tables a migration has not created yet", async () => {
    const report = await createReadinessProbe(
      answering(REQUIRED_TABLES.filter((table) => table !== "deviceCode")),
    )();
    expect(report.ok).toBe(false);
    expect(report.schema).toBe("incomplete");
    expect(report.missingTables).toEqual(["deviceCode"]);
    expect(report.detail).toMatch(/pnpm migrate/);
  });

  it("reports an unreachable database", async () => {
    const report = await createReadinessProbe({
      query: () => Promise.reject(new Error("ECONNREFUSED 127.0.0.1:54329")),
    })();
    expect(report).toMatchObject({
      ok: false,
      database: "unreachable",
      schema: "unknown",
      detail: "The account database is unavailable.",
    });
  });

  it("gives up on a database that never answers", async () => {
    const report = await createReadinessProbe({ query: () => new Promise(() => {}) }, { timeoutMs: 5 })();
    expect(report.database).toBe("unreachable");
    expect(report.detail).toBe("The account database is unavailable.");
  });
});
